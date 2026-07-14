# InvestApp

Real-time tracker for **MU** (Micron) stock — auto-updating 1-minute price chart
(<1 min latency), live time-&-sales tape, NBBO bid/ask, and decision-support
stats (last price, 3-day VWAP, current / today / 3-day volume). Includes
per-connection price alerts.

> Built per [`PLAN.md`](./PLAN.md). Backend = FastAPI + SQLite (shadow DB) +
> Alpaca Markets (paper + free data tier). Frontend = Next.js (React) +
> TradingView `lightweight-charts`.

## Architecture

```
Alpaca Paper WS (bars / trades / quotes, MU)
        │
        ▼
ingestion.py ──► SQLite market_data.db (WAL) ──► asyncio.Queue
                                                  │
                                          broadcaster task ──► WebSocket clients
                                                  ▲
Frontend (Next.js) ── GET /api/history, /api/stats ┘
```

The SQLite DB is the single source of truth; the frontend never calls Alpaca
directly. Ingestion writes are decoupled from client broadcasts via a queue, so
a slow client can never stall the market feed.

## Monorepo layout

```
InvestApp/
├─ backend/   FastAPI: database.py, ingestion.py, main.py, tests
├─ frontend/  Next.js: app/ (components, hooks, lib)
└─ PLAN.md    implementation plan
```

## Prerequisites

- Python 3.11+ (standard CPython; MSYS2/ucrt builds can hit SSL/ABI issues)
- Node.js 18+ and npm
- A free [Alpaca](https://alpaca.markets/) paper-trading account + API keys
  (enable the free market-data add-on for real-time quotes/trades)

## Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1        # Windows; on bash: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env               # then fill ALPACA_API_KEY / ALPACA_SECRET_KEY
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Endpoints:

| Method | Path          | Purpose                                              |
|--------|---------------|------------------------------------------------------|
| GET    | `/api/history`| 3-month 1-min bars (seeds the chart)                 |
| GET    | `/api/stats`  | last price, 3-day VWAP, volumes, bid/ask             |
| WS     | `/ws/live`    | bar/trade/quote stream + `set_alert` messages        |
| GET    | `/health`     | liveness                                            |

### Tests (no Alpaca keys required)

```powershell
.\.venv\Scripts\python.exe test_database.py   # DB + VWAP math
.\.venv\Scripts\python.exe test_server.py      # REST + WS snapshot smoke
.\.venv\Scripts\python.exe test_e2e.py         # full pipeline + alert crossing
```

## Frontend

```powershell
cd frontend
npm install
copy .env.local.example .env.local             # defaults point at localhost:8000
npm run dev                                    # http://localhost:3000
```

Open http://localhost:3000 — the chart seeds from `/api/history`, then live
updates arrive over `/ws/live`. Set a price alert in the side panel; the banner
fires once when the price crosses your threshold.

## Notes / limitations

- **MU only** in v1. The schema is SQL-portable if you later add a `symbol`
  column and multi-stock support.
- **Trades/quotes are live-only** (no historical backfill) — the tape reflects
  the session since the backend started.
- **No auth** in v1; alerts are scoped per WebSocket connection.
- **Windows**: use the standard `python`/`venv` workflow. If `pip install`
  fails with SSL/`CERTIFICATE_VERIFY_FAILED`, you are likely on an MSYS2 Python;
  switch to a standard CPython (e.g. via `py -V:Astral\CPython3.11.15`).
  Alpaca's SDK pulls in `pandas`/`numpy`; if those fail to load due to an
  Application Control policy, the REST/WebSocket server still runs (ingestion
  no-ops) — only the live feed is unavailable.

