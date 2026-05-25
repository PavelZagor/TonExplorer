# TonExplorer

Scam-screening analytics for TON jettons. Before buying a freshly-launched token, point TonExplorer at its master address and get a verdict based on three pillars:

1. **Developer reputation** — local registry of jetton deployers and their track record (how many tokens they've launched, how those ended up).
2. **Holder distribution** — top holders, concentration, fresh-wallet ratio, LP locks.
3. **Activity quality** — coordinated buy patterns, MEV / bot-farm signatures, wash-trading indicators.

> ⚠️ Early-stage project. The current build is the web interface skeleton. A Telegram bot wrapping the same backend is on the roadmap.

## Status

- 🚧 Phase 1 — Web UI (in progress)
- ⏳ Phase 2 — Telegram bot
- ⏳ Phase 3 — Continuous indexer / alerts

See [`ROADMAP.md`](./ROADMAP.md) and [`TODO.md`](./TODO.md) for what's next.

## Quickstart

```bash
git clone https://github.com/PavelZagor/TonExplorer.git
cd TonExplorer
cp .env.example .env
# edit .env — at minimum set TONAPI_KEY if you want raised rate limits
npm install
npm start
# open http://localhost:3031/explorer/
```

## Configuration

All config lives in `.env`. See [`.env.example`](./.env.example) for every option. The most important:

| Variable          | Default                         | Purpose                                                  |
|-------------------|---------------------------------|----------------------------------------------------------|
| `PORT`            | `3031`                          | Port Express binds on                                    |
| `BASE_PATH`       | `/explorer`                     | URL prefix when served behind a reverse proxy            |
| `TONAPI_KEY`      | _(empty — public tier)_         | TonAPI key from https://tonconsole.com/                  |
| `TON_NETWORK`     | `mainnet`                       | `mainnet` or `testnet`                                   |
| `SQLITE_PATH`     | `data/explorer.sqlite`          | Local SQLite file (gitignored)                           |
| `RATE_LIMIT_MAX`  | `60`                            | Max requests per IP per window                           |

## Architecture (one paragraph)

A single Express process boots, opens a SQLite file under `data/`, exposes a small read-only JSON API under `/api/...`, and serves a static HTML page from `views/`. All TON-chain data is fetched on demand from [TonAPI](https://tonapi.io); results are cached briefly to keep upstream rate-limits happy. Every time a token is analyzed, its deployer is upserted into the local developer registry — that's how the reputation pillar grows over time. The frontend is a vanilla HTML page styled with Tailwind via CDN, no build step.

Deeper writeups live in [`docs/`](./docs/):

- [`docs/01-architecture.md`](./docs/01-architecture.md) — components and dataflow
- [`docs/02-data-sources.md`](./docs/02-data-sources.md) — TonAPI, TonCenter, alternatives
- [`docs/03-developer-tracking.md`](./docs/03-developer-tracking.md) — registry schema and reputation scoring
- [`docs/04-mev-detection.md`](./docs/04-mev-detection.md) — heuristics for bot farms / coordinated pumps
- [`docs/05-api.md`](./docs/05-api.md) — HTTP API reference
- [`docs/06-deployment.md`](./docs/06-deployment.md) — generic deployment notes (no host-specific config)

## Disclaimer

TonExplorer outputs **heuristic** signals. A clean score is not a recommendation to buy and a red score is not proof of fraud. Crypto is risky; do your own research. No financial advice.

## License

MIT — see [`LICENSE`](./LICENSE) (if present) or assume MIT until otherwise noted.
