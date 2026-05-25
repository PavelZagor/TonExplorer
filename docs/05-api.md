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
| `not_found`             | 404  | address parsed, but TonAPI returned no jetton    |
| `upstream_unavailable`  | 502  | TonAPI / TonCenter unreachable or 429'd          |
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
    }
  }
}
```

Phase 1+ adds: `developer.fates_breakdown`, `verdict.score`, `verdict.signals[]` with explainable contributors.

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
