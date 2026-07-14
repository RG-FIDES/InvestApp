# InvestApp Runtime Notes (Yahoo Finance feed)

## Server / port conflict (IMPORTANT)
- There are TWO uvicorn servers that both try to bind port 8000 in this environment:
  1. The user's backend venv: `c:\Github\InvestApp\backend\.venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload --app-dir c:\Github\InvestApp\backend`
  2. A `hermes-agent` venv that ALSO runs `main:app` from the same folder: `C:\Users\muaro\AppData\Local\hermes\hermes-agent\venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8000 --reload --app-dir c:\Github\InvestApp\backend`
- They fight over port 8000 and cause the browser WS `ERR_CONNECTION_REFUSED` (server churn).
- Resolution: ensure ONLY ONE is running. Kill the duplicate tree, verify a single LISTENER on :8000 via `Get-NetTCPConnection -LocalPort 8000`.

## Market-hours behavior (EXPECTED, not a bug)
- PRIMARY feed is now Yahoo Finance (keyless chart API), see `backend/yahoo.py`.
  - `run_yahoo_feed(queue, interval=15.0)` fetches `query1.finance.yahoo.com/v8/finance/chart/MU?range=1d&interval=1m` every 15s, upserts the current 1-min bar, and pushes quote/trade/bar messages. => >=4 price updates/min (satisfies "updated >=2x under 60s").
  - `seed_yahoo_history()` backfills today's 1-min bars at startup so the chart matches finance.yahoo.com from first render.
  - Demo mode (`demo.py`) is only a FALLBACK if the Yahoo seed fails at startup.
- Yahoo `regularMarketPrice` updates through pre/post/regular sessions, so the app now shows ACTUAL MU prices matching finance.yahoo.com even outside regular hours.
- Verified live: PRICE=937.0, PREV_CLOSE=979.3, 390 intraday bars returned (2026-07-14).

## New endpoints (added for 3-month history + market-closed UX)
- `GET /api/market-status` → `{"is_open": bool, "reason": str, "as_of": UTC ISO, "local_time_et": ET ISO}`.
  - `ingestion.market_open_now()` computes US/Eastern (dependency-free DST), Mon-Fri 09:30–16:00 ET. Holidays NOT accounted for (v1 simplification).
  - Also exposed as `stats.market_open` in `/api/stats` and the WS snapshot.
- `GET /api/history/daily?months=3` → list of daily OHLCV Bars (timestamp = 'YYYY-MM-DD'), oldest→newest.
  - Source: Stooq (`stooq.com/q/d/l/?s=mu.us&i=d`) primary, Yahoo Finance chart API fallback. Both keyless/free.
  - Cached 1h in `ingestion._HISTORY_CACHE`. Returns `[]` gracefully if both upstreams fail.
  - Frontend: `fetchDailyHistory()` → store `dailyBars` → PriceChart renders it as the base layer, appending live 1-min bars when present (drops today's daily candle to avoid dup). So the chart is NEVER empty (shows 3-mo history when market closed).

## Frontend market-closed UX
- Badge in header: `MARKET OPEN` (green) / `MARKET CLOSED` (red) from `store.marketStatus` (polled every 60s via `/api/market-status`, also seeded from WS snapshot `stats.market_open`).
- When closed, a note appears under the chart: "Market is closed — showing MU's last 3 months of price history…".
- NData-source notes
- PRIMARY: Yahoo Finance chart API (`backend/yahoo.py`), keyless. Price + 1-min intraday bars match finance.yahoo.com exactly.
- FALLBACK (startup seed only): `demo.py` offline simulator if Yahoo seed fails.
- `GET /api/history/daily` (3-mo daily history) still sourced from Stooq/Yahoo as before.
- `stats.market_open` + `/api/market-status` still use `ingestion.market_open_now()` (regular 9:30–16:00 ET only). Pre/post visibility is handled on the frontend by MarketCountdown + getMarketSession(
- Historical 1-min candles (`/stock/candle`) and live NBBO (`/stock/bidask`): PREMIUM → NOT available.
- Therefore: bars are aggregated from live trades; bid/ask is trade-derived (spread 0.00). Chart starts EMPTY (no backfill).
