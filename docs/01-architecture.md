# 01 — Architecture

## Goal

A small, opinionated analyzer for TON jettons that fits in one Node process, one SQLite file, and a single HTML page. Everything else is a future problem.

## Components

```
┌────────────────────────────────────────────────────────────────────┐
│                          Express process                           │
│                                                                    │
│   ┌──────────┐    ┌────────────┐    ┌────────────┐    ┌──────────┐ │
│   │ views/   │◄───┤ static     │    │ /api/*     │◄───┤ routes/  │ │
│   │ index    │    │ middleware │    │ rate-limit │    │          │ │
│   └──────────┘    └────────────┘    └─────┬──────┘    └────┬─────┘ │
│                                            │                 │     │
│                                            │                 ▼     │
│                                            │           ┌──────────┐│
│                                            │           │ lib/     ││
│                                            │           │ tonapi   ││──► TonAPI
│                                            │           └────┬─────┘│
│                                            │                │      │
│                                            ▼                ▼      │
│                                     ┌────────────┐   ┌──────────┐  │
│                                     │ analyzers/ │   │ db/      │──┼──► data/explorer.sqlite
│                                     │ (pure)     │   │          │  │
│                                     └────────────┘   └──────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Dataflow for "analyze this jetton"

1. Browser issues `GET {BASE_PATH}/api/token/{address}`.
2. Route handler validates + normalizes the address.
3. `lib/tonapi.js` fetches:
   - jetton master info (name, symbol, supply, admin, deployer, holders count)
   - top holders (page 1)
   - recent transactions / events on the master
4. `analyzers/*` run pure functions over the fetched payloads:
   - `analyzers/holders.js` — concentration, fresh-wallet ratio
   - `analyzers/developer.js` — deployer identity + stable summary
   - `analyzers/activity.js` — (phase 3) coordinated-buy detection
5. `db/` upserts deployer + jetton + a row in `analyses` (timestamp, verdict snapshot).
6. Handler returns `{ ok: true, data: { token, developer, holders, verdict } }`.

The frontend renders cards from `data`. No client-side computation of the verdict — server is authoritative.

## Why this layout

- **Routes ↔ analyzers ↔ lib ↔ db are layered.** Routes orchestrate; they don't grow into business logic. Analyzers are pure → trivial to unit test once we add a test runner.
- **TonAPI access is centralized.** Caching, retries, rate-limit handling all live in one place. If we later swap to TonCenter or run our own indexer, only `lib/` changes.
- **SQLite, not Postgres.** Single file, no daemon, atomic, fast for our read pattern. When we outgrow it we'll know.
- **Synchronous DB.** `better-sqlite3` is sync. That's a feature: simpler code, no race windows around transactions inside a request.

## Concurrency model

- Express is single-threaded per process. Heuristic analyzers are CPU-light; they finish in microseconds.
- TonAPI requests are I/O — we'll naturally have many concurrent outbound fetches when multiple users analyze in parallel. Cap parallelism per IP in rate-limit middleware; cap parallelism per upstream by reusing a single `axios` instance with `httpAgent.maxSockets`.
- Heavy work (cluster detection over many transactions in Phase 3) will run in a worker thread or as a background script invoked via `tools/`. Don't block the request loop.

## Failure modes we plan for

| Failure                              | Behavior                                                         |
|--------------------------------------|------------------------------------------------------------------|
| TonAPI down or 429                   | Return cached value if fresh; otherwise `{ ok: false, error: { code: "upstream_unavailable" } }` with a hint to retry |
| Invalid address                      | 400 with `error.code = "bad_address"`                            |
| Jetton not found                     | 404 with `error.code = "not_found"`                              |
| SQLite write fails                   | Log + return the on-chain analysis anyway — DB write is best-effort, the read path doesn't need it to succeed |
| Process restart                      | In-memory cache empties; SQLite state survives                   |

## Boundaries

- **In scope:** TON jettons. Pricing/charts can come later; we are first about scam-screening, not market-data.
- **Out of scope:** trading actions, wallet connect, signing anything. This service holds no keys and signs no transactions. (Sibling `ton-bot` is the one that signs; do not import it from here.)
