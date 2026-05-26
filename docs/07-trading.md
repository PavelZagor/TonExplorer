# 07 — Trading data

Real-time-ish trade feed and candle chart for any jetton listed on a tracked DEX. Detection-only for STON.fi; full integration (price/chart/trades) for DeDust.

---

## Why a separate doc

Trading is an additional "pillar" of the analysis, not a replacement. The screening half of the app (developer reputation, holder distribution, MEV/farm) is unchanged. The trading half lives in `src/services/` (clients + parsers + stream) and `src/routes/trading*.js`, with one new view at `views/trading.html`. New tables live in `src/db/migrations/003_trading.sql`.

## Data flow

```
                            ┌─────────────────────┐
       GET /api/trading/    │  Express            │      DeDust /v2/pools
       :jetton/info         │  src/routes/        │ ◄─── (cached 5 min)
   ──►                      │    trading.js       │
                            │                     │      DeDust /v2/pools/
       GET /api/trading/    │                     │ ◄─── {addr}/trades
       :jetton/trades       │                     │
   ──►                      │  src/services/      │
                            │    dex-detection    │      STON.fi /v1/pools
       GET /api/trading/    │    dedust-client    │ ◄─── (cached 5 min,
       :jetton/candles      │    stonfi-client    │       detection-only)
   ──►                      │    candle-builder   │
                            │    trade-parser     │
       WS  /api/trading/    │                     │
       :jetton/stream       │  src/routes/        │
   ◄──►                     │    trading-ws.js    │
                            │                     │
                            │  src/services/      │
                            │    trade-stream     │ (polls DeDust per
                            └──────────┬──────────┘  active pool every
                                       │             ~8s, emits new
                                       ▼             trades to clients)
                              ┌────────────────┐
                              │  SQLite        │
                              │  trading_pools │
                              │  trades        │
                              │  sync_state    │
                              └────────────────┘
```

REST endpoints write trades through to SQLite (`INSERT OR IGNORE` keyed by `(pool, lt)`). The WS layer reuses the same parser and the same table. There is no separate write path.

## Schema (`003_trading.sql`)

```sql
trading_pools(pool_address PK, dex, jetton_master, paired_with, pool_type,
              base_decimals, quote_decimals, reserve_base, reserve_quote,
              trade_fee_bps, last_synced, created_at)

trades(pool_address, lt, ts, side, trader, asset_in, asset_out,
       amount_in, amount_out, price_native,
       PRIMARY KEY (pool_address, lt))

trading_sync_state(pool_address PK, oldest_synced_ts, newest_synced_ts,
                   fully_synced)
```

Key choices:
- **No `tx_hash` column.** DeDust's `/v2/pools/{addr}/trades` does not return tx hash; `lt` (logical time) is unique within an account, so `(pool_address, lt)` is the PK instead.
- **No `raw_trace_json` column.** Anti-pattern per the spec; if the debug path ever needs a trace, refetch via TonAPI.
- **No USD columns.** DeDust REST doesn't expose USD pricing. STON.fi does (`lp_total_supply_usd`, `volume_24h_usd`) but we currently only carry STON.fi data in memory for detection.
- **Addresses are raw form** (`0:hex`) throughout — consistent with `lookups` and `wallets`. Normalisation happens at the boundary via `src/lib/address.js::toRaw`.

## DeDust API quirks

| Endpoint                                  | Result                                     |
| ----------------------------------------- | ------------------------------------------ |
| `GET /v2/pools`                           | **200**, ~24 MB JSON, ~50 k pools          |
| `GET /v2/pools/{addr}`                    | **404 Not Found** — does NOT exist         |
| `GET /v2/pools/{addr}/trades?page_size=N` | **200**, JSON array, oldest-first          |
| `GET /v2/jettons` / `/v3/*`               | **404**                                    |

Implications:
1. Per-pool info comes from filtering the bulk list locally. The client caches it for `DEDUST_CACHE_TTL_SECONDS`.
2. The trades array is oldest-first; we re-sort to newest-first before returning to callers.
3. There is no per-pool fee or per-pool TVL endpoint — both have to be extracted from the bulk pool row.

## STON.fi API quirks

