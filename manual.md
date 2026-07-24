# InvestApp Manual

## 1. Introduction

InvestApp is a real-time stock market tracking web application focused on Micron Technology (MU) by default, with full support for any stock on any registered market. It provides live price updates, interactive charting, NBBO (bid/ask) tracking, trade tape, and fundamental statistics including prior close, pre-market / after-hours prices, P/E ratio, market capitalization, percentage change, and moving-average volume.

The application aggregates actual market data from the Yahoo Finance Keyless Chart API and presents it through a main chart section and a statistics dashboard. It is designed for traders and investors who need continuous, low-latency market visibility without requiring an API key.

---

## 2. Backend

### 2.1 Technology Stack
The backend is written in **Python** using **FastAPI** with **uvicorn** as the ASGI server. It uses **aiosqlite** for asynchronous SQLite persistence, **requests** for outbound HTTP calls to Yahoo Finance, and **websockets** for the optional Finnhub real-time trade feed.

### 2.2 Data Source
The backend uses a **hybrid free data model**:
- **Yahoo Finance Keyless Chart API** (`query1.finance.yahoo.com`) — primary source for price, intraday bars (1-minute OHLCV), daily history (~1 year), volume, and market state. Polled every **3 seconds** (~20 updates per minute).
- **Finnhub WebSocket** (`ws.finnhub.io`) — optional real-time trade prints for the time & sales tape when a free-tier API key is configured via `FINNHUB_API_KEY`. US equities only on the free tier.
- **Stooq** (`stooq.com`) — fallback daily historical data when Yahoo fails.

The Yahoo feed and Finnhub tape run as independent background tasks, both writing to SQLite and pushing onto the same broadcast queue.

### 2.3 Supported Markets & Symbols
The app is market-agnostic. It ships with the following markets pre-registered in `config.py`:
- **US** — NasdaqGS (default, USD)
- **TSE** — Tokyo Stock Exchange (JPY)
- **LSE** — London Stock Exchange (GBP)

Any equity or ETF symbol can be tracked at runtime via `POST /api/symbol`.

### 2.4 Data Storage
`market_data.db` (SQLite, WAL mode) is the single source of truth. Three tables persist data:
- **mu_bars** — 1-minute OHLCV candles (keyed by symbol + timestamp).
- **mu_quotes** — Latest quote snapshots each tick (price, change, prevClose, open, dayHigh, dayLow, bid, ask, volume, marketState).
- **mu_trades** — Live trade prints for the time & sales tape.

The database is fully regenerated on startup (`db.py` drops and recreates tables on init) to guarantee schema freshness.

### 2.5 REST API Endpoints
| Endpoint | Method | Description |
|---|---|---|
| `/api/quote` | GET | Full quote snapshot: price, change, P/E, EPS, beta, dividend, market cap, 52-week range, 3d/3m averages, bid/ask, volume, market state. |
| `/api/history` | GET | Bar data for the chart. Supports `range=1D|5D|1M|6M|YTD|1Y` and `interval=1m|5m|15m|30m|1h|4h|1d`. |
| `/api/market-status` | GET | Current market open/closed state and session label (PRE / REGULAR / POST / CLOSED). |
| `/api/markets` | GET | List of registered markets with display name, currency, timezone, city, and flag. |
| `/api/symbol` | GET / POST | Get current tracked symbol or switch to a new one at runtime. |
| `/api/search` | GET | Search Yahoo Finance for symbols matching a query (equities and ETFs). |

### 2.6 WebSocket — `/ws/live`
Real-time streaming is handled via a single WebSocket endpoint. On connection, clients receive an initial `snapshot` (current quote + recent trades), then live messages:

- **quote** — Updated price, change, bid/ask, volume, marketState every poll tick.
- **bar** — New or updated intraday OHLCV bar.
- **trade** — Real-time last-sale prints. When `FINNHUB_API_KEY` is configured, genuine tick-level trades are streamed via the Finnhub WebSocket. Without a key, trades are derived from fresh 1-minute Yahoo bars.
- **alert** — Legacy simple price-threshold alert.
- **notification** — System-level events (day high/low broken, volume spike, market-state transition, percent move from open).
- **custom_alert** — User-defined conditional alerts (price above/below, day high/low break, volume spike, percent move, market state).
- **symbol_changed** — Broadcast when the tracked symbol is switched.

A **broadcaster task** owns all `send_json` operations. The feed only performs fast inserts and `queue.put`, so a slow client can never block the Yahoo feed or database writes.

### 2.7 Alerts & Notifications
The backend evaluates three notification layers on every quote tick:
1. **Simple price alerts** — Crosses a fixed threshold relative to the previous close.
2. **System notifications** — Day high/low broken, volume spike (≥3× recent EMA), market-state transitions (PRE → REGULAR → POST → CLOSED), and percent moves from open (±2%, ±5%).
3. **Custom notifications** — Per-connection rules supporting price above/below, day high/low broken, volume spike, percent move up/down, and specific market-state conditions, with `once` or `every` repeat behavior.

