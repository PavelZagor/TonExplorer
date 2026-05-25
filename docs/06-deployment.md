# 06 — Deployment

Generic deployment notes. Replace `your-server.example.com` with your actual host. Host-specific configuration belongs in `.env` (gitignored), never in this repo.

## Prerequisites

- Node.js ≥ 18.17
- A reverse proxy (nginx) for TLS termination and path mounting
- (optional) PM2 for process management
- (optional) TonAPI key from https://tonconsole.com/ to lift rate limits

## Local dev

```bash
git clone https://github.com/PavelZagor/TonExplorer.git
cd TonExplorer
cp .env.example .env
npm install
npm start
# http://localhost:3031/explorer/
```

## Production with PM2

A committed `ecosystem.config.js` lives at the repo root. It is intentionally generic — `cwd: __dirname` makes it self-locating, and every runtime knob (PORT, BASE_PATH, TONAPI_KEY, …) is read from `.env` via dotenv inside `src/server.js`. So nothing host-specific lives in the committed config.

```bash
pm2 start ecosystem.config.js
pm2 save                      # persist the process list across reboots
pm2 logs ton-explorer         # tail
```

The structured logger built into `src/lib/logger.js` already emits ISO timestamps inside every JSON line, so the PM2 config deliberately omits `log_date_format` — otherwise each line would be double-stamped.

## nginx vhost (sketch)

The server expects to live behind a reverse proxy that mounts it under `BASE_PATH` (default `/explorer`). Example nginx server block (put your own hostname in):

```nginx
server {
    listen 443 ssl http2;
    server_name your-server.example.com;

    # ... your TLS / certs ...

    location /explorer/ {
        proxy_pass         http://127.0.0.1:3031/explorer/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

Notes:
- `proxy_pass` keeps the `/explorer/` prefix because Express mounts everything under `BASE_PATH`. Match what your `.env` says.
- `TRUST_PROXY=loopback` in `.env` so Express trusts `X-Forwarded-For` from nginx running on the same host.
- TLS lives at nginx; the Node process serves plaintext on `127.0.0.1:$PORT` only when proxied. If you bind on `0.0.0.0:$PORT`, firewall the port from the outside.

## Updating

```bash
cd /srv/ton-explorer
git pull
npm install                       # only if package.json changed
pm2 restart ton-explorer
pm2 logs ton-explorer --lines 100 # sanity-check the restart
```

## Backups

`data/explorer.sqlite` is the only stateful file. Back it up however you back up the rest of the box. A simple cron is fine:

```cron
0 4 * * * cp /srv/ton-explorer/data/explorer.sqlite /backups/ton-explorer/$(date +\%F).sqlite
```

## Resetting

To wipe the local registry and start fresh:

```bash
pm2 stop ton-explorer
rm data/explorer.sqlite
pm2 start ton-explorer
```

SQLite schema is recreated on boot by the migration runner.