- `GET /v1/pools` returns `{ pool_list: [...] }` (~43 MB, ~43 k pools). The wrapper extracts `pool_list`.
- Native TON is encoded as the **all-zeros** address — friendly `EQAAAAAA…AM9c`, raw `0:000…000`. `TON_PSEUDO_RAW` is exported by `src/services/stonfi-client.js` for callers that need to detect it.
- Pools with `deprecated: true` are skipped at the detection layer.

## HTTP endpoints

See `docs/05-api.md` for the formal contract. Quick reference:

```
GET  /api/trading/:jetton/info
GET  /api/trading/:jetton/trades?limit=&before=&pool=
GET  /api/trading/:jetton/candles?interval=&from=&to=&pool=
GET  /api/search?q=&limit=
WS   /api/trading/:jetton/stream
```

## WebSocket protocol

The handler is `src/routes/trading-ws.js`, attached to the HTTP server with `noServer: true`. Each client opens a connection at `${BASE_PATH}/api/trading/:jetton/stream`. Server messages:

```json
{ "type": "subscribed", "jetton": "0:...", "pool": "0:...", "paired_with": "TON" }
{ "type": "trade",      "data": <normalised trade row> }
{ "type": "ping",       "ts": 1716700000 }
{ "type": "error",      "code": "not_listed" | "pool_not_found" | "upstream_unavailable" | "too_many_clients", "message": "..." }
```

Clients send nothing. Heartbeat: server pings every 30 s; misses two in a row → terminate. Native WS ping/pong is also wired so browsers stay connected through idle proxies.

`TradeStream` (`src/services/trade-stream.js`) is a singleton EventEmitter keyed by pool address. `subscribe(pool)` increments a refcount and starts the per-pool timer when it goes 0→1. The timer polls DeDust every `TRADING_POLL_MS` (default 8 s), filters by `lt > lastSeenLt`, inserts new trades into the local table, and emits a `trade` event per fresh row. The WS handler forwards those events to subscribed clients.

## Why polling and not TonAPI WS

The original spec called for subscribing to TonAPI's streaming endpoint and parsing traces. Two reasons we picked DeDust polling instead:

1. **Simplicity.** DeDust's `/trades` already returns fully-parsed swap objects in the shape we want. Parsing a TonAPI trace requires the trace endpoint + a swap parser + multi-hop handling — significantly more code and more upstream calls per event.
2. **Sibling-project precedent.** `/www/crypto/ton/` (the ton-bot project) is REST-only — no WS client anywhere. Adopting a polling design keeps the two projects' upstream-integration shapes consistent.

The trade-off is latency: ~8 s instead of sub-second. Acceptable for a "live feed" UI. If we later need sub-second updates (e.g. trade alerts to Telegram), the trade-parser interface (`normalizeDedustTrade(t, pool)`) can be reused from a TonAPI trace path — the row shape is unchanged.

## How to add a new DEX

1. Drop `src/services/<dex>-client.js` — bulk-pool cache, trade fetch.
2. Add a `<dex>PoolToRow(p, targetRaw)` projector in `src/services/dex-detection.js` and a parallel call in `gather<Dex>()`.
3. Add the DEX to `pickPrimary` if it has full pool data (`base_decimals` / `quote_decimals` / `reserve_quote`).
4. Add the DEX's trade-shape normaliser to `src/services/trade-parser.js`.
5. If the DEX supports a working per-pool trades endpoint, that's enough — the existing REST + WS layer picks it up. If not, integration is detection-only.
6. Add env knobs to `.env.example`.

## Frontend

`views/trading.html` is vanilla HTML + Tailwind CDN + TradingView Lightweight Charts 4.2.0 via CDN. No bundler. The page reads the jetton from `location.pathname`, calls the four endpoints in order, renders a candle chart + a trades table, and opens the WebSocket for live updates with capped-exponential reconnect.

The screening page (`views/index.html`) renders a compact Trading card after the verdict block. The card shows "Listed on: [DEX badges]" and a "View live trades →" button when the jetton is tradable, or "Not listed on tracked DEXes" otherwise.

## Tests

`npm test` runs the `node:test` suite. Trading-specific tests:

- `tests/dex-detection.test.js` — DeDust pool projection and primary picking.
- `tests/stonfi-detection.test.js` — STON.fi pool projection + TON pseudo-address handling + upstream-failure resilience.
- `tests/candle-builder.test.js` — bucket math, O/H/L/C/V semantics, edge cases.
- `tests/trade-stream.test.js` — refcount, dedup-by-lt across restarts.
