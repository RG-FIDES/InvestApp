# AGENTS.md — InvestApp

## Repo layout

```
backend/   FastAPI (Python 3.11+) + aiosqlite + Yahoo Finance feed
frontend/  Next.js 14 App Router + lightweight-charts + Zustand
```

## Backend (backend/)

Run: `cd backend; uvicorn main:app --reload --port 8000`

- Data source is **Yahoo Finance keyless chart API** (`feed.py`). Do NOT
  reference Alpaca/Alpaca SDK in code changes — those docs are stale (`PLAN.md`,
  `backend.prompt.md`). No API key required to run.
- `market_data.db` (SQLite, WAL mode) is the single source of truth.
  `db.py` **drops and recreates** all tables on init for schema freshness.
- The `broadcast_queue` (asyncio.Queue) decouples feed writes from WebSocket
  sends. Broadcaster task owns all `send_json`; feed only does fast inserts +
  `queue.put`. Never bypass this pattern.
- Symbol is runtime-switchable: `POST /api/symbol` → `feed.switch_symbol()`.
  `SYMBOL`, `MARKET`, `FRONTEND_ORIGIN`, `DATABASE_PATH` are env-driven
  (`config.py`).
- REST endpoints: `/api/quote`, `/api/history?range=1D|5D|1M|6M|YTD|1Y&interval=...`,
  `/api/market-status`, `/api/markets`, `/api/symbol`, `/api/search`
- WebSocket: `/ws/live` — sends `quote`, `bar`, `trade`, `alert`,
  `notification`, `custom_alert`, `symbol_changed`, `snapshot` messages.

## Tests (backend/)

Plain Python scripts — **not pytest**. Each test isolates its DB using a
temp file. Critical: set `MARKET_DB_PATH` **before** importing `main` or
`database` so the module-level init uses the temp path.

```powershell
cd backend
.\.venv\Scripts\python.exe test_database.py   # VWAP math + DB layer
.\.venv\Scripts\python.exe test_server.py      # REST + WS snapshot smoke
.\.venv\Scripts\python.exe test_e2e.py         # full pipeline + alerts
```

## Frontend (frontend/)

Run: `cd frontend; npm run dev` (http://localhost:3000)

- Env vars (in `.env.local`): `NEXT_PUBLIC_API_URL` (default
  `http://localhost:8000`), `NEXT_PUBLIC_WS_URL` (default
  `ws://localhost:8000`).
- **`reactStrictMode: false`** in `next.config.mjs` is intentional — it
  prevents the WS hook from double-mounting in dev. Do not change without
  updating `useMarketData.ts`.
- State is a monolithic Zustand store at `app/lib/store.ts` (quotes, bars,
  trades, notifications, multi-stock tracking, search, settings).
- Type alias path: `app/lib/types.ts` — `@/*` resolves to project root via
  tsconfig `paths`.

## Setup

```powershell
# Backend
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env   # no secrets needed — Yahoo keyless
uvicorn main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend
npm install
copy .env.local.example .env.local
npm run dev
```

## Gotchas

- `develop.md` references `/api/stats` — that endpoint was renamed to
  `/api/quote` in the rebuilt backend. Use the live code (`main.py`) as source
  of truth.
- No Alpaca/free-tier market data add-on needed — the backend uses Yahoo
  Finance entirely. The `FIONNHUB_API_KEY` in `.env.example` is for an
  alternate feed not yet wired up.
- Do not commit `.env` files or `market_data.db`.