### 2.8 History & Calculations
- **1-year daily history** is fetched from Yahoo (`range=1y, interval=1d`) and cached for 1 hour.
- **52-week high/low** are computed from the last 252 daily bars.
- **Average volume** — 52-week average and 3-day / 3-month averages are calculated from completed daily bars (excluding the in-progress session).
- **Average price** — 3-day and 3-month closing-price averages.
- **Market cap** — Computed live as `price × shares outstanding`.
- **P/E, EPS, beta, dividend, target, performance** — Hard-coded for MU in `fundamentals.py`; fetched dynamically via Yahoo `quoteSummary` for non-default symbols.

### 2.9 Pre-Market / After-Hours
When the market is closed or in extended hours, the app displays the last available regular-session close and, if available, the most recent pre-market or after-hours price via Yahoo’s `includePrePost=true` extended-hours bars.

---

## 3. Frontend

### 3.1 Technology Stack
The frontend is built with **Next.js 14** (App Router), **React 18**, **TypeScript**, and **Zustand** for state management. It communicates with the backend through REST and WebSocket.

### 3.2 Charting
Interactive charts are rendered using **lightweight-charts** (TradingView’s open-source library). This is a client-side React component; the backend does not render charts.

### 3.3 Architecture
- **Monolithic Zustand store** (`app/lib/store.ts`) manages quotes, bars, trades, notifications, multi-stock tracking, search, and settings.
- **WebSocket hook** (`app/hooks/useMarketData.ts`) maintains the live connection and dispatches incoming messages into the store.
- **Market hours logic** (`app/lib/marketHours.ts`) determines session state for UI badges and indicators.
- **Formatting utilities** (`app/lib/format.ts`) handle currency, percentage, and volume display.

### 3.4 Key UI Components
- **QuoteHeader** — Symbol, exchange, price, change, percent change, market state badge.
- **PriceChart** — lightweight-charts area/bar series with range and interval controls.
- **KeyStats** — P/E, EPS, market cap, beta, dividend, 52-week range, averages.
- **NbboPanel** — Bid, ask, bid size, ask size.
- **TradesTape** — Time & sales feed.
- **Watchlist** — Multi-symbol tracking.
- **AlertsPanel / NotificationToast** — User-defined alerts and system notifications.
- **TopBar** — Symbol search and market switching.
- **ComparisonPanel** — Side-by-side performance vs benchmark.
- **OverviewPanel** — Sector, industry, employees, description.

---

## 4. Summary of Features

| Feature | Details |
|---|---|
| Live Price | Updated every 3 seconds via Yahoo Finance Keyless Chart API |
| Intraday Chart | 1D / 5D / 1M ranges with 1m–4h interval aggregation |
| Daily History | ~1 year of daily bars (Yahoo primary, Stooq fallback) |
| Bid / Ask | Synthetic NBBO spread computed from price |
| Trade Tape | Derived from 1-minute bar closes; stops naturally when closed |
| Volume Stats | Current, 52-week average, 3-day average, 3-month average |
| Pre-Market / After-Hours | Shown via Yahoo extended-hours bars |
| Previous Close | Tracked and displayed with change/percent change |
| Fundamentals | P/E, EPS, beta, dividend, market cap, target, sector, industry |
| 52-Week Range | High and low from daily history |
| Performance | YTD and multi-year return vs S&P 500 benchmark |
| Alerts | Price threshold, day high/low break, volume spike, percent move, market state |
| Custom Notifications | User-defined rules with repeat control |
| Symbol Search | Yahoo Finance search for equities and ETFs |
| Runtime Symbol Switch | `POST /api/symbol` re-seeds history and broadcasts change |
| Multi-Market | Configurable timezone, currency, and display name per market |

---

## 5. Correction Notes

The following statements from the original draft were inaccurate and have been corrected in this manual:

1. **Charting library** — `lightweight-charts` is used on the **frontend** (Next.js), not the backend. The backend is a FastAPI data server.
2. **Bid/ask source** — The free Yahoo chart API does not expose true bid/ask. The application computes a **synthetic spread** for display purposes.
3. **Volume averages** — The application does not snapshot average volume every 3 seconds. It fetches a fresh price/intraday snapshot every 3 seconds, while volume averages are computed from historical daily bars.
4. **Market support** — While the architecture supports any market, only **US (NasdaqGS)**, **TSE**, and **LSE** are currently registered and configured.
5. **Grammar / typos** — Fixed multiple misspellings (e.g., "stokes" → "stocks", "companys" → "companies", "1 yer" → "1 year", "percantege" → "percentage", "ration" → "ratio").
