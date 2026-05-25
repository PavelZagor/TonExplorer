# Last Changes

Newest first. Append a fresh entry at the top of this file after every significant session. Keep entries tight — one paragraph + a bullet list, no marketing copy.

---

## 2026-05-25 — PM2 + nginx, public dev URL live

TonExplorer now runs under PM2 and is reachable via TLS at `https://your-server.example.com/explorer/`. The same `0:3a14…7c14` PUTIN smoke that worked locally now works end-to-end through nginx.

- Added committed `ecosystem.config.js` at the repo root. Self-locating via `cwd: __dirname`; every runtime knob (PORT, BASE_PATH, TONAPI_KEY, …) is loaded from `.env` inside `src/server.js`. No host-specific path in the committed file. PM2 list saved with `pm2 save`.
- `logs/` is created by the deployment step; PM2 writes `ton-explorer.{out,err}.log` there. Each line is the structured JSON our logger emits (PM2 only adds a `id|name |` prefix during `pm2 logs`, on-disk files stay clean), so we don't set `log_date_format` or every line would be double-stamped.
- Added a `location ^~ /explorer/` block to the dev host's nginx SSL server block, proxying to `127.0.0.1:3031` with `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` set. Backed up the original config before editing, then `nginx -t && systemctl reload nginx`. (Backup placed outside `sites-enabled/` so nginx doesn't try to parse it as a second vhost.)
- `docs/06-deployment.md` updated to describe the committed `ecosystem.config.js` directly instead of the old "make a local `ecosystem.local.config.js`" pattern. Hostname placeholder kept as `your-server.example.com` — real hostname stays only in `.env`.

---

## 2026-05-25 — First mainnet smoke + structured logging

First end-to-end run against TonAPI mainnet (USDt, HMSTR, LUNEXMEME). Smoke surfaced two real defects in the Phase 0 code, both fixed.

- **Deployer derivation was lying.** `src/lib/tonapi.js::getProbableDeployer` was falling back to `event.account.address` (the master itself) when no counterparty could be parsed, so every popular token's "deployer" was its own master address. Rewrote it conservatively: walk every action object's typed sub-tree, return the first non-master address found, AND refuse to claim a deployer at all unless the master's history fits in a single 100-event page (i.e. we've actually reached the start of history). Otherwise return `null` + hint `"history exceeds 100 events — walker required"`. Verified: USDt/HMSTR now correctly return `null`; LUNEXMEME (2 lifetime events) correctly resolves to `0:8247…7c14`.
- **`developers.jettons_count` never incremented.** `upsertJetton` only touched the `jettons` table; the denormalized counters on `developers` stayed at 0 forever. Replaced with on-read aggregation in `getDeveloper` — `jettons_count / rugs_count / alive_count` are now computed via `SELECT COUNT(*) … WHERE deployer = ?` on every fetch, so they can't drift. The denormalized columns remain in the schema (zero-defaulted, harmless) and will be dropped in a later migration.
- **Structured JSON logging.** New `src/lib/logger.js` (zero deps) emits one-line JSON per event with `ts/level/msg/app` + arbitrary fields. Bound an Express middleware that tags every request with a short `req_id` and logs method/path/status/duration_ms on response finish. Replaced every bare `console.*` in `server.js`, `routes/token.js`, `db/index.js`. PM2 / journald can ingest these directly.
- Cleared `data/explorer.sqlite` (it held seed rows from the broken deployer derivation). Will rebuild from real analyses.

---

## 2026-05-25 — First push to GitHub

Translated all UI strings in `views/index.html` and a stale "respond in Russian" line in `CLAUDE.md` to English — the repo is now English-only across all committed artifacts. Added an MIT `LICENSE` file. Initialized git in `/www/crypto/explorer/`, made the initial commit (29 files, 3448 LOC), set up an SSH deploy key (`/root/.ssh/ton-explorer-deploy`, ed25519, write access scoped to this single repo via `Host github-tonexplorer` alias in `~/.ssh/config`), and force-with-lease pushed over the GitHub-auto-generated placeholder commit. Remote `main` now matches local `main` at `b96985e`.

- Public repo live: https://github.com/PavelZagor/TonExplorer
- Confirmed `.env`, `data/`, `node_modules/` are absent from the pushed tree
- Confirmed the dev-server hostname is absent from every committed file
- `git remote -v` uses the SSH alias, not raw `git@github.com`, so future `git push` here uses the deploy key without touching other GitHub auth on this host

---

## 2026-05-25 — Project kickoff

Created the repository skeleton for TonExplorer in `/www/crypto/explorer/`. No on-chain logic yet — this is the foundation Phase 0 from the roadmap.

- Decided stack: Node.js + Express, TonAPI as primary data source, SQLite for the developer registry, vanilla HTML + Tailwind via CDN, public read-only API. Matches the sibling `ton-bot` conventions.
- Wrote project docs: `README.md`, `ROADMAP.md`, `TODO.md`, `CLAUDE.md`, `docs/01-architecture.md` … `docs/06-deployment.md`.
- Wrote `.env.example` covering server config, TonAPI / TonCenter keys, SQLite path, rate-limit knobs, and a placeholder Telegram section for Phase 4.
- `.gitignore` blocks `.env`, `data/`, `logs/`, `node_modules/`, and `*.local.md` (escape hatch for host-specific notes that must stay off GitHub).
- Express skeleton: boots on `PORT` (default 3031), mounts everything under `BASE_PATH` (default `/explorer`), serves `views/index.html`, exposes `/api/health`, `/api/token/:address` (stub), opens SQLite via `better-sqlite3` and runs migrations on boot. Developer/jetton/analysis tables created empty.
- Minimal UI: single input box that calls the API and pretty-prints the JSON response.

Next session: `npm install`, end-to-end smoke against mainnet TonAPI, wire PM2.
