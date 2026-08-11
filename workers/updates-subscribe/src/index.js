const ALLOWED_ORIGINS = new Set([
  'https://www.0x01.world',
  'https://0x01.world',
  'http://localhost:3000',
  'http://localhost:4173',
])

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000
const RATE_LIMIT_MAX_ATTEMPTS = 5

function corsHeaders(origin) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  })

  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Content-Type')
    headers.set('Access-Control-Max-Age', '86400')
  }

  return headers
}

function response(payload, status, origin) {
  const headers = corsHeaders(origin)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(payload), { status, headers })
}

function isValidEmail(value) {
  return typeof value === 'string'
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

async function hash(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function isRateLimited(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const ipHash = await hash(`0x01-updates:v1:${ip}`)
  const now = Date.now()
  const record = await env.DB
    .prepare('SELECT window_started_at, attempts FROM subscribe_rate_limits WHERE ip_hash = ?')
    .bind(ipHash)
    .first()

  if (!record || now - Number(record.window_started_at) >= RATE_LIMIT_WINDOW_MS) {
    await env.DB
      .prepare(`INSERT INTO subscribe_rate_limits (ip_hash, window_started_at, attempts)
        VALUES (?, ?, 1)
        ON CONFLICT(ip_hash) DO UPDATE SET window_started_at = excluded.window_started_at, attempts = 1`)
      .bind(ipHash, now)
      .run()
    return false
  }

  if (Number(record.attempts) >= RATE_LIMIT_MAX_ATTEMPTS) return true

  await env.DB
    .prepare('UPDATE subscribe_rate_limits SET attempts = attempts + 1 WHERE ip_hash = ?')
    .bind(ipHash)
    .run()
  return false
}

async function syncToResend(env, email) {
  if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) return

  const resendResponse = await fetch('https://api.resend.com/contacts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      unsubscribed: false,
      segments: [{ id: env.RESEND_SEGMENT_ID }],
    }),
  })

  if (!resendResponse.ok) {
    throw new Error(`Resend contact sync failed with ${resendResponse.status}`)
  }

  const contact = await resendResponse.json()
  await env.DB
    .prepare('UPDATE subscribers SET resend_contact_id = ?, resend_synced_at = ? WHERE email = ?')
    .bind(contact.data?.id || null, new Date().toISOString(), email)
    .run()
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || ''
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      if (!ALLOWED_ORIGINS.has(origin)) return response({ error: 'Origin not allowed.' }, 403, origin)
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    if (url.pathname !== '/subscribe' || request.method !== 'POST') {
      return response({ error: 'Not found.' }, 404, origin)
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return response({ error: 'Origin not allowed.' }, 403, origin)
    }

    let body
    try {
      body = await request.json()
    } catch {
      return response({ error: 'Please enter a valid email address.' }, 400, origin)
    }

    // Bots fill a field that people never see. Return success without retaining it.
    if (typeof body.company === 'string' && body.company.trim()) {
      return response({ message: 'You are on the list.' }, 200, origin)
    }

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!isValidEmail(email)) {
      return response({ error: 'Please enter a valid email address.' }, 400, origin)
    }

    if (await isRateLimited(request, env)) {
      return response({ error: 'Please try again tomorrow.' }, 429, origin)
    }

    const now = new Date().toISOString()
    const source = body.source === 'updates' ? 'updates' : 'home'
    await env.DB
      .prepare(`INSERT INTO subscribers (email, status, source, subscribed_at, updated_at, unsubscribed_at)
        VALUES (?, 'subscribed', ?, ?, ?, NULL)
        ON CONFLICT(email) DO UPDATE SET
          status = 'subscribed',
          source = excluded.source,
          subscribed_at = excluded.subscribed_at,
          updated_at = excluded.updated_at,
          unsubscribed_at = NULL`)
      .bind(email, source, now, now)
      .run()

    ctx.waitUntil(
      syncToResend(env, email).catch((error) => {
        console.error('Resend sync failed', { message: error.message })
      }),
    )

    return response({ message: 'You are on the list. The first note will reach you when it is published.' }, 201, origin)
  },
}
