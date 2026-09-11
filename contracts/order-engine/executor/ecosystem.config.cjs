/**
 * PM2 ecosystem config for production deployment.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs teraswap-executor
 *   pm2 stop teraswap-executor
 *   pm2 restart teraswap-executor
 *   pm2 save && pm2 startup  (auto-restart on reboot)
 *
 * [FIX-KEEPER-MULTICHAIN-INSTANCE-IDENTITY] TWO apps, one per chain, from this same directory:
 *   teraswap-executor        — Base (8453), env from `.env.executor` (the default; unchanged)
 *   teraswap-keeper-arbitrum — Arbitrum One (42161), env from `.env.executor.arbitrum`
 * Start ONLY the new one on a host already running Base:
 *   pm2 start ecosystem.config.cjs --only teraswap-keeper-arbitrum
 *
 * HOW ENV IS LOADED. Each app's `env` block below is injected by pm2 into the process environment
 * BEFORE node starts — shell env, from the keeper's point of view. executor.js's FIRST import is
 * ./env.js, whose module body reads EXECUTOR_ENV_FILE (already set by then) and loads that file
 * before any later import evaluates, so every module-scope `process.env` read (alert.js,
 * retry-policy.js, deviation-guard.js, the CHAIN_ID parse in executor.js itself) sees the file's
 * values. Shell env wins over the file, which is what pins the ports below regardless of what an
 * env file says. Pinned by env-order.test.mjs (first-import + EXECUTOR_ENV_FILE) and
 * ecosystem.test.mjs (this file's shape).
 *
 * WHAT THIS FILE MAY CARRY. Only what must DIFFER per app on one host — the env-file name, the
 * listening ports, the log files — plus NODE_ENV. Everything identity-bearing (CHAIN_ID, RPC_URL,
 * executor address, KMS_KEY_ID/KMS_REGION, SUPABASE_URL + this consumer's OWN Supabase key) lives
 * in the app's env file, never here: a value typed here is shared by construction and committed to
 * git. The keeper refuses to boot when any of those is missing (no defaults), so an app pointed at
 * an incomplete file fails loudly instead of inheriting the other chain's identity.
 */
const shared = {
  script: 'executor.js',
  interpreter: 'node',
  node_args: '--experimental-vm-modules',
  instances: 1,                 // Single instance (prevent duplicate execution)
  autorestart: true,
  watch: false,
  max_memory_restart: '256M',
  // Logging
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
  merge_logs: true,
  // Restart policy
  restart_delay: 5000,          // 5s delay between restarts
  max_restarts: 50,             // Max restarts before stopping
  min_uptime: 10000,            // Min 10s uptime to be considered stable
}

module.exports = {
  apps: [
    {
      ...shared,
      name: 'teraswap-executor',
      env: {
        NODE_ENV: 'production',
        METRICS_PORT: '9090',     // Prometheus metrics endpoint
        // HEALTH_PORT (3001) and everything else come from .env.executor (EXECUTOR_ENV_FILE unset ⇒ default).
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
    },
    {
      ...shared,
      name: 'teraswap-keeper-arbitrum',
      env: {
        NODE_ENV: 'production',
        EXECUTOR_ENV_FILE: '.env.executor.arbitrum', // its OWN env file — see env.js
        METRICS_PORT: '9091',     // ≠ Base's 9090: same host, one port per process
        HEALTH_PORT: '3002',      // ≠ Base's 3001 (which lives in .env.executor); pinned here so the file cannot collide
      },
      error_file: './logs/arbitrum-error.log',
      out_file: './logs/arbitrum-out.log',
    },
  ],
}
