# 05 — HTTP API

Base URL: `${PUBLIC_ORIGIN}${BASE_PATH}` (defaults: `http://localhost:3031/explorer`). All endpoints are read-only and unauthenticated. Responses are JSON.

## Envelope

Every endpoint returns one of:

```json
{ "ok": true, "data": { ... } }
```
```json
{ "ok": false, "error": { "code": "string", "message": "string" } }
```

`error.code` values:

| code                    | http | meaning                                          |
|-------------------------|------|--------------------------------------------------|
| `bad_address`           | 400  | input couldn't be parsed as a TON address        |
| `bad_query`             | 400  | `q` parameter is empty                           |
| `bad_interval`          | 400  | unrecognised candle interval                     |
| `bad_range`             | 400  | candle `from >= to`                              |
| `not_found`             | 404  | address parsed, but TonAPI returned no jetton    |
| `not_listed`            | 404  | jetton is not on any tracked DEX                 |
| `pool_not_found`        | 404  | `?pool=` references a pool not in the registry   |
| `upstream_unavailable`  | 502  | TonAPI / DeDust / STON.fi unreachable or 429'd   |
| `rate_limited`          | 429  | client exceeded `RATE_LIMIT_MAX`                 |
| `internal`              | 500  | anything else; details in server logs            |

## Endpoints

### `GET /api/health`

Liveness + identity. No data fetched. Always cheap.

```json
{
  "ok": true,
  "data": {
    "name": "ton-explorer",
    "version": "0.1.0",
    "uptime_seconds": 12345,
    "network": "mainnet"
  }
}
```

### `GET /api/token/:address`

Full analysis of one jetton master. `:address` accepts raw (`0:...`) or friendly (`EQ.../UQ...`) form.

