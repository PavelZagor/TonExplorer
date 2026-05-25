# Last Changes

Newest first. Append a fresh entry at the top of this file after every significant session. Keep entries tight — one paragraph + a bullet list, no marketing copy.

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
