# 02 — Data sources

## Primary: TonAPI

[TonAPI](https://tonapi.io/) (docs at https://docs.tonconsole.com/tonapi). REST + WebSocket, well documented, generous schema for jettons. Auth via `Authorization: Bearer <token>` (optional — a public tier exists but is heavily rate-limited).

Endpoints we use:

| Purpose                       | Endpoint                                                      |
|-------------------------------|---------------------------------------------------------------|
| Jetton master info            | `GET /v2/jettons/{account_id}`                                |
| Jetton holders                | `GET /v2/jettons/{account_id}/holders?limit=100`              |
| Account info (deployer/admin) | `GET /v2/accounts/{account_id}`                               |
| Account jettons               | `GET /v2/accounts/{account_id}/jettons`                       |
| Recent events on an account   | `GET /v2/accounts/{account_id}/events?limit=100`              |
| Recent jetton transfers       | `GET /v2/jettons/{account_id}/transfers` (or events on master)|
| All known jettons (paged)     | `GET /v2/jettons?limit=1000`                                  |

Things to mind:
- TonAPI returns addresses in both raw and friendly formats — be explicit about which one you store.
- The "deployer" of a jetton master isn't an explicit field. We have to derive it: fetch the very first inbound transaction to the master account and read `source` from the message.
- Some response fields differ between mainnet and testnet base URLs (`https://tonapi.io` vs `https://testnet.tonapi.io`). Switch base URL via `TON_NETWORK`.

## Secondary: TonCenter v3

[TonCenter](https://toncenter.com/api/v3/) — official, JSON-RPC + indexer v3. We treat it as a fallback when TonAPI is down or rate-limited. The sibling `ton-bot` already uses TonCenter heavily, so we know its quirks.

Useful for:
- Raw transaction history when TonAPI's processed view hides what we want.
- Mainnet/testnet network ID confirmation when verifying a contract address.

## Tertiary (not yet wired): own indexer / dton.io

Out of scope for Phase 0–2. Would matter when:
- We need full mempool visibility (Phase 3 MEV detection might justify it).
- TonAPI/TonCenter rate limits become a real bottleneck.

## DEX-side data

For LP detection and trade history we'll query DEXes directly:
- **STON.fi** — `https://api.ston.fi/v1/` (pool info, swaps)
- **DeDust** — `https://api.dedust.io/v2/` (pool info, swaps)

Add these in Phase 2 when we start looking at LP locks and trade clustering.

## Caching

In-memory `Map` keyed by `endpoint + params`, value `{ data, expiresAt }`. Default TTL by category:

| Category                              | TTL          |
|---------------------------------------|--------------|
| Jetton master info                    | 60 seconds   |
| Holders page                          | 60 seconds   |
| Account info                          | 5 minutes    |
| Historic events (older than 1 hour)   | 1 hour       |
| Live events (most recent block)       | 5 seconds    |

A request hitting an expired entry refetches synchronously; a hit on a fresh entry returns immediately. Stampede protection: keep an in-flight `Promise` map keyed by the same cache key so concurrent requests for the same resource share one upstream call.

## Keys

`TONAPI_KEY` is **optional**. Without it we use TonAPI's free tier and risk 429s under load. With it, rate limits are higher. The key lives only in `.env`; never log it.

## Address handling

TonAPI accepts both raw (`0:abc...`) and user-friendly (`EQ...` / `UQ...`) forms. We normalize to raw internally as the canonical key — friendly forms encode bounceability and testnet flags that we don't want polluting DB keys. Conversion lives in `src/lib/address.js` (Phase 0).
