const ALLOWED_ORIGINS = new Set([
  'https://www.0x01.world',
  'https://0x01.world',
  'http://localhost:3000',
  'http://localhost:4173',
])

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000
const RATE_LIMIT_MAX_ATTEMPTS = 5
const TELEGRAM_MESSAGE_LIMIT = 4096

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

function clip(value, length = TELEGRAM_MESSAGE_LIMIT - 96) {
  const text = String(value || '').trim()
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function safeHttpUrl(value, allowedPrefix) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (allowedPrefix && !url.href.startsWith(allowedPrefix)) return null
    return url.href
  } catch {
    return null
  }
}

async function telegramRequest(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return null

  const telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': '0x01-updates/1.0',
    },
    body: JSON.stringify(payload),
  })

  const result = await telegramResponse.json().catch(() => ({}))
  if (!telegramResponse.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed with ${telegramResponse.status}`)
  }

  return result.result
}

async function sendTelegramMessage(env, chatId, text, options = {}) {
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) return null

  return telegramRequest(env, 'sendMessage', {
    chat_id: chatId,
    text: clip(text),
    parse_mode: 'HTML',
    disable_web_page_preview: options.disableWebPagePreview === true,
    disable_notification: options.disableNotification === true,
  })
}

async function notifyTelegramSignup(env, source, totalSubscribers) {
  if (!env.TELEGRAM_OPS_CHAT_ID) return null

  return sendTelegramMessage(env, env.TELEGRAM_OPS_CHAT_ID, [
    '<b>New 0x01 update signup</b>',
    '',
    `Source: <code>${escapeTelegramHtml(source)}</code>`,
    `Active subscribers: <b>${totalSubscribers}</b>`,
  ].join('\n'), { disableWebPagePreview: true })
}

function requireInternalAuth(request, env) {
  return Boolean(env.SYNC_TOKEN)
    && request.headers.get('Authorization') === `Bearer ${env.SYNC_TOKEN}`
}

async function publishArticleToTelegram(env, body) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_PUBLIC_CHAT_ID) {
    return { error: 'Telegram bot and public channel are not configured.' }
  }

  const title = clip(body.title, 180)
  const excerpt = clip(body.excerpt || body.text, 850)
  const url = safeHttpUrl(body.url, 'https://www.0x01.world/updates/')
  if (!title || !excerpt || !url) {
    return { error: 'Article requires title, excerpt, and an 0x01 Updates URL.' }
  }

  const message = [
    `<b>${escapeTelegramHtml(title)}</b>`,
    '',
    escapeTelegramHtml(excerpt),
    '',
    `<a href="${escapeTelegramHtml(url)}">Read the full note →</a>`,
  ].join('\n')
  const result = await sendTelegramMessage(env, env.TELEGRAM_PUBLIC_CHAT_ID, message)
  return { messageId: result?.message_id || null, chatId: env.TELEGRAM_PUBLIC_CHAT_ID }
}

async function reviewBarterListingOnTelegram(env, body) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OPS_CHAT_ID) {
    return { error: 'Telegram bot and ops chat are not configured.' }
  }

  const name = clip(body.name || body.title, 180)
  const url = safeHttpUrl(body.url)
  if (!name || !url) return { error: 'Listing requires name and an HTTPS URL.' }

  const details = [
    body.network && `Network: <code>${escapeTelegramHtml(clip(body.network, 80))}</code>`,
    body.price && `Price: <code>${escapeTelegramHtml(clip(body.price, 100))}</code>`,
    body.seller && `Seller: <code>${escapeTelegramHtml(clip(body.seller, 120))}</code>`,
  ].filter(Boolean)
  const status = body.approved === true ? 'Approved for public market feed' : 'Needs review'
  const message = [
    '<b>01Barter listing review</b>',
    '',
    `<b>${escapeTelegramHtml(name)}</b>`,
    ...details,
    `Status: <b>${escapeTelegramHtml(status)}</b>`,
    '',
    `<a href="${escapeTelegramHtml(url)}">Open listing</a>`,
  ].join('\n')

  const opsResult = await sendTelegramMessage(env, env.TELEGRAM_OPS_CHAT_ID, message)
  let publicResult = null
  if (body.approved === true && env.TELEGRAM_MARKET_CHAT_ID) {
    publicResult = await sendTelegramMessage(env, env.TELEGRAM_MARKET_CHAT_ID, message)
  }

  return {
    opsMessageId: opsResult?.message_id || null,
    publicMessageId: publicResult?.message_id || null,
    publicPosted: Boolean(publicResult),
  }
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
      'User-Agent': '0x01-updates/1.0',
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
    .bind(contact.data?.id || contact.id || null, new Date().toISOString(), email)
    .run()
}

async function syncPendingSubscribers(env) {
  const pending = await env.DB
    .prepare(`SELECT email FROM subscribers
      WHERE status = 'subscribed' AND resend_synced_at IS NULL
      ORDER BY subscribed_at ASC
      LIMIT 100`)
    .all()

  let synced = 0
  let failed = 0
  for (const subscriber of pending.results) {
    try {
      await syncToResend(env, subscriber.email)
      synced += 1
    } catch (error) {
      failed += 1
      console.error('Resend catch-up sync failed', { message: error.message })
    }
  }

  return { processed: pending.results.length, synced, failed }
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
      if (url.pathname !== '/internal/sync' || request.method !== 'POST') {
        if (!url.pathname.startsWith('/internal/telegram/') || request.method !== 'POST') {
          return response({ error: 'Not found.' }, 404, origin)
        }
      }

      if (!requireInternalAuth(request, env)) {
        return response({ error: 'Not found.' }, 404, origin)
      }

      let body
      try {
        body = await request.json()
      } catch {
        return response({ error: 'Request body must be valid JSON.' }, 400, origin)
      }

      if (url.pathname === '/internal/telegram/publish') {
        try {
          const result = await publishArticleToTelegram(env, body)
          return response(result.error ? result : { ok: true, ...result }, result.error ? 409 : 200, origin)
        } catch (error) {
          console.error('Telegram article publish failed', { message: error.message })
          return response({ error: 'Telegram publish failed.' }, 502, origin)
        }
      }

      if (url.pathname === '/internal/telegram/listing') {
        try {
          const result = await reviewBarterListingOnTelegram(env, body)
          return response(result.error ? result : { ok: true, ...result }, result.error ? 409 : 200, origin)
        } catch (error) {
          console.error('Telegram listing notification failed', { message: error.message })
          return response({ error: 'Telegram listing notification failed.' }, 502, origin)
        }
      }

      if (url.pathname !== '/internal/sync') return response({ error: 'Not found.' }, 404, origin)

      if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) {
        return response({ error: 'Resend is not configured.' }, 409, origin)
      }

      const result = await syncPendingSubscribers(env)
      return response(result, 200, origin)
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

    const existing = await env.DB
      .prepare('SELECT status FROM subscribers WHERE email = ?')
      .bind(email)
      .first()
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

    const notifyNewSignup = !existing || existing.status === 'unsubscribed'
    if (notifyNewSignup && env.TELEGRAM_OPS_CHAT_ID) {
      ctx.waitUntil((async () => {
        const count = await env.DB
          .prepare("SELECT COUNT(*) AS count FROM subscribers WHERE status = 'subscribed'")
          .first()
        await notifyTelegramSignup(env, source, Number(count?.count || 0))
      })().catch((error) => {
        console.error('Telegram signup notification failed', { message: error.message })
      }))
    }

    ctx.waitUntil(
      syncToResend(env, email).catch((error) => {
        console.error('Resend sync failed', { message: error.message })
      }),
    )

    return response({ message: 'You are on the list. The first note will reach you when it is published.' }, 201, origin)
  },
}
