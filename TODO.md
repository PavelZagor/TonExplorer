# TonExplorer — TODO

Active sprint = **Phase 0 (Foundation)** from [`ROADMAP.md`](./ROADMAP.md). Check items off here as they ship; sweep completed items into `LASTCHANGES.md` at session end.

## Right now (Phase 0 — Foundation)

- [x] Project layout (`src/`, `views/`, `docs/`, `data/`)
- [x] `package.json` with deps pinned (`express`, `axios`, `better-sqlite3`, `dotenv`)
- [x] `.env.example` covering every config knob
- [x] `.gitignore` covers `.env`, `data/`, `logs/`, `node_modules/`
- [x] README / ROADMAP / TODO / LASTCHANGES / CLAUDE.md
- [x] `docs/01-architecture.md` … `docs/06-deployment.md`
- [x] Express server skeleton — boots on `PORT`, mounts under `BASE_PATH`, serves `views/index.html`
- [x] `/api/health` returns version + uptime
- [x] TonAPI client wrapper (`src/lib/tonapi.js`) — handles auth header, base URL, simple cache
- [x] `GET /api/token/:address` returns jetton master info via TonAPI
- [x] SQLite open + migration runner; tables: `developers`, `jettons`, `analyses`
- [x] Upsert deployer + jetton on every successful analysis
- [x] Minimal UI: address input, "Analyze" button, JSON dump fallback + a few formatted cards

## Next up (start of Phase 1)

- [x] `npm install` on the dev host and a real end-to-end smoke test against mainnet TonAPI
- [x] Add structured logging (timestamps, request ID) instead of bare `console.log`
- [x] Developer reputation card in UI (already shipped in Phase 0; counters now computed on-read)
- [x] Wire up to PM2 (`ecosystem.config.js` committed — generic, `cwd: __dirname`, all knobs from `.env`)
- [x] nginx vhost snippet documented in `docs/06-deployment.md` (placeholder hostname only); live on the dev host behind TLS via a `location ^~ /explorer/` block
- [ ] Background developer-walker: `node tools/walk-developers.js` paginates `/v2/accounts/.../events` with `before_lt` until the bottom, then upserts every jetton the deployer ever shipped
- [ ] Per-jetton fate classifier v0: `alive | dead | rugged | unknown` based on `last_tx_age`, `holders_count`, `mint_active`
- [ ] Tighten deployer derivation: today we only claim a deployer if the master account has ≤100 lifetime events. Once the walker exists, drop the page-1 limit and reuse the walker's pagination here too.

## Quality-of-life backlog

- [ ] Lightweight test runner (node:test) for `analyzers/*` pure functions
- [ ] OpenAPI schema for `/api/*` — generated, not handwritten
- [ ] Replace in-memory cache with SQLite-backed cache so restarts don't dump hot data
- [ ] Rate-limit middleware (token bucket per IP) — see `RATE_LIMIT_*` envs
- [ ] CORS policy (read-only GET from anywhere; everything else denied)
- [ ] Error envelope standard: `{ ok: false, error: { code, message } }`

## Won't-do (for now, deliberately deferred)

- ❌ User accounts, watchlists in DB — phase 4+
- ❌ Postgres — SQLite is fine until it isn't
- ❌ React / build pipeline — vanilla HTML is faster to iterate on
- ❌ Docker — PM2 + Node directly on the box is consistent with sibling projects
