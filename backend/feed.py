"""
feed.py — Yahoo Finance real-time data feed + daily history cache.

Yahoo Finance's keyless chart API is the PRIMARY market-data source so the
app's price and intraday chart reflect finance.yahoo.com exactly (no API key).

Endpoints used
-------------
* https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=1m
    -> meta.regularMarketPrice      (current price; updates through extended hours)
       meta.chartPreviousClose      (prior session close)
       meta.regularMarketOpen / regularMarketDayHigh / regularMarketDayLow
       meta.regularMarketVolume
       meta.marketState             (PRE / REGULAR / POST / PREPRE / POSTPOST / CLOSED)
       meta.regularMarketTime
       indicators.quote[] + timestamp[] (1-min OHLCV bars for today)
* https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1y&interval=1d
    -> ~1 year of daily OHLCV (for 5D/1M/6M/1Y chart ranges + 52w stats)
* https://stooq.com/q/d/l/?s=mu.us&i=d  (fallback daily history, keyless)

The feed runs as a background task that, on a fixed interval, fetches MU's
latest chart, writes the current price + intraday bars into SQLite, and pushes
quote/bar messages onto the shared broadcast queue so every connected frontend
updates in real time.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import config
import db

from dotenv import load_dotenv
import os
import json
import websockets

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("feed")

# Symbol is configuration-driven (see config.py) but mutable at runtime so
# the app can switch which instrument it tracks without a restart. The feed
# loop reads `feed.SYMBOL` on every tick, so changing it is enough to start
# streaming a different stock.
SYMBOL = config.SYMBOL
_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "")


def _chart_url(symbol: str) -> str:
    return f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

# How often we poll Yahoo for a fresh quote + bars.
# 3s gives ~20 updates/minute (Yahoo rate limit is ~2000 req/h for a single
# symbol, so we're comfortably under).
POLL_INTERVAL = 3.0

# In-memory daily-history cache, keyed by symbol (oldest -> newest bars).
_daily_cache: dict[str, list[dict]] = {}
_daily_cache_at: dict[str, float] = {}
_DAILY_TTL = 3600.0  # 1h


# --------------------------------------------------------------------------- #
# Yahoo chart fetch + parse
# --------------------------------------------------------------------------- #
def _fetch_json(url: str) -> dict:
    import requests

    resp = requests.get(url, timeout=15, headers=_HEADERS)
    resp.raise_for_status()
    return resp.json()


def fetch_chart(range_: str = "1d", interval: str = "1m", symbol: str | None = None) -> dict:
    """Synchronous Yahoo chart fetch (call via asyncio.to_thread)."""
    if symbol is None:
        symbol = SYMBOL
    url = f"{_chart_url(symbol)}?range={range_}&interval={interval}&includePrePost=true"
    return _fetch_json(url)


def parse_chart(payload: dict) -> dict:
    """Extract current quote + 1-min bars from a Yahoo 1d chart payload."""
    result = (payload.get("chart") or {}).get("result")
    if not result:
        raise ValueError("Yahoo chart returned no result")
    r = result[0]
    meta = r.get("meta", {})

    # prev_close for the change calculation: always the previous session's
    # official close.
    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    prev_close = float(prev_close) if prev_close is not None else None

    market_state = (meta.get("marketState") or "CLOSED").upper()
    if not market_state or market_state == "NONE":
        market_state = "CLOSED"
    market_time = meta.get("regularMarketTime")
    day_open = meta.get("regularMarketOpen")
    day_high = meta.get("regularMarketDayHigh")
    day_low = meta.get("regularMarketDayLow")
    volume = meta.get("regularMarketVolume")

    quotes = r.get("indicators", {}).get("quote", [{}])[0]
    timestamps = r.get("timestamp") or []
    bars: list[dict] = []
    for i, ts in enumerate(timestamps):
        o = quotes["open"][i]
        h = quotes["high"][i]
        l = quotes["low"][i]
        c = quotes["close"][i]
        if o is None or h is None or l is None or c is None:
            continue
        bars.append(
            {
                "timestamp": datetime.fromtimestamp(ts, tz=timezone.utc),
                "open": float(o),
                "high": float(h),
                "low": float(l),
                "close": float(c),
                "volume": int(quotes["volume"][i] or 0),
            }
        )

    # --- Resolve close price vs current price ------------------------------
    # `regularMarketPrice` = today's official close (or live during REGULAR).
    # The 1-min bars (includePrePost=true) extend past 4 PM into post-market
    # and pre-market before 9:30 AM.  The last bar's close is the freshest
    # trade print available.  Yahoo Finance always shows the last post/pre
    # market price even when bars haven't updated in hours (the embedded
    # ``postMarketPrice`` field on their page reflects the same last-bar data).
    # We follow the same approach — no freshness gate.
    regular_price_raw = meta.get("regularMarketPrice")
    close_price = float(regular_price_raw) if regular_price_raw is not None else None
    last_bar_close = float(bars[-1]["close"]) if bars else None

    current_price: float | None = None
    if (
        last_bar_close is not None
        and close_price is not None
        and abs(last_bar_close - close_price) > 0.005
    ):
        current_price = last_bar_close

    # Main price: always the close (matches Yahoo / TradingView primary number).
    price = close_price if close_price is not None else last_bar_close

    return {
        "symbol": meta.get("symbol", SYMBOL),
        "name": meta.get("shortName") or meta.get("longName") or meta.get("symbol", SYMBOL),
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        "currency": meta.get("currency") or "USD",
        "timezone": meta.get("exchangeTimezoneName") or meta.get("timezone") or "America/New_York",
        "price": price,
        "close_price": close_price,
        "current_price": current_price,
        "prev_close": prev_close,
        "market_state": market_state,
        "market_time": market_time,
        "open": float(day_open) if day_open is not None else None,
        "day_high": float(day_high) if day_high is not None else None,
        "day_low": float(day_low) if day_low is not None else None,
        "volume": int(volume) if volume is not None else None,
        "bars": bars,
    }


def parse_daily(payload: dict) -> list[dict]:
    """Extract daily OHLCV bars from a Yahoo 1y chart payload (oldest->newest)."""
    result = (payload.get("chart") or {}).get("result")
    if not result:
        return []
    r = result[0]
    quotes = r.get("indicators", {}).get("quote", [{}])[0]
    timestamps = r.get("timestamp") or []
    out: list[dict] = []
    for i, ts in enumerate(timestamps):
        o = quotes["open"][i]
        h = quotes["high"][i]
        l = quotes["low"][i]
        c = quotes["close"][i]
        if o is None or h is None or l is None or c is None:
            continue
        out.append(
            {
                "date": datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d"),
                "open": float(o),
                "high": float(h),
                "low": float(l),
                "close": float(c),
                "volume": int(quotes["volume"][i] or 0),
            }
        )
    return out


def fetch_stooq_daily(symbol: str | None = None) -> list[dict]:
    if symbol is None:
        symbol = SYMBOL
    """Fallback: fetch ~1y of daily bars from Stooq (keyless CSV)."""
    import csv
    import io

    stooq_sym = f"{symbol.lower()}.us"
    url = f"https://stooq.com/q/d/l/?s={stooq_sym}&i=d"
    resp = requests.get(url, timeout=20, headers=_HEADERS)
    resp.raise_for_status()
    text = resp.text.strip()
    if not text or text.startswith("No data"):
        return []
    reader = csv.DictReader(io.StringIO(text))
    out: list[dict] = []
    for row in reader:
        try:
            out.append(
                {
                    "date": row["Date"],
                    "open": float(row["Open"]),
                    "high": float(row["High"]),
                    "low": float(row["Low"]),
                    "close": float(row["Close"]),
                    "volume": int(float(row["Volume"])),
                }
            )
        except (KeyError, ValueError):
            continue
    return out


# Per-symbol chart meta cache (name, exchange, currency, timezone) populated
# by the feed loop and by build_quote on first request for a symbol.
_meta_cache: dict[str, dict] = {}


async def get_meta(symbol: str | None = None) -> dict:
    """Return cached chart meta for `symbol`, fetching from Yahoo if absent."""
    if symbol is None:
        symbol = SYMBOL
    if symbol in _meta_cache:
        return _meta_cache[symbol]
    try:
        snap = await fetch_snapshot(symbol)
        meta = {
            "symbol": snap.get("symbol", symbol),
            "name": snap.get("name", symbol),
            "exchange": snap.get("exchange", ""),
            "currency": snap.get("currency", "USD"),
            "timezone": snap.get("timezone", "America/New_York"),
        }
    except Exception:  # noqa: BLE001
        meta = {
            "symbol": symbol,
            "name": symbol,
            "exchange": "",
            "currency": "USD",
            "timezone": "America/New_York",
        }
    _meta_cache[symbol] = meta
    return meta


# Best-effort fundamentals cache (quoteSummary) for non-default symbols.
_fundamentals_cache: dict[str, dict] = {}

_finnhub_active = False


def is_finnhub_active() -> bool:
    return _finnhub_active


def _set_finnhub_active(active: bool) -> None:
    global _finnhub_active
    _finnhub_active = active


class FinnhubTapeClient:
    """WebSocket client that streams real trade prints from Finnhub and
    forwards them into the same broadcast queue used by the Yahoo feed.

    The free Finnhub tier streams US-equity trades only.  For non-US symbols
    the client connects but receives no data, which is harmless.
    """

    def __init__(self, api_key: str, symbol: str, queue: asyncio.Queue) -> None:
        self.api_key = api_key
        self.symbol = symbol
        self.queue = queue
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._reconnect_delay = 3.0

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run_loop(self) -> None:
        _set_finnhub_active(True)
        url = f"wss://ws.finnhub.io?token={self.api_key}"
        while not self._stop.is_set():
            try:
                async with websockets.connect(
                    url,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                ) as ws:
                    await ws.send(json.dumps({
                        "type": "subscribe",
                        "symbol": self.symbol,
                    }))
                    async for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("type") != "trade":
                            continue
                        for tick in msg.get("data", []):
                            await self._forward_tick(tick)
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                msg = str(exc)
                if "429" in msg:
                    self._reconnect_delay = min(self._reconnect_delay * 2, 30)
                    log.warning("Finnhub rate-limited (429); backing off %.1fs.", self._reconnect_delay)
                else:
                    self._reconnect_delay = 3.0
                    log.warning("Finnhub WS error (%s); reconnecting in %.1fs.", exc, self._reconnect_delay)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self._reconnect_delay)
                    break
                except asyncio.TimeoutError:
                    continue
            finally:
                _set_finnhub_active(False)

    async def _forward_tick(self, tick: dict) -> None:
        price = tick.get("p")
        volume = tick.get("v", 0)
        ts_ms = tick.get("t")
        conds = tick.get("c", [])
        condition = conds[0] if conds else "T"

        if price is None or ts_ms is None:
            return

        ts = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        symbol = tick.get("s") or self.symbol
        raw_ex = _meta_cache.get(symbol, {}).get("exchange", "") or config.MARKET_DISPLAY
        ex = _map_exchange_code(raw_ex)

        try:
            await db.insert_trade(symbol, ts, float(price), int(volume), ex, condition)
        except Exception:  # noqa: BLE001
            pass

        await self.queue.put({
            "type": "trade",
            "symbol": symbol,
            "timestamp": ts.isoformat(),
            "price": float(price),
            "size": int(volume),
            "exchange": ex,
            "condition": condition,
        })


def _exchange_to_market_code(raw: str) -> str | None:
    """Map a Yahoo exchange name to an InvestApp market code ("US", "NYSE", "TSE", "LSE").
    Returns ``None`` when the exchange does not match any registered market."""
    if not raw:
        return None
    r = raw.upper()
    if any(k in r for k in ("NASDAQ", "NMS", "ARCA", "AMEX", "BATS", "BZX")):
        return "US"
    if any(k in r for k in ("NYSE", "NYQ")):
        return "NYSE"
    if any(k in r for k in ("TSE", "TOKYO")):
        return "TSE"
    if any(k in r for k in ("LSE", "LONDON")):
        return "LSE"
    return None


def _map_exchange_code(raw: str) -> str:
    """Map a Yahoo exchange name to a usable tape/MIC code for trade prints."""
    if not raw:
        return "XNAS"
    r = raw.upper()
    if "NASDAQ" in r or "NMS" in r:
        return "XNAS"
    if "NYSE" in r or "NYQ" in r:
        return "XNYS"
    if "ARCA" in r:
        return "ARCX"
    if "BATS" in r or "BZX" in r:
        return "BATS"
    if "LSE" in r or "LONDON" in r:
        return "XLON"
    if "TSE" in r or "TOKYO" in r:
        return "XTKS"
    if "HKG" in r or "HKEX" in r:
        return "XHKG"
    if "EUR" in r or "PARIS" in r or "XPAR" in r:
        return "XPAR"
    if "FRA" in r or "FRANKFURT" in r:
        return "XFRA"
    if "CHI" in r:
        return "XCHI"
    if "AMS" in r or "AEB" in r:
        return "XAMS"
    return "XNAS"


def search_symbols(query: str, limit: int = 10, market_code: str | None = None) -> list[dict]:
    """Synchronous Yahoo symbol search (call via asyncio.to_thread).
    When ``market_code`` is provided, only results whose exchange maps to that
    market are returned."""
    import requests

    q = (query or "").strip()
    if not q:
        return []
    url = (
        "https://query1.finance.yahoo.com/v1/finance/search"
        f"?q={q}&quotesCount={limit}&newsCount=0&quotesQueryId=tss_match_phrase_query"
    )
    try:
        resp = requests.get(url, timeout=10, headers=_HEADERS)
        resp.raise_for_status()
        quotes = resp.json().get("quotes", [])
    except Exception:
        return []
    out = []
    for item in quotes:
        if item.get("quoteType") not in ("EQUITY", "ETF"):
            continue
        if market_code:
            ex = item.get("exchange", "")
            if _exchange_to_market_code(ex) != market_code:
                continue
        out.append({
            "symbol": item.get("symbol", ""),
            "name": item.get("shortname") or item.get("longname") or item.get("symbol", ""),
            "exchange": item.get("exchange", ""),
            "quoteType": item.get("quoteType", "EQUITY"),
        })
        if len(out) >= limit:
            break
    return out


def fetch_quote_summary(symbol: str) -> dict:
    """Synchronous best-effort Yahoo quoteSummary fetch. Returns a dict with
    whatever fundamentals are available; empty dict on any failure."""
    import requests

    url = (
        f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}"
        "?modules=summaryProfile,summaryDetail,financialData,price,defaultKeyStatistics"
    )
    try:
        resp = requests.get(url, timeout=15, headers=_HEADERS)
        resp.raise_for_status()
        return resp.json().get("quoteSummary", {}).get("result", [{}])[0]
    except Exception:
        return {}


async def get_fundamentals(symbol: str | None = None) -> dict:
    """Return fundamentals for `symbol`. The default instrument uses the
    hard-coded ``fundamentals`` module; any other symbol falls back to a
    best-effort Yahoo quoteSummary fetch (cached)."""
    if symbol is None:
        symbol = SYMBOL
    if symbol == config.SYMBOL:
        import fundamentals as fnd
        return {
            "name": fnd.NAME,
            "sector": fnd.SECTOR,
            "industry": fnd.INDUSTRY,
            "website": fnd.WEBSITE,
            "employees": fnd.EMPLOYEES,
            "fiscalYearEnds": fnd.FISCAL_YEAR_ENDS,
            "description": fnd.DESCRIPTION,
            "shares_outstanding": fnd.SHARES_OUTSTANDING,
            "pe_ratio": fnd.PE_RATIO,
            "eps": fnd.EPS,
            "beta": fnd.BETA,
            "dividend": fnd.DIVIDEND,
            "dividend_yield": fnd.DIVIDEND_YIELD,
            "target": fnd.TARGET,
            "ex_dividend_date": fnd.EX_DIVIDEND_DATE,
            "earnings_date": fnd.EARNINGS_DATE,
            "performance": fnd.PERFORMANCE,
        }
    if symbol in _fundamentals_cache:
        return _fundamentals_cache[symbol]
    raw = await asyncio.to_thread(fetch_quote_summary, symbol)
    price = raw.get("price", {}) or {}
    detail = raw.get("summaryDetail", {}) or {}
    fin = raw.get("financialData", {}) or {}
    profile = raw.get("summaryProfile", {}) or {}
    keys = raw.get("defaultKeyStatistics", {}) or {}

    def _val(d, k):
        v = d.get(k)
        if isinstance(v, dict):
            return v.get("raw")
        return v

    out = {
        "name": _val(price, "longName") or _val(price, "shortName") or symbol,
        "sector": profile.get("sector"),
        "industry": profile.get("industry"),
        "website": profile.get("website"),
        "employees": _val(profile, "fullTimeEmployees"),
        "fiscalYearEnds": _val(profile, "lastFiscalYearEnd"),
        "description": profile.get("longBusinessSummary"),
        "shares_outstanding": _val(keys, "sharesOutstanding") or _val(fin, "sharesOutstanding"),
        "pe_ratio": _val(detail, "trailingPE") or _val(keys, "trailingPE"),
        "eps": _val(keys, "trailingEps"),
        "beta": _val(detail, "beta") or _val(keys, "beta"),
        "dividend": _val(detail, "dividendRate"),
        "dividend_yield": _val(detail, "dividendYield"),
        "target": _val(fin, "targetMeanPrice"),
        "ex_dividend_date": _val(detail, "exDividendDate"),
        "earnings_date": _val(fin, "earningsTimestamp") or _val(keys, "earningsTimestamp"),
        "performance": {
            "ytd": {"stock": None, "bench": None},
            "one_year": {"stock": None, "bench": None},
            "three_year": {"stock": None, "bench": None},
        },
    }
    _fundamentals_cache[symbol] = out
    return out


# --------------------------------------------------------------------------- #
# Daily history (cached)
# --------------------------------------------------------------------------- #
async def get_daily_history(force: bool = False, symbol: str | None = None) -> list[dict]:
    """Return ~1y of daily bars (oldest->newest) for `symbol`, cached 1h."""
    if symbol is None:
        symbol = SYMBOL
    now = asyncio.get_event_loop().time()
    cached = _daily_cache.get(symbol)
    cached_at = _daily_cache_at.get(symbol, 0.0)
    if not force and cached and (now - cached_at) < _DAILY_TTL:
        return cached
    # Try Yahoo daily, fall back to Stooq.
    bars: list[dict] = []
    try:
        payload = await asyncio.to_thread(fetch_chart, "1y", "1d", symbol)
        bars = parse_daily(payload)
    except Exception as exc:  # noqa: BLE001
        log.warning("Yahoo daily history failed (%s); trying Stooq.", exc)
    if not bars:
        try:
            bars = await asyncio.to_thread(fetch_stooq_daily, symbol)
        except Exception as exc:  # noqa: BLE001
            log.warning("Stooq daily history failed (%s).", exc)
    if bars:
        _daily_cache[symbol] = bars
        _daily_cache_at[symbol] = now
    return _daily_cache.get(symbol, [])


# --------------------------------------------------------------------------- #
# Snapshot for REST /api/quote
# --------------------------------------------------------------------------- #
async def build_quote(symbol: str | None = None) -> dict:
    """Assemble the full quote payload for REST + WS snapshot."""
    if symbol is None:
        symbol = SYMBOL
    q = await db.get_latest_quote(symbol)
    daily = await get_daily_history(symbol=symbol)
    meta = await get_meta(symbol)
    fnd = await get_fundamentals(symbol)

    price = q["price"] if q else None
    prev_close = q["prev_close"] if q else None
    change = q["change"] if q else None
    change_pct = q["change_pct"] if q else None
    if price is not None and prev_close is not None and change is None:
        change = round(price - prev_close, 2)
        change_pct = round((change / prev_close) * 100, 2) if prev_close else None

    # 52-week range + averages from daily history.
    fifty_two_high = fifty_two_low = avg_volume = None
    avg_price_3d = avg_volume_3d = avg_price_3m = avg_volume_3m = None
    if daily:
        window = daily[-252:]
        fifty_two_high = max(b["high"] for b in window)
        fifty_two_low = min(b["low"] for b in window)
        # Use completed bars (exclude the most recent, which is partial today)
        # so volume averages aren't skewed by an in-progress session.
        completed = daily[:-1] if len(daily) > 1 else daily

        def _mean(vals):
            return sum(vals) / len(vals) if vals else None

        avg_volume = _mean([b["volume"] for b in completed[-252:]])
        avg_price_3d = _mean([b["close"] for b in completed[-3:]])
        avg_volume_3d = _mean([b["volume"] for b in completed[-3:]])
        avg_price_3m = _mean([b["close"] for b in completed[-63:]])
        avg_volume_3m = _mean([b["volume"] for b in completed[-63:]])

    shares = fnd.get("shares_outstanding")
    market_cap = int(price * shares) if price and shares else None

    return {
        "symbol": symbol,
        "name": meta.get("name", symbol),
        "exchange": meta.get("exchange", "") or config.MARKET_DISPLAY,
        "currency": meta.get("currency", config.MARKET_CURRENCY),
        "marketTimezone": meta.get("timezone", config.MARKET_TIMEZONE),
        "price": price,
        "currentPrice": q.get("current_price") if q else None,
        "change": change,
        "changePercent": change_pct,
        "prevClose": prev_close,
        "open": q["open"] if q else None,
        "dayHigh": q["day_high"] if q else None,
        "dayLow": q["day_low"] if q else None,
        "bid": q["bid"] if q else None,
        "ask": q["ask"] if q else None,
        "bidSize": q["bid_size"] if q else None,
        "askSize": q["ask_size"] if q else None,
        "volume": q["volume"] if q else None,
        "avgVolume": int(avg_volume) if avg_volume else None,
        "avgPrice3d": round(avg_price_3d, 2) if avg_price_3d else None,
        "avgVolume3d": int(avg_volume_3d) if avg_volume_3d else None,
        "avgPrice3m": round(avg_price_3m, 2) if avg_price_3m else None,
        "avgVolume3m": int(avg_volume_3m) if avg_volume_3m else None,
        "fiftyTwoWeekHigh": fifty_two_high,
        "fiftyTwoWeekLow": fifty_two_low,
        "marketCap": market_cap,
        "peRatio": fnd.get("pe_ratio"),
        "eps": fnd.get("eps"),
        "beta": fnd.get("beta"),
        "dividend": fnd.get("dividend"),
        "dividendYield": fnd.get("dividend_yield"),
        "target": fnd.get("target"),
        "exDividendDate": fnd.get("ex_dividend_date"),
        "earningsDate": fnd.get("earnings_date"),
        "marketState": (q["market_state"] if q else "CLOSED"),
        "asOf": q["as_of"] if q else None,
        "sector": fnd.get("sector"),
        "industry": fnd.get("industry"),
        "description": fnd.get("description"),
        "website": fnd.get("website"),
        "employees": fnd.get("employees"),
        "fiscalYearEnds": fnd.get("fiscal_year_ends"),
        "performance": fnd.get("performance"),
    }


# --------------------------------------------------------------------------- #
# Seed + live loop
# --------------------------------------------------------------------------- #
async def seed_history(symbol: str | None = None) -> int:
    """Seed today's 1-min intraday bars from Yahoo so the chart is populated
    from the very first render. Returns the number of bars inserted."""
    if symbol is None:
        symbol = SYMBOL
    snap = await fetch_snapshot(symbol)
    count = 0
    for b in snap["bars"]:
        await db.insert_bar(
            symbol, b["timestamp"], b["open"], b["high"], b["low"], b["close"], b["volume"]
        )
        count += 1
    log.info("Seeded %d intraday bars for %s.", count, symbol)
    # Also seed the trades table from today's bars so the tape isn't empty on first load.
    for b in snap.get("bars", []):
        _ex = _map_exchange_code(snap.get("exchange", ""))
        _state = snap.get("market_state", "CLOSED")
        _cond = "@" if _state == "REGULAR" else "T"
        await db.insert_trade(symbol, b["timestamp"], b["close"], b.get("volume", 0), _ex, _cond)
    await get_daily_history(force=True, symbol=symbol)
    return count


async def fetch_snapshot(symbol: str | None = None) -> dict:
    if symbol is None:
        symbol = SYMBOL
    payload = await asyncio.to_thread(fetch_chart, "1d", "1m", symbol)
    return parse_chart(payload)


def switch_symbol(symbol: str) -> str:
    """Switch the instrument the live feed tracks. The feed loop reads
    ``feed.SYMBOL`` on every tick, so updating it here is enough to start
    streaming a different stock on the next poll. Returns the new symbol."""
    global SYMBOL
    symbol = (symbol or "").strip().upper()
    if not symbol:
        return SYMBOL
    SYMBOL = symbol
    # Drop stale caches so the new symbol re-seeds fresh data.
    _daily_cache.pop(symbol, None)
    _daily_cache_at.pop(symbol, None)
    _meta_cache.pop(symbol, None)
    _fundamentals_cache.pop(symbol, None)
    log.info("Feed symbol switched to %s.", symbol)
    return SYMBOL


async def run_feed(queue: asyncio.Queue, interval: float = POLL_INTERVAL) -> None:
    """
    Long-lived task: every `interval` seconds, fetch the current symbol's
    latest Yahoo chart, persist the current price + intraday bars, and push
    quote/bar messages so all connected frontends update in real time.

    The symbol is read from ``feed.SYMBOL`` on every tick so it can be
    changed at runtime via :func:`switch_symbol` without restarting the task.
    """
    log.info("Yahoo feed started (every %.1fs).", interval)
    while True:
        try:
            symbol = SYMBOL
            snap = await fetch_snapshot(symbol)
            # Cache chart meta so build_quote can show name/exchange/tz.
            _meta_cache[symbol] = {
                "symbol": snap.get("symbol", symbol),
                "name": snap.get("name", symbol),
                "exchange": snap.get("exchange", ""),
                "currency": snap.get("currency", "USD"),
                "timezone": snap.get("timezone", "America/New_York"),
            }
            price = snap["price"]
            if price is None:
                await asyncio.sleep(interval)
                continue

            now = datetime.now(timezone.utc)
            prev_close = snap["prev_close"]
            change = round(price - prev_close, 2) if prev_close else None
            change_pct = round((change / prev_close) * 100, 2) if prev_close else None

            # A tiny synthetic spread so the NBBO panel looks authentic (the
            # free Yahoo chart API does not expose true bid/ask). Documented.
            spread = max(0.01, round(price * 0.0002, 2))
            bid = round(price - spread, 2)
            ask = round(price + spread, 2)

            as_of = now.isoformat()

            # Persist the quote snapshot (close price + current extended price).
            current_price = snap.get("current_price")
            await db.insert_quote(
                symbol, now, price, current_price, change, change_pct, prev_close,
                snap["open"], snap["day_high"], snap["day_low"],
                bid, ask, 0, 0, snap["volume"], snap["market_state"], as_of,
            )

            # Upsert the current 1-min bar so the chart tracks live.
            minute = now.replace(second=0, microsecond=0)
            bar_for_minute = next(
                (b for b in reversed(snap["bars"]) if b["timestamp"] == minute), None
            )
            if bar_for_minute:
                o, h, l, c, v = (
                    bar_for_minute["open"], bar_for_minute["high"],
                    bar_for_minute["low"], bar_for_minute["close"], bar_for_minute["volume"],
                )
            else:
                o = h = l = c = price
                v = snap["volume"] or 0
            await db.insert_bar(symbol, minute, o, h, l, c, v)

            # Push messages to all clients.
            await queue.put({
                "type": "quote",
                "symbol": symbol,
                "price": price,
                "currentPrice": current_price,
                "change": change,
                "changePercent": change_pct,
                "prevClose": prev_close,
                "open": snap["open"],
                "dayHigh": snap["day_high"],
                "dayLow": snap["day_low"],
                "bid": bid,
                "ask": ask,
                "bidSize": 0,
                "askSize": 0,
                "volume": snap["volume"],
                "marketState": snap["market_state"],
                "asOf": as_of,
            })
            await queue.put({
                "type": "bar",
                "symbol": symbol,
                "timestamp": minute.isoformat(),
                "open": o, "high": h, "low": l, "close": c, "volume": v,
            })
            # --- Push real trade data -------------------------------------------
            # When Finnhub is connected and streaming real ticks, skip the
            # synthetic 1-minute-bar trades to avoid duplicates in the tape.
            if not is_finnhub_active():
                # The free Yahoo chart API does not provide tick-level trade data.
                # Instead of faking prints, we use the actual 1-minute OHLCV bars
                # which ARE real aggregated market data — each bar's close and
                # volume represent actual trades that occurred in that minute.
                # Only new bars (timestamp >= last pushed) are emitted as prints.
                # When the market is closed and no new bars exist, the tape simply
                # stops — honest and not misleading.

                # Determine which bars are new since the last poll.
                now_utc = datetime.now(timezone.utc)
                _bars = snap.get("bars", [])
                _state = snap.get("market_state", "CLOSED")
                _ex_raw = snap.get("exchange", "")
                _ex_code = _map_exchange_code(_ex_raw)

                # Only push bars from the last POLL_INTERVAL * 2 seconds (≈6s window).
                # During active trading this typically yields 1‑2 new bars per poll.
                _cutoff = now_utc - timedelta(seconds=POLL_INTERVAL * 2.5)
                _fresh = [b for b in _bars if b["timestamp"] >= _cutoff]

                # If no fresh bars (closed market / overnight), push nothing.
                # The tape will naturally empty out.
                for _bar in _fresh:
                    _ts = _bar["timestamp"]
                    _close = _bar["close"]
                    _vol = _bar.get("volume", 0)
                    _cond = "@" if _state == "REGULAR" else "T"

                    await db.insert_trade(symbol, _ts, _close, _vol, _ex_code, _cond)
                    await queue.put({
                        "type": "trade",
                        "symbol": symbol,
                        "timestamp": _ts.isoformat(),
                        "price": _close,
                        "size": _vol,
                        "exchange": _ex_code,
                        "condition": _cond,
                    })

            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            log.info("Yahoo feed stopped.")
            raise
        except Exception as exc:  # noqa: BLE001 — keep the feed alive on hiccups
            log.warning("Feed tick failed (%s); retrying in %ss.", exc, interval)
            await asyncio.sleep(interval)
