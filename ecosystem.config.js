/**
 * ecosystem.config.js
 * ─────────────────────────────────────────────────────────────
 * PM2 process manager configuration.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup         ← follow the printed command to enable on reboot
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

module.exports = {
  apps: [
    {
      name: 'vampire',
      script: 'start.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      out_file: './logs/vampire-out.log',
      error_file: './logs/vampire-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};