Phase 0 response (what's shipping first — verdict is a stub):

```json
{
  "ok": true,
  "data": {
    "token": {
      "address": "0:...",
      "address_friendly": "EQ...",
      "name": "Example",
      "symbol": "EX",
      "decimals": 9,
      "supply": "1000000000000000",
      "admin": "0:..." ,
      "deployer": "0:...",
      "deployed_at": 1716640000,
      "holders_count": 1234
    },
    "developer": {
      "address": "0:...",
      "jettons_count": 3,
      "rugs_count": 0,
      "alive_count": 1,
      "reputation_score": 60,
      "confidence": "low",
      "tag": null
    },
    "holders": {
      "total": 1234,
      "top": [
        { "address": "0:...", "balance": "...", "share": 0.18 }
      ]
    },
    "verdict": {
      "phase": 0,
      "score": null,
      "summary": "Phase 0 build — verdict not yet computed.",
      "signals": []
    },
    "trading": {
      "dexes": ["dedust"],
      "primary_pool": "0:3e5f…",
      "primary_dex":  "dedust",
      "paired_with":  "TON",
      "url": "/explorer/trading/0:..."
    }
  }
}
```

Phase 1+ adds: `developer.fates_breakdown`, `verdict.score`, `verdict.signals[]` with explainable contributors. `trading.dexes` is `[]` when the jetton is not listed on any tracked DEX.

### `GET /api/developer/:address` (Phase 1)

Everything we know about a single developer.

```json
{
  "ok": true,
  "data": {
    "address": "0:...",
    "first_seen_at": 1700000000,
    "jettons_count": 5,
    "rugs_count": 3,
    "alive_count": 1,
    "reputation_score": 25,
    "tag": "rugger",
    "jettons": [
      {
        "address": "0:...",
        "symbol": "ABC",
        "fate": "rugged",
        "fate_reason": "Top-1 holder 83% with mint still active",
        "deployed_at": 1710000000
      }
    ]
  }
}
```

### `GET /api/trading/:jetton/info`

Detection result for one jetton: which DEXes it appears on, the primary pool, and the top 10 pools by reserve_quote.

```json
{ "ok": true, "data": {
  "jetton_master": "0:b113…",
  "dexes": ["dedust", "stonfi"],
  "primary": { "dex": "dedust", "pool": "0:3e5f…", "paired_with": "TON" },
  "pools": [
    {
      "address": "0:3e5f…",
      "dex": "dedust",
      "paired_with": "TON",
      "pool_type": "volatile",
      "base_decimals": 6, "quote_decimals": 9,
      "reserve_base": "452403426780", "reserve_quote": "178839337017561",
      "trade_fee_bps": 10,
      "last_synced": 1779756772
    }
  ],
  "pool_count": 1595,
  "url": "/explorer/trading/0:b113…"
}}
```

Errors: `bad_address` (400), `upstream_unavailable` (502).

### `GET /api/trading/:jetton/trades?limit=&before=&pool=`

Most recent trades on the resolved primary pool (or `?pool=<raw>` for any pool already in the registry). On a no-`before` call the server refreshes from DeDust, persists with `INSERT OR IGNORE`, then reads back from SQLite. Newest-first.

```json
{ "ok": true, "data": {
  "jetton_master": "0:b113…",
  "pool": { ...same shape as above... },
  "sync": { "pool_address": "...", "oldest_synced_ts": 1778330563, "newest_synced_ts": 1778330584, "fully_synced": 0 },
  "fetched": 300,
  "trades": [{
    "lt": "75851132000056",
    "ts": 1778330584,
    "side": "buy",
    "trader": "0:...",
    "asset_in": "TON",
    "asset_out": "0:b113…",
    "amount_in": "2730000000",
    "amount_out": "6911409",
    "price_native": 0.3949990515682113
  }]
}}
```

`side` is buy/sell relative to the pool's jetton_master. `price_native` is in `paired_with` units. Errors: `bad_address` (400), `not_listed` (404), `pool_not_found` (404), `upstream_unavailable` (502).

### `GET /api/trading/:jetton/candles?interval=&from=&to=&pool=`

OHLCV candles built in-memory from local `trades`. Does NOT refresh from DeDust — call `/trades` first. Intervals: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`. Default window: last 24 h.

```json
{ "ok": true, "data": {
  "jetton_master": "0:b113…",
  "pool": { ... },
  "interval": "1h", "interval_seconds": 3600,
  "from": 1778329980, "to": 1779800000,
  "candles": [{ "time": 1778329980, "open": 0.395, "high": 0.396, "low": 0.395, "close": 0.396, "volume": 1.83 }]
}}
```

`volume` is in `paired_with` units. Errors: `bad_address` (400), `bad_interval` (400), `bad_range` (400), `not_listed` (404), `pool_not_found` (404).

### `WS /api/trading/:jetton/stream`

Live trade stream. See `docs/07-trading.md` for the wire protocol.

### `GET /api/search?q=&limit=`

Search jettons by address (raw / friendly) or text. Returns up to `limit` results (default 20, capped at 50).

```json
{ "ok": true, "data": {
  "query": "usdt",
  "kind": "text",
  "results": [{
    "address": "0:b113…",
    "symbol": null,
    "name": "USD₮",
    "decimals": null,
    "source": "tonapi",
    "trust": "whitelist"
  }]
}}
```

For address-shaped input, `kind: "address"` and `results` has a single entry with `source: "input"`. Errors: `bad_query` (400), `bad_address` (400).

### `GET /api/recent` (Phase 5)

Recent analyses across all visitors. Privacy-trivial — we don't store who asked.

```json
{
  "ok": true,
  "data": {
    "analyses": [
      {
        "jetton": "0:...",
        "symbol": "X",
        "score": 18,
        "verdict": "high_risk",
        "analyzed_at": 1716640000
      }
    ]
  }
}
```

## Rate limiting

Per-IP token bucket. Configured via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX` in `.env`. On exceed:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30

{"ok":false,"error":{"code":"rate_limited","message":"too many requests"}}
```

When behind nginx, `TRUST_PROXY` must be set so Express reads the real client IP from `X-Forwarded-For`.

## CORS

`GET` from anywhere is allowed. All other methods are denied at the middleware level (we have no other methods yet — this is a guardrail).

## Versioning

`/api/*` is unversioned in Phase 0–1. If/when we expose this publicly to third-party consumers, we'll move under `/api/v1/`.
