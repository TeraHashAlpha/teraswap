/**
 * Register Telegram bot webhook.
 *
 * Calls the Telegram Bot API setWebhook to point the bot at our
 * /api/telegram/webhook endpoint. Idempotent — running twice is safe
 * (setWebhook replaces any previous webhook configuration).
 *
 * Usage:
 *   npm run telegram:setup-webhook
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN         — from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET    — random string for webhook verification
 *
 * Optional:
 *   TELEGRAM_WEBHOOK_URL       — override (default: https://teraswap.app/api/telegram/webhook)
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || 'https://teraswap.app/api/telegram/webhook'

async function main() {
  if (!BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN is not set')
    process.exit(1)
  }
  if (!WEBHOOK_SECRET) {
    console.error('TELEGRAM_WEBHOOK_SECRET is not set')
    process.exit(1)
  }

  console.log(`Setting webhook to: ${WEBHOOK_URL}`)
  console.log(`Secret token: ${WEBHOOK_SECRET.slice(0, 4)}...${WEBHOOK_SECRET.slice(-4)}`)

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
    }),
  })

  const body = await res.json()

  if (body.ok) {
    console.log('Webhook registered successfully.')
    console.log(`Response: ${JSON.stringify(body)}`)
  } else {
    console.error('Webhook registration failed:')
    console.error(JSON.stringify(body, null, 2))
    process.exit(1)
  }

  // Verify by calling getWebhookInfo
  const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`)
  const info = await infoRes.json()
  console.log('\nCurrent webhook info:')
  console.log(`  URL: ${info.result?.url || 'none'}`)
  const urlMatch = info.result?.url === WEBHOOK_URL
  console.log(`  URL matches: ${urlMatch ? 'yes' : 'NO — expected ' + WEBHOOK_URL}`)
  console.log(`  Pending updates: ${info.result?.pending_update_count ?? '?'}`)
  console.log(`  Allowed updates: ${JSON.stringify(info.result?.allowed_updates ?? [])}`)
}

main()
