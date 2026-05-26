# Plan — Trading page with DeDust integration

**Status:** archived spec, work not started.
**Author of spec:** maintainer (Pavel), pasted 2026-05-25.
**Carried into:** next fresh session.

---

## Pre-flight reality check (do not skip)

Before writing code in the new session, read this section. The spec assumes things that probed false in 2026-05-25:

### Codebase mismatches with the spec

- The spec says "extend `/api/jetton/:address`". **Our actual route is `/api/token/:address`** (`src/routes/token.js`). Either keep that name and adapt the spec, or add the alias — but don't break existing callers.
- The spec says "src/db/migrations.js". **Our migration runner reads `*.sql` files from `src/db/migrations/`** (see `src/db/index.js::runMigrations`). New schema must be a numbered SQL file in that directory, e.g. `003_trading.sql`.
- There is currently **no test runner set up**. Spec mentions extending an existing test setup; there isn't one. Pick `node:test` (already shipped with Node 20) and add `npm test` to `package.json` as part of step 1 if testing is in scope.
- An admin Bearer-token middleware (`src/lib/auth.js`) and an admin subtree (`src/routes/admin/`) already exist. Trading routes are **read-only**, so they should NOT live under `/admin/` and do NOT need the Bearer token.
- Address normalization is done at the boundary by `src/lib/address.js::toRaw` — keep using that for any new DB key.

### DeDust API surface — what actually responds

Probed against `https://api.dedust.io/`:

| Endpoint                                  | Result                                     |
| ----------------------------------------- | ------------------------------------------ |
| `GET /v2/pools`                           | **200**, 24 MB JSON, ~50 454 pools         |
| `GET /v2/pools/{addr}`                    | **404 Not Found** — does NOT exist         |
| `GET /v2/pools/{addr}/trades?page_size=N` | **200**, JSON array of trade objects       |
| `GET /v2/pools/{addr}/swaps`              | **404**                                    |
| `GET /v2/trades?pool={addr}`              | **404**                                    |
| `GET /v2/jettons` / `/v2/jettons/{addr}`  | **404**                                    |
| `GET /v3/pools` / `/v3/swaps`             | **404 page not found**                     |
| `GET /v2/factories`                       | **404**                                    |

**Implications for the design in the spec:**

1. **Pool info has to come from the bulk `/v2/pools` list, filtered locally.** Cache it for `DEDUST_CACHE_TTL_SECONDS` (spec default 300s) and serve `getPool(addr)` from that cache. There is no per-pool info endpoint.
2. The "DeDust jetton info" path the spec lists as a fallback (`getJettonMeta`) does not exist — drop it from the fallback chain, jetton metadata must come from TonAPI only.
3. The trades endpoint works but for the canonical PUTIN/TON pool it returned `[]`. Verify against a known busy pool (TON/USDT or TON/NOT) in the new session before claiming the integration works end-to-end.

### TonAPI WebSocket — checked at the start of probe, not finished

The spec wants `wss://tonapi.io/v2/websocket` with `subscribe_trace`. The `ws` package was not in `node_modules`, so I installed it (`npm install ws --save` — this added `ws` to `package.json` and updated `package-lock.json` in this working tree). The actual WS handshake / subscription wire format was not yet verified live; do that as the very first probe in the next session before designing `src/services/trade-stream.js`.

### Sibling-project precedent

`/www/crypto/ton/` (the ton-bot project) talks to TonAPI extensively. Before designing the streaming layer, skim that codebase for any existing WS client — if it's there, reuse the shape; if not, ours becomes the first.

---

## The spec, verbatim from the maintainer

