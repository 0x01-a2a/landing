# Telegram setup for 0x01

The Worker supports three controlled flows:

- New newsletter signups send a count/source alert to a private ops chat. Subscriber emails are never sent to Telegram.
- Approved articles can be posted to the public `0x01 Updates` channel through `/internal/telegram/publish`.
- 01Barter listings go to the private ops chat first. A listing is posted publicly only when `approved: true` and `TELEGRAM_MARKET_CHAT_ID` is configured.

## 1. Create the bot

In Telegram, open [@BotFather](https://t.me/BotFather), run `/newbot`, and save the token. Do not commit it or paste it into the website.

## 2. Create chats and add the bot

Create or choose:

1. A public channel for 0x01 updates.
2. A private ops group for signup and listing alerts.
3. Optional: a separate 01Barter market channel, only when you are ready to announce 01Barter.

Add the bot as an administrator. It needs permission to post messages in channels. It does not need access to subscriber email addresses.

## 3. Find chat IDs

For a public channel, add the bot as an administrator, publish one test post, then open this URL in a browser (replace `TOKEN`):

`https://api.telegram.org/botTOKEN/getUpdates`

For a private ops group, add the bot as an administrator and send a command such as `/start` in the group before opening the URL. If the group is not visible in the response, use BotFather’s `/setprivacy` and choose `Disable`, then send another test message. Copy the `chat.id` for the channel/group. Public channels may also use `@channelusername` as the chat ID.

The Worker does not configure a webhook, so `getUpdates` remains available for this setup.

## 4. Add Cloudflare secrets

From the repository root, run:

```sh
cd www/workers/updates-subscribe
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_OPS_CHAT_ID
wrangler secret put TELEGRAM_PUBLIC_CHAT_ID
wrangler secret put SYNC_TOKEN
```

Use a long random value for `SYNC_TOKEN`. It protects the internal publish/listing endpoints. Deploy after setting the secrets:

```sh
wrangler deploy --keep-vars --config wrangler.jsonc
```

Do not set `TELEGRAM_MARKET_CHAT_ID` yet. When 01Barter is publicly announced and its separate market channel exists, add it with `wrangler secret put TELEGRAM_MARKET_CHAT_ID`, then redeploy.

## 5. Publish an article

```sh
curl -X POST https://zerox1-updates-subscribe.guanyidu98.workers.dev/internal/telegram/publish \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "The title of the note",
    "excerpt": "A short useful summary.",
    "url": "https://www.0x01.world/updates/article-slug/"
  }'
```

## 6. Send a listing to review

```sh
curl -X POST https://zerox1-updates-subscribe.guanyidu98.workers.dev/internal/telegram/listing \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Example listing",
    "network": "Base",
    "price": "0.25 ETH",
    "url": "https://barter.0x01.world/listings/example"
  }'
```

To publish a listing to the optional market channel as well, add `"approved": true` after reviewing it. The listing still always goes to ops first.

The Bot API requires HTTPS requests and supports `sendMessage` for channel posts; keep the bot token in Cloudflare secrets. See the [Telegram Bot API](https://core.telegram.org/bots/api).
