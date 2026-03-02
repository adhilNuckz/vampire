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
    // ── WhatsApp Bot ──────────────────────────────────────────
    {
      name:          'whatsapp-agent',
      script:        './src/bot/index.js',
      watch:         false,         // set to true during dev if desired
      autorestart:   true,
      restart_delay: 5000,          // wait 5s before restarting on crash
      max_restarts:  20,
      min_uptime:    '10s',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      },
      // Redirect stdout/stderr to log files managed by PM2
      out_file:      './logs/bot-out.log',
      error_file:    './logs/bot-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true
    },

    // ── Web Dashboard ─────────────────────────────────────────
    {
      name:          'agent-dashboard',
      script:        './src/dashboard/index.js',
      watch:         false,
      autorestart:   true,
      restart_delay: 3000,
      max_restarts:  20,
      min_uptime:    '5s',
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production'
      },
      out_file:      './logs/dashboard-out.log',
      error_file:    './logs/dashboard-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:    true
    }
  ]
};
