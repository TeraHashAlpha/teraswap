/**
 * PM2 ecosystem config for production deployment.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs teraswap-executor
 *   pm2 stop teraswap-executor
 *   pm2 restart teraswap-executor
 *   pm2 save && pm2 startup  (auto-restart on reboot)
 */
module.exports = {
  apps: [
    {
      name: 'teraswap-executor',
      script: 'executor.js',
      interpreter: 'node',
      node_args: '--experimental-vm-modules',
      instances: 1,                 // Single instance (prevent duplicate execution)
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        METRICS_PORT: '9090',     // Prometheus metrics endpoint
      },
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      // Restart policy
      restart_delay: 5000,          // 5s delay between restarts
      max_restarts: 50,             // Max restarts before stopping
      min_uptime: 10000,            // Min 10s uptime to be considered stable
    },
  ],
}