> # ТЗ для Claude Code: Trading-страница для jetton'ов с DeDust-интеграцией
>
> ## 1. Контекст и цель
>
> В TonExplorer уже реализована scam-screening аналитика jetton'ов (deployer reputation, holder distribution, MEV-сигналы). Сейчас нужно добавить четвёртое измерение анализа — реальную торговую активность по токену: история сделок, свечной график, real-time события.
>
> **Юзкейс:** Пользователь вводит адрес jetton master (например, `EQDdd-YyeNBD0FvXWUZghbO4j7n9tqtAsvZWC2S22aGEjvHZ`) → получает страницу со свечным графиком и лентой сделок, обновляющуюся в реальном времени.
>
> **Цель** — НЕ копировать DEXScreener один-в-один, а интегрировать торговую активность в существующий explorer как четвёртый pillar анализа. Trading-страница должна быть доступна и как самостоятельный экран, и как блок в основной странице токена.
>
> ## 2. Скоп
>
> **Входит в задачу**
>
> - Backend-модуль детекции DEX'а для jetton.
> - Интеграция с DeDust API (история сделок, OHLCV, инфо о пуле).
> - Real-time стрим сделок через WebSocket TonAPI.
> - Хранение торговой истории в SQLite (инкрементально).
> - HTTP/WS-эндпоинты под `/api/trading/...`.
> - Новая страница `views/trading.html` со свечным графиком и лентой.
> - Поиск jetton'ов по тикеру/имени/адресу (общий, не только trading).
> - Бейдж/блок "Trading on: DeDust / STON.fi / not listed" на основной странице токена.
> - Документация в `docs/07-trading.md`.
> - Обновление CLAUDE.md, LASTCHANGES.md, ROADMAP.md, TODO.md.
>
> **НЕ входит (фиксируем явно, чтобы Claude Code не расширял скоп)**
>
> - Полная интеграция STON.fi (только детекция и пометка "available on STON.fi", без графика). Это отдельная задача после релиза.
> - Поддержка свопов (мы только показываем).
> - Поддержка не-jetton токенов (NFT, etc.).
> - Использование ton-mempool (отдельная фича в будущем).
> - Замена основной screening-логики.
>
> ## 3. Архитектура и принципы
>
> Принципы — те же что в codebase сейчас:
>
> - Один Express-процесс, SQLite файл, никаких лишних сервисов.
> - **No build step** — фронт остаётся vanilla HTML + Tailwind CDN. Добавляется свечной график как CDN-скрипт.
> - Кэш на коротких промежутках для уважения к rate limits.
> - Read-only API, ничего не пишем в блокчейн.
> - Graceful degradation — если DeDust API упал, показываем то, что есть в локальной БД + предупреждение.
>
> ### Поток данных
>
> ```
> ┌─────────────┐    1. enter jetton addr    ┌──────────────┐
> │  Browser    │ ─────────────────────────► │  Express     │
> │  /trading/  │                            │  /api/trading│
> └──────┬──────┘                            └──────┬───────┘
>        │                                          │
>        │ 2. WS subscribe pool                     │ 3. find DEX,
>        │◄─────────────────────────────────────────┤    fetch history,
>        │                                          │    upsert to SQLite
>        │                                          │
>        │                                          ▼
>        │                                   ┌──────────────┐
>        │                                   │ DeDust API   │
>        │                                   │ TonAPI REST  │
>        │                                   └──────┬───────┘
>        │                                          │
>        │                                          ▼
>        │                                   ┌──────────────┐
>        │ 4. real-time trade events         │ TonAPI WS    │
>        │◄──────────────────────────────────┤ (pool addr   │
>        │                                   │  subscription)│
>        │                                   └──────────────┘
> ```
>
> ## 4. Backend — что создаём/меняем
>
> ### 4.1. Новый модуль `src/services/dex-detection.js`
>
> Определяет, на каких DEX'ах представлен jetton.
>
> ```javascript
> // Возвращает: { dedust: { pools: [...] }, stonfi: { pools: [...] }, primary: 'dedust' | 'stonfi' | null }
> async function detectDexes(jettonMasterAddress) { ... }
> ```
>
> Реализация:
>
> - Закэшировать список всех пулов DeDust на 5 минут (`api.dedust.io/v2/pools`).
> - Для запрошенного jetton — найти все пулы, где один из ассетов = этот jetton master.
> - Аналогично закэшировать STON.fi pool list (с `api.ston.fi/v1/pools`), но для MVP — только детекция факта.
> - Возвращать `primary` = пул с максимальной TVL.
>
> Кеш — in-memory (как делаешь сейчас в codebase) с TTL.
>
> ### 4.2. Новый модуль `src/services/dedust-client.js`
>
> Тонкая обёртка над DeDust API. Эндпоинты, которые нужны:
>
> - `GET /v2/pools` — список всех пулов
> - `GET /v2/pools/{address}` — инфо о пуле
> - `GET /v2/pools/{address}/trades?limit=N&offset=M` — история сделок
> - `GET /v2/jettons/{address}` — метаданные jetton'а на DeDust
>
> Функции экспортирует:
>
> ```javascript
> async function getPool(poolAddress)
> async function getPoolTrades(poolAddress, { limit, before })
> async function getJettonMeta(jettonMaster)
> ```
>
> Используй `node-fetch` или `axios` (что уже стоит). Логи запросов — на DEBUG-уровне.
>
> ### 4.3. Новый модуль `src/services/candle-builder.js`
>
> DeDust не отдаёт OHLCV напрямую — строим сами из сделок.
>
> ```javascript
> // Группирует массив сделок по интервалу (1m, 5m, 15m, 1h, 4h, 1d)
> // и возвращает [{ time, open, high, low, close, volume }, ...]
> function buildCandles(trades, intervalSeconds) { ... }
> ```
>
> Это даст график в стиле DEXScreener.
>
> ### 4.4. Новый модуль `src/services/trade-stream.js`
>
> WebSocket-подписка на адрес пула через TonAPI Streaming.
>
> ```javascript
> // Подключается к wss://tonapi.io/v2/websocket
> // Подписывается на транзакции конкретного пула
> // При новой транзакции -> запрос трейса -> парсинг как swap -> emit event
> class TradeStream extends EventEmitter {
>   subscribe(poolAddress) { ... }
>   unsubscribe(poolAddress) { ... }
> }
> ```
>
> Один глобальный инстанс TradeStream'а на процесс, к которому подключаются клиенты через внутренний WebSocket нашего сервера (см. ниже). Между внешними подписками pool-адрес держится в "активных" пока есть хоть один внутренний клиент.
>
> При reconnect TonAPI — авто-resubscribe.
>
> ### 4.5. Новый модуль `src/services/trade-parser.js`
>
> Из трейса TonAPI выделить структурированную сделку:
>
> ```javascript
> // Вход — trace object от TonAPI
> // Выход — { txHash, timestamp, side: 'buy'|'sell', trader, amountIn, amountOut, assetIn, assetOut, priceUsd, valueUsd }
> function parseSwap(trace, poolMeta) { ... }
> ```
>
> Учесть:
>
> - Multi-hop свопы (TON → JETTON_A → JETTON_B) — берём только сделки на нужном пуле.
> - Failed транзакции — пропускаем.
> - Side определяется по тому, что приходит/уходит относительно jetton'а, на чьей странице мы находимся.
>
> ### 4.6. Расширение БД (`src/db/migrations.js`)
>
> Три новые таблицы:
>
> ```sql
> CREATE TABLE trading_pools (
>   pool_address TEXT PRIMARY KEY,
>   dex TEXT NOT NULL,                 -- 'dedust' | 'stonfi'
>   jetton_master TEXT NOT NULL,
>   paired_with TEXT NOT NULL,         -- 'TON' | другой jetton master
>   pool_type TEXT,                    -- 'volatile' | 'stable'
>   tvl_usd REAL,
>   last_synced INTEGER,
>   created_at INTEGER DEFAULT (strftime('%s','now'))
> );
> CREATE INDEX idx_pools_jetton ON trading_pools(jetton_master);
>
> CREATE TABLE trades (
>   tx_hash TEXT PRIMARY KEY,
>   pool_address TEXT NOT NULL,
>   timestamp INTEGER NOT NULL,
>   side TEXT NOT NULL,                -- 'buy' | 'sell'
>   trader TEXT NOT NULL,
>   amount_in TEXT,                    -- bigint as string
>   amount_out TEXT,
>   asset_in TEXT,
>   asset_out TEXT,
>   price_usd REAL,
>   value_usd REAL,
>   raw_trace_json TEXT,
>   FOREIGN KEY (pool_address) REFERENCES trading_pools(pool_address)
> );
> CREATE INDEX idx_trades_pool_time ON trades(pool_address, timestamp DESC);
> CREATE INDEX idx_trades_trader ON trades(trader);
>
> CREATE TABLE sync_state (
>   pool_address TEXT PRIMARY KEY,
>   oldest_synced_ts INTEGER,
>   newest_synced_ts INTEGER,
>   fully_synced BOOLEAN DEFAULT 0,
>   FOREIGN KEY (pool_address) REFERENCES trading_pools(pool_address)
> );
> ```
>
> Стратегия синка:
>
> - При первом запросе по jetton'у — backfill последних 500 сделок и пометить `newest_synced_ts`.
> - Если пользователь скроллит назад — догружаем порциями по 200, обновляем `oldest_synced_ts`.
> - Real-time события через WS дописывают новые с upsert по `tx_hash`.
>
> ### 4.7. HTTP/WS эндпоинты
>
> Добавить в `src/routes/`:
>
> | Метод | Путь                                                          | Описание                                                                       |
> | ----- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
> | GET   | `/api/trading/:jetton/info`                                   | Сводка: на каких DEX, primary pool, TVL, 24h volume, price                     |
> | GET   | `/api/trading/:jetton/trades?limit=100&before=<ts>`           | История сделок с пагинацией                                                    |
> | GET   | `/api/trading/:jetton/candles?interval=1m|5m|15m|1h|4h|1d&from=<ts>&to=<ts>` | OHLCV для графика                                              |
> | GET   | `/api/trading/:jetton/holders-trades?address=<wallet>`        | Сделки конкретного кошелька по этому jetton'у (для будущей фичи)               |
> | GET   | `/api/search?q=<text>&limit=20`                               | Поиск jetton'ов                                                                |
> | WS    | `/api/trading/:jetton/stream`                                 | Поток real-time сделок                                                         |
>
> **Поиск:**
>
> - Сначала пробует распознать как адрес (raw, UQ, EQ) → редирект на jetton page.
> - Если не адрес — ищет по локальной БД jetton'ов (тикер, имя) с LIKE.
> - Дополнительно дёргает TonAPI `/v2/accounts/search?name=<q>` как fallback.
>
> WebSocket-эндпоинт реализовать через `ws` (если ещё не подключено) или `socket.io`. Я бы пошёл с `ws` — без оверхеда.
>
> **Формат сообщений WS:**
>
> ```json
> // → клиент при подключении
> { "type": "subscribed", "jetton": "EQDdd...", "pool": "EQ..." }
>
> // ← сервер при новой сделке
> {
>   "type": "trade",
>   "data": {
>     "txHash": "...", "timestamp": 1716700000, "side": "buy",
>     "trader": "EQ...", "amountIn": "10000000000", "amountOut": "5000",
>     "priceUsd": 0.0021, "valueUsd": 21.5
>   }
> }
>
> // ← сервер периодически (heartbeat)
> { "type": "ping" }
> ```
>
> ### 4.8. Расширение существующего jetton-page API
>
> В существующий эндпоинт `/api/jetton/:address` (или как он там называется сейчас) добавить поле:
>
> ```json
> "trading": {
>   "dexes": ["dedust"],
>   "primaryPool": "EQ...",
>   "primaryDex": "dedust",
>   "url": "/explorer/trading/EQDdd-YyeNBD0Fv..."
> }
> ```
>
> Это чтобы основная страница токена могла показать "Trading: ✅ DeDust" с кнопкой "View trades".
>
> ## 5. Frontend — что создаём/меняем
>
> ### 5.1. Новая страница `views/trading.html`
>
> Лейаут (mobile-first как и остальная часть):
>
> ```
> ┌─────────────────────────────────────────────────────┐
> │  [back to token page] $TICKER on DeDust            │
> │  Price: $0.0021  24h: +12.5%  Vol: $1.2M  TVL: $250K│
> ├─────────────────────────────────────────────────────┤
> │                                                     │
> │  [Candle chart — lightweight-charts]                │
> │  Interval: [1m][5m][15m][1h*][4h][1d]              │
> │                                                     │
> ├─────────────────────────────────────────────────────┤
> │  Trades                          [live indicator 🟢]│
> │  ┌───────┬──────┬──────┬─────────┬──────┬────────┐  │
> │  │ Time  │ Type │  MC  │ Amount  │Value │ Trader │  │
> │  ├───────┼──────┼──────┼─────────┼──────┼────────┤  │
> │  │ 35m   │ buy  │ $783 │ 2.61K   │$2.05 │ EQCV…  │  │
> │  │ 45m   │ sell │ $525 │ 1.46K   │$0.77 │ EQBY…  │  │
> │  │ ...   │      │      │         │      │        │  │
> │  └───────┴──────┴──────┴─────────┴──────┴────────┘  │
> │  [Load older]                                       │
> └─────────────────────────────────────────────────────┘
> ```
>
> **Свечной график:** TradingView Lightweight Charts через CDN — `https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js`. Это бесплатная либа от TradingView (~50KB gzipped), идеально подходит, не требует билда, лицензия Apache-2.0.
>
> Зелёные/красные свечи, объёмы внизу, кросс-таргет.
>
> **Лента сделок:** обычная таблица, при получении нового события через WS — добавление сверху с анимацией fade-in. Цветовая разметка buy/sell как в табличке из примера (зелёный/красный).
>
> **Live indicator:** зелёная точка с пульсацией когда WS активен, серая если оборвалось.
>
> **Аутофоллоу:** опциональный тоггл — следить за последней сделкой (автоскролл вниз). По умолчанию — выключен после того как пользователь прокрутил.
>
> ### 5.2. Расширение существующей token-page
>
> На основной странице токена (там, где сейчас screening) — добавить блок:
>
> ```
> ┌─────────────────────────────────┐
> │ 📈 Trading                       │
> │ Listed on: DeDust ✓             │
> │ Price: $0.0021 (+12.5% 24h)     │
> │ [View live trades →]            │
> └─────────────────────────────────┘
> ```
>
> Если jetton не найден ни на DeDust ни на STON.fi:
>
> ```
> ┌─────────────────────────────────┐
> │ 📈 Trading                       │
> │ Not listed on tracked DEXes     │
> │ (DeDust, STON.fi)               │
> └─────────────────────────────────┘
> ```
>
> ### 5.3. Поиск
>
> В хедере (или где сейчас ввод адреса) — расширить:
>
> - Если введён валидный адрес TON — ведёт на token page (как сейчас).
> - Если введён текст — выпадающий dropdown с результатами поиска (тикер, имя, иконка).
> - Дополнительно — фильтр "только trading-доступные".
>
> Реализация — debounced fetch на `/api/search?q=...` после 300мс простоя ввода.
>
> ## 6. Источники данных и fallback'и
>
> | Что нужно            | Primary                                  | Fallback                                                  | Если оба упали                                       |
> | -------------------- | ---------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
> | Список пулов DeDust  | DeDust API `/v2/pools`                   | TonAPI (по known DeDust factory address)                  | Показать кешированный список                         |
> | История сделок       | DeDust API `/v2/pools/{addr}/trades`     | TonAPI `/v2/accounts/{pool}/events` с парсингом           | Показать локальную БД + предупреждение               |
> | Real-time            | TonAPI WebSocket                         | TonAPI SSE                                                | Отметить "live unavailable", только история          |
> | Цена в USD           | DeDust API price field                   | CoinGecko через jetton metadata                           | Без USD, только нативная цена                        |
> | Метаданные jetton    | TonAPI `/v2/jettons/{addr}`              | DeDust jetton info                                        | Из локальной БД                                      |
>
> Все upstream запросы — с таймаутом 10 сек, ретраем 1 раз с backoff. Все ошибки логируем, наружу — graceful error.
>
> ## 7. Конфигурация (`.env.example`)
>
> Добавить:
>
> ```env
> # DeDust integration
> DEDUST_API_URL=https://api.dedust.io/v2
> DEDUST_CACHE_TTL_SECONDS=300
>
> # STON.fi (detection only for now)
> STONFI_API_URL=https://api.ston.fi/v1
> STONFI_CACHE_TTL_SECONDS=300
>
> # Trading data
> TRADING_BACKFILL_LIMIT=500        # сколько сделок грузить при первом открытии
> TRADING_INCREMENT_LIMIT=200       # сколько грузить по "Load older"
> TRADING_MAX_WS_CLIENTS=100        # лимит одновременных подписчиков
>
> # WebSocket (TonAPI streaming)
> TONAPI_WS_URL=wss://tonapi.io/v2/websocket
> ```
>
> ## 8. Тесты
>
> Расширить существующий тест-сетап (если есть; если нет — простые smoke-тесты через `node:test`):
>
> - `tests/dex-detection.test.js` — для известного jetton DeDust возвращает primary pool.
> - `tests/dedust-client.test.js` — мок DeDust API, проверка парсинга ответа.
> - `tests/candle-builder.test.js` — синтетический массив сделок → корректные OHLCV.
> - `tests/trade-parser.test.js` — фикстура trace от TonAPI → корректная сделка.
> - `tests/api.trading.test.js` — supertest на эндпоинты, mock upstream.
>
> Покрытие — не обязательно высокое, важно покрыть критические пути (парсинг trace, построение свечей, fallback логику).
>
> ## 9. Документация
>
> Обновить:
>
> - Создать `docs/07-trading.md` с разделами: архитектура trading-фичи, поток данных, формат WS-сообщений, схема БД, как добавить новый DEX в будущем.
> - Обновить `docs/02-data-sources.md` — добавить DeDust API, STON.fi API.
> - Обновить `docs/05-api.md` — задокументировать новые эндпоинты `/api/trading/*` и `/api/search`.
> - Обновить `README.md` — добавить упоминание trading-фичи в описание.
> - Обновить `ROADMAP.md` — отметить Phase 1.5 (или вписать как новую секцию), вынести "STON.fi full integration" и "mempool listener" в Phase 2.
> - Обновить `TODO.md` — снять задачи из старого списка, добавить новые follow-ups.
> - Обновить `LASTCHANGES.md` — стандартная запись об изменении.
> - Обновить `CLAUDE.md` — упомянуть новые модули и где их искать.
>
> ## 10. Конкретный тестовый кейс
>
> Должно работать так:
>
> 1. Открыть `http://localhost:3031/explorer/`.
> 2. Ввести в поиск `EQDdd-YyeNBD0FvXWUZghbO4j7n9tqtAsvZWC2S22aGEjvHZ`.
> 3. Попасть на token page, в блоке Trading увидеть "Listed on: DeDust".
> 4. Нажать "View live trades" → попасть на `/explorer/trading/EQDdd-YyeNBD0Fv...`.
> 5. Через 2-3 секунды увидеть свечной график + ленту последних 500 сделок.
> 6. Live-индикатор горит зелёным.
> 7. Когда в блокчейне появится новая сделка по этому пулу — она автоматически появится сверху таблицы.
> 8. Переключение интервала свечей перестраивает график без перезагрузки страницы.
> 9. "Load older" догружает старые сделки.
>
> ## 11. Acceptance criteria
>
> - [ ] Запрос `EQDdd-YyeNBD0FvXWUZghbO4j7n9tqtAsvZWC2S22aGEjvHZ` корректно детектится как DeDust.
> - [ ] Trading-страница рендерится за < 3 сек на свежий jetton, < 1 сек на закэшированный.
> - [ ] WS-подписка работает, новые сделки появляются без перезагрузки.
> - [ ] Свечной график переключает интервалы 1m / 5m / 15m / 1h / 4h / 1d.
> - [ ] Если jetton не на DeDust — корректно показывается "not listed".
> - [ ] Все upstream-API имеют graceful fallback на локальную БД.
> - [ ] Никаких новых build-зависимостей (`npm install` не требует ничего тяжёлого).
> - [ ] Все тесты проходят (`npm test`).
> - [ ] Документация обновлена согласно п.9.
>
> ## 12. Не делать (anti-patterns)
>
> - Не вводи build step (webpack/vite/etc.).
> - Не подключай React/Vue/Svelte — vanilla JS.
> - Не строй сложные state-менеджеры; localStorage для UI-настроек хватит.
> - Не используй ORM — оставайся на raw SQL через `better-sqlite3` (или что у тебя сейчас).
> - Не добавляй новый процесс/сервис — всё в одном Express.
> - Не выноси TradingView Lightweight Charts в npm-зависимости — используй CDN тегом.
> - Не делай аутентификацию — публичный read-only сервис.
> - Не сохраняй `raw_trace_json` для всех сделок в SQLite (раздуется БД) — только для последних 100 на пул для дебага.
>
> ## 13. Стратегия реализации (по порядку для Claude Code)
>
> Чтобы PR не разросся до неподъёмного — разбить на коммиты в таком порядке, проверяя каждый шаг:
>
> 1. **Миграция БД** — добавить таблицы, тесты на миграцию.
> 2. **DeDust client + DEX detection** — модули с тестами, без интеграции в API.
> 3. **HTTP-эндпоинты** `/api/trading/:jetton/info` и `/trades` — рабочий backend без фронта, проверяем curl'ом.
> 4. **OHLCV/candles** — эндпоинт `/candles`, тесты на построение свечей.
> 5. **Frontend — статичная страница** — график + лента без WS, данные только из REST.
> 6. **WebSocket-стрим** — отдельный коммит, добавляем live-обновления.
> 7. **Поиск** — `/api/search` + UI dropdown.
> 8. **Интеграция в token page** — блок Trading на основной странице.
> 9. **STON.fi detection** — минимальное, только статус.
> 10. **Документация** — обновить все .md файлы.
>
> Каждый шаг — отдельный commit с понятным message в стиле, который уже принят в репо (посмотри в `git log`).

---

## Working-tree state at archive time

- `npm install ws --save` was run during pre-flight. `package.json` and `package-lock.json` were modified; `node_modules/ws` exists. Decision for the next session: either keep (ws is needed in step 6) or `npm uninstall ws` to start from a fully pristine tree. Either way, this is the only working-tree change from the pre-flight probe.
- Probe artifact `/tmp/pools.json` (24 MB DeDust pool list) exists but is outside the repo and will not persist across reboots.
- No other files were modified.
