# CLAUDE.md

Guidance for Claude Code sessions in `/www/crypto/explorer/` (the TonExplorer project).

## Conventions

- **Language**: this is an English-only project. All committed files — code, comments, docs, UI strings — must be in English. The conversation with the maintainer may happen in any language; the artifacts are English.
- **Source of truth**: project docs (`README.md`, `ROADMAP.md`, `TODO.md`, `docs/01..06`, `LASTCHANGES.md`). Read them before nontrivial changes. After a significant session, prepend an entry to `LASTCHANGES.md` in the existing format and tick items off in `TODO.md`.
- **Sibling project conventions**: this codebase deliberately mirrors `/www/crypto/ton/` (the `ton-bot` project). PM2, no build step, Tailwind via CDN, `data/` for runtime state. Read `/www/crypto/ton/CLAUDE.md` if you need precedent for a pattern.

## Hard rules (do not violate without explicit user request)

- **Never write the dev-server hostname into committed files.** Examples in docs use placeholders like `your-server.example.com`. The real host lives only in `.env` (gitignored). The repo is **public** on GitHub.
- **Never commit `.env`, `data/`, `logs/`, mnemonics, bot tokens, or API keys.** The `.gitignore` is the safety net; don't trust it blindly — eyeball every `git add`.
- **Never run a long-running dev server without checking ports.** `ton-bot` owns 3030; TonExplorer defaults to 3031. If `PORT` collides, stop and ask.
- **Public read-only API.** No write endpoints unless the user explicitly asks for them. Mutating endpoints (e.g. tagging a developer as rugger) must be gated behind a non-default flag and never reachable from the public web by default.

## Runtime

```bash
# Local dev (foreground)
npm install
npm start

# Watch mode
npm run dev

# Eventually under PM2 (don't add ecosystem.config.js with host-specific paths to git)
# Document it in docs/06-deployment.md using placeholders.
```

The server binds on `0.0.0.0:$PORT`. It assumes a reverse proxy mounts it at `$BASE_PATH` (default `/explorer`). The frontend reads `BASE_PATH` from a `<meta>` tag injected at render time so all `fetch()` calls use the right prefix.

## Architecture (one screen)

```
                ┌──────────────┐
HTTP request ──►│  Express     │── mounts at BASE_PATH
                │  src/server  │
                └──────┬───────┘
                       │
       ┌───────────────┼─────────────────┐
       ▼               ▼                 ▼
   views/         src/routes/       src/lib/tonapi.js
   index.html     (api endpoints)   (TonAPI HTTP client + cache)
                       │                 │
                       ▼                 ▼
              src/analyzers/*     external TonAPI
              (pure heuristics)
                       │
                       ▼
              src/db/index.js  ── better-sqlite3 ──► data/explorer.sqlite
```

- **`src/server.js`** — entry point, env loading, middleware order, route mounting, ws upgrade hook.
- **`src/routes/`** — thin handlers; no business logic, just call lib/services/analyzers/db. Trading endpoints in `trading.js` + `trading-ws.js`. Search in `search.js`.
- **`src/lib/`** — outbound clients (`tonapi.js`, future `toncenter.js`) and cross-cutting utilities (cache, address normalization, logger, rate-limiter, auth).
- **`src/services/`** — vertical features built from `lib/` primitives: `dedust-client`, `stonfi-client`, `dex-detection`, `candle-builder`, `trade-parser`, `trade-stream`. Each one is independently testable; instantiated in `server.js` and threaded through `ctx`.
- **`src/analyzers/`** — pure functions that take fetched data and produce verdicts. Easiest to test, write here aggressively.
- **`src/db/`** — schema + migrations + query helpers (`better-sqlite3`, synchronous API, no ORM).
- **`views/`** — static HTML. No bundler. `index.html` = screening page, `trading.html` = chart + live trade feed.
- **`tests/`** — `node:test` suites. Run with `npm test`.
- **`data/`** — gitignored runtime state (SQLite file, possibly local caches).

## Patterns to follow

- Address normalization: TON addresses come in raw (`0:abc...`) and friendly (`EQ...`/`UQ...`) forms. Normalize at the boundary (`src/lib/address.js`) before using as a DB key. Pick one canonical form and stick to it (raw `0:...` is recommended).
- All TonAPI calls go through `src/lib/tonapi.js`. Don't `axios.get('https://tonapi.io/...')` directly elsewhere — caching, auth, and error handling live in the wrapper.
- DB writes happen inside the route handler **after** the analysis succeeded. Never write half-state.
- Errors returned by the API follow `{ ok: false, error: { code, message } }`. Success: `{ ok: true, data: ... }`.

## Things that will surprise future-you if you forget

- `better-sqlite3` is synchronous. That's fine inside Express handlers and intentional — it removes a whole class of race bugs around the file. Don't wrap it in async wrappers "for consistency".
- TonAPI free tier rate-limits aggressively. Cache aggressively. Don't loop over holders without throttling.
- A jetton's "deployer" isn't always its admin. Track both. The deployer is usually the address that sent the initial deploy message; the admin is whatever the contract currently reports. Either may be renounced (`addr_none`).
- `ChangeAdmin` on Tact-style minters is two-step (`ChangeAdmin` → `ClaimAdmin`). A jetton can look "renounced" while a takeover is mid-flight. See `/www/crypto/ton/CLAUDE.md` for opcodes.

## When in doubt, ask

The user runs other people's money through decisions informed by this tool. Conservative defaults > clever heuristics. If a signal is unclear, surface uncertainty in the UI rather than fabricating confidence.
