'use strict';

// PM2 process definition for TonExplorer.
//
// This file is intentionally generic — no machine-specific paths, no secrets.
// All runtime config (PORT, BASE_PATH, TONAPI_KEY, ...) is loaded from `.env`
// at process boot via dotenv inside src/server.js.
//
// To run:   pm2 start ecosystem.config.js
// To stop:  pm2 stop ton-explorer
// To tail:  pm2 logs ton-explorer

module.exports = {
  apps: [
    {
      name: 'ton-explorer',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '256M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
      },
      // The app's logger already emits ISO timestamps inside each JSON line;
      // do not set log_date_format here or every line will be double-stamped.
      out_file: './logs/ton-explorer.out.log',
      error_file: './logs/ton-explorer.err.log',
      merge_logs: true,
    },
  ],
};
