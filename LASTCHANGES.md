# Last Changes

Newest first. Append a fresh entry at the top of this file after every significant session. Keep entries tight — one paragraph + a bullet list, no marketing copy.

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
