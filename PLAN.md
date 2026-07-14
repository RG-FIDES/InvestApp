# InvestApp — v1 Implementation Plan

## 0. Summary of Decisions (from clarifying Q&A)
- **Symbol:** MU only (schema matches `backend.prompt.md` exactly).
- **Data feeds:** 1-min OHLCV bars + live Trades (last sales) + live Quotes (bid/ask).
- **Volume requirements (from your note):** expose (a) **current-time volume** = volume of the latest 1-min bar (and today's cumulative volume), and (b) **past-3-day volume** = total volume over last 3 trading days (the denominator used by the 3-day VWAP calc). Both surfaced via `/api/stats` and the live WS.
- **Alpaca:** Paper trading account + free market-data tier.
- **Backfill:** ~3 months of 1-min bars on first startup (REST). Trades/quotes are **live-only** (no historical backfill).
- **Repo:** Monorepo — `backend/` (FastAPI) + `frontend/` (Next.js).

## 1. Goals & Non-Goals
**Goals**
- Real-time MU tracking: price chart auto-updates **< 1 minute**; trades & quotes update sub-second.
- Decision-support stats: last price, current 1-min volume, today's cumulative volume, 3-day VWAP, 3-day total volume.
- Per-connection price alerts (no auth → alerts scoped to each WebSocket session).
- API-first backend, cleanly reusable by a future Android app.

**Non-Goals (v2+)**
- Authentication / multi-user.
- Portfolio management (README mentions it — deferred).
- Options data (Alpaca paid add-on + complex).
- Production hosting / true 24-7 deployment (architecture supports it; hosting is a later concern).

## 2. Architecture Overview
Single FastAPI process owns three concerns, all on one asyncio event loop:

```
                 Alpaca Paper WS (real-time)
                 (bars / trades / quotes for MU)
                          │
                          ▼
                   ingestion.py  (async callbacks)
                          │  DB insert (aiosqlite, WAL)
                          ▼
                   market_data.db (SQLite)
                          │  enqueue JSON
                          ▼
                asyncio.Queue  ──►  broadcaster task
                                          │  send_json to each client
                                          ▼
                                  Frontend WS clients
                          ▲                          │
                          │      REST /api/history   │
                    Next.js (React)  ◄───────────────┘  (seed chart on load)
```

- The **shadow DB** (SQLite) is the single source of truth; the frontend never calls Alpaca directly.
- Ingestion writes are decoupled from client broadcasts via an `asyncio.Queue`, so a slow/large client can never block the Alpaca stream or DB writes.

## 3. Data Model (SQLite — `market_data.db`)
Enable `PRAGMA journal_mode=WAL` for concurrent reads/writes.

**`mu_1min_bars`** (from spec — unchanged):
- `timestamp` DATETIME PRIMARY KEY
- `open` REAL, `high` REAL, `low` REAL, `close` REAL
- `volume` INTEGER

**`mu_trades`** (new — time & sales / "last solds"):
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `timestamp` DATETIME (indexed)
- `price` REAL, `size` INTEGER
- `exchange` TEXT, `condition` TEXT (optional, from Alpaca trade payload)

**`mu_quotes`** (new — bid/ask / "bills"):
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `timestamp` DATETIME (indexed)
- `bid` REAL, `ask` REAL, `bid_size` INTEGER, `ask_size` INTEGER

**Async query functions (`database.py`):**
- `insert_bar` / `insert_trade` / `insert_quote`
- `get_history_3mo()` → last 3 months of 1-min bars (for `/api/history`).
- `get_recent_trades(n)` / `get_recent_quotes(n)` → tape since session start.
- `get_3day_vwap_and_volume()` → returns `{ vwap, volume_3d, current_bar_volume, today_volume, last_close }` using:
  - `vwap = SUM(close*volume)/SUM(volume)` filtered to last 3 trading days.
  - `volume_3d = SUM(volume)` over same window.
  - `current_bar_volume` = volume of the most recent bar.
  - `today_volume = SUM(volume)` where `timestamp >= today's market open`.
- `get_latest_quote()` → current bid/ask.

## 4. Ingestion Daemon (`ingestion.py`)
- Use `alpaca-py`:
  - `from alpaca.data.live import StockDataStream`
  - `from alpaca.data.historical import StockHistoricalDataClient`
- `StockDataStream(api_key, secret_key)` → `subscribe_bars`, `subscribe_trades`, `subscribe_quotes` for `"MU"`.
- Async handlers:
  - `on_bar` → `await insert_bar(...)` → `await broadcast_queue.put({"type":"bar", ...})`
  - `on_trade` → insert + enqueue `{"type":"trade", ...}`
  - `on_quote` → insert + enqueue `{"type":"quote", ...}`
- **Backfill (startup only):** `StockHistoricalDataClient.get_stock_bars(StockBarsRequest(symbol="MU", timeframe=TimeFrame.Minute, start=~3mo_ago, end=now))`, chunked monthly with `next_page_token` pagination, bulk-inserted. Trades/quotes are NOT backfilled.
- Runs as a long-lived `asyncio` task started from FastAPI lifespan (shares the loop, never blocks the server).

## 5. FastAPI Server (`main.py`)
- **Lifespan startup:** (1) open DB + enable WAL, (2) run bar backfill, (3) start `ingestion` task, (4) start `broadcaster` task.
- **`GET /api/history`** → returns 3-month bars from SQLite (NOT Alpaca REST) as JSON to seed the chart.
- **`GET /api/stats`** → `{ last_price, vwap, volume_3d, current_bar_volume, today_volume, bid, ask }` (polling fallback + initial load).
- **`WS /ws/live`**:
  - On connect: register in `active_connections`.
  - Receives `{"action":"set_alert","price":X}` → store per-connection threshold in `connection_alerts[ws] = X`.
  - Broadcaster task drains `broadcast_queue` and `send_json` to every connection.
  - **Alert logic:** on each `bar` message, for every connection with a threshold, detect a cross of `last_close → close` vs threshold; on cross send `{"type":"alert","message":"Price crossed threshold!"}` (once per crossing).
  - On disconnect: remove from `active_connections` and `connection_alerts`.
- **CORS:** `CORSMiddleware` allowing `http://localhost:3000`.
- **Non-blocking guarantee:** ingestion callbacks only do fast DB inserts + queue `put`; the broadcaster task owns all client `send`s → WS broadcasts never stall the Alpaca stream.

## 6. Frontend (`frontend/` — Next.js App Router + React)
- **Charting:** `lightweight-charts` (TradingView) — candlestick series + volume histogram; `series.update(bar)` on each WS `bar` message for <1-min refresh.
- **State:** `zustand` (lightweight) or React Context holding: `bars` (seeded from REST), `trades` tape, `quotes`, `stats`, `alerts`.
- **Data layer:**
  - `lib/api.ts` — `fetch('/api/history')`, `fetch('/api/stats')`.
  - `lib/ws.ts` + `hooks/useMarketData.ts` — connect to `ws://localhost:8000/ws/live`, auto-reconnect, parse `bar/trade/quote/alert` messages, update store. On mount, seed chart via REST then switch to live.
- **Components:**
  - `PriceChart.tsx` (candles + volume)
  - `TradesTape.tsx` (last sales, sub-second)
  - `QuotesPanel.tsx` (bid/ask/spread + last)
  - `StatsBar.tsx` (price, current volume, 3-day VWAP, 3-day volume)
  - `AlertControl.tsx` (set threshold, show alert banner)
- **Env:** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` (default localhost:8000).
- **No auth** (as specified).

## 7. Monorepo Layout
```
InvestApp/
├─ backend/
│  ├─ main.py            # FastAPI app, REST + WS, lifespan
│  ├─ database.py        # schema, async queries, VWAP/volume
│  ├─ ingestion.py       # Alpaca WS daemon + backfill
│  ├─ requirements.txt   # fastapi, uvicorn, aiosqlite, alpaca-py, pydantic
│  └─ .env.example       # ALPACA_API_KEY, ALPACA_SECRET_KEY
├─ frontend/
│  ├─ package.json
│  ├─ next.config.js
│  └─ app/
│     ├─ page.tsx
│     ├─ components/  (PriceChart, TradesTape, QuotesPanel, StatsBar, AlertControl)
│     ├─ hooks/useMarketData.ts
│     └─ lib/  (api.ts, ws.ts)
├─ README.md             # updated with run instructions
├─ .gitignore            # venv/, .env, market_data.db, node_modules/
└─ LICENSE
```

## 8. Latency Strategy (meets <1 minute)
- **Bars:** Alpaca emits a 1-min bar at each minute boundary → pushed to frontend within ~1s of close → chart updates **< 60s** old. ✅
- **Trades/Quotes:** streamed in real-time (sub-second) → tapes/panels update instantly. ✅
- **Decoupling:** `asyncio.Queue` + dedicated broadcaster means a slow client or large `send` batch never delays ingestion or DB writes.

## 9. Milestones (ordered)
- **M1 — DB layer:** `database.py` with schema + all query/VWAP functions; quick local sanity test.
- **M2 — Ingestion + backfill:** `ingestion.py` connects to paper WS, writes bars/trades/quotes; 3-month bar backfill with pagination.
- **M3 — FastAPI:** lifespan (backfill + spawn ingestion + broadcaster), `/api/history`, `/api/stats`, `/ws/live` with per-connection alerts, CORS.
- **M4 — Frontend:** Next.js scaffold + chart + tapes + stats + alert UI; wire REST seed + WS live.
- **M5 — End-to-end verify (paper):** confirm <1-min chart refresh, sub-second tapes, alert fires on cross; check logs/errors.
- **M6 — Polish:** README run commands, `.env.example`, `.gitignore`, logging & basic error handling.

## 10. Key Risks / Assumptions
- **Alpaca data entitlement:** assumes the paper account provides real-time US-equity WS + historical bars at no cost. *Verify in Alpaca dashboard; if real-time is off, enable Alpaca's free market-data add-on (or a paid sub).* The WebSocket is what delivers real-time; REST is used only for the one-time backfill.
- **Trades/quotes live-only:** tape reflects the session since app start (no 3-month trade/quote history). If historical tape is needed later, that's a paid/large effort → v2.
- **SQLite at scale:** WAL mode handles concurrent reads; for a single symbol this is plenty. If multi-symbol or heavy querying arrives, migrate to Postgres (schema is already SQL-portable).
- **24/7 shadow DB:** requires the backend process to stay running on an always-on host. v1 can run locally (`uvicorn`); production hosting is a later step.
- **Windows env:** use `python -m venv .venv` + `.venv\Scripts\Activate.ps1`; asyncio/uvicorn handle the Windows event loop.
- **Key safety:** keys in `.env` (gitignored), never committed.

## 11. How to Run
**Backend** (PowerShell from repo root):
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# copy .env.example -> .env and fill ALPACA_API_KEY / ALPACA_SECRET_KEY
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```
**Frontend:**
```powershell
cd frontend
npm install
npm run dev   # http://localhost:3000
```

## 12. Next Step
Once you approve, I'll start at **M1 (database.py)**. Tell me if you want to adjust scope (e.g., add a `symbol` column now for future multi-stock, or defer trades/quotes to a later milestone).
