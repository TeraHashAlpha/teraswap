/**
 * TeraSwap monitoring scheduler.
 *
 * Triggers every 60 seconds via Cloudflare Cron Trigger and POSTs to the
 * Vercel-hosted /api/monitor/tick endpoint with a shared bearer secret.
 *
 * Independent of Vercel — if Vercel is down, this Worker still runs and
 * the failure is surfaced (non-2xx response logged to Cloudflare tail).
 */

export interface Env {
  TICK_URL: string
  MONITOR_CRON_SECRET: string
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(triggerTick(env))
  },

  // HTTP fetch handler for manual invocation + health check
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/trigger') {
      const auth = request.headers.get('authorization')
      if (auth !== `Bearer ${env.MONITOR_CRON_SECRET}`) {
        return new Response('unauthorized', { status: 401 })
      }
      await triggerTick(env)
      return new Response('triggered', { status: 200 })
    }
    return new Response('teraswap-monitor-tick-cron', { status: 200 })
  },
}

async function triggerTick(env: Env): Promise<void> {
  const started = Date.now()
  try {
    const res = await fetch(env.TICK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.MONITOR_CRON_SECRET}`,
        'Content-Type': 'application/json',
        'User-Agent': 'teraswap-monitor-tick-cron/1.0',
      },
      body: JSON.stringify({ source: 'cloudflare-worker' }),
    })

    const elapsed = Date.now() - started
    if (!res.ok) {
      console.error(`[tick] failed status=${res.status} elapsed=${elapsed}ms body=${await res.text().catch(() => '?')}`)
      return
    }
    console.log(`[tick] ok status=${res.status} elapsed=${elapsed}ms`)
  } catch (err) {
    const elapsed = Date.now() - started
    console.error(`[tick] threw elapsed=${elapsed}ms error=${err instanceof Error ? err.message : String(err)}`)
  }
}
