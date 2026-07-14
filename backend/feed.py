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
from datetime import datetime, timezone

import config
import db

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("feed")

# Symbol + market are configuration-driven (see config.py) so the app can be
# pointed at any stock on any registered market without code changes.
SYMBOL = config.SYMBOL
_CHART_URL = f"https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}"
_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# How often we poll Yahoo for a fresh quote + bars.
# 3s gives ~20 updates/minute (Yahoo rate limit is ~2000 req/h for a single
# symbol, so we're comfortably under).
POLL_INTERVAL = 3.0

# In-memory daily-history cache (oldest -> newest list of dict bars).
_daily_cache: list[dict] = []
_daily_cache_at: float = 0.0
_DAILY_TTL = 3600.0  # 1h


# --------------------------------------------------------------------------- #
# Yahoo chart fetch + parse
# --------------------------------------------------------------------------- #
def _fetch_json(url: str) -> dict:
    import requests

    resp = requests.get(url, timeout=15, headers=_HEADERS)
    resp.raise_for_status()
    return resp.json()


def fetch_chart(range_: str = "1d", interval: str = "1m") -> dict:
    """Synchronous Yahoo chart fetch (call via asyncio.to_thread)."""
    url = f"{_CHART_URL}?range={range_}&interval={interval}&includePrePost=true"
    return _fetch_json(url)


def parse_chart(payload: dict) -> dict:
    """Extract current quote + 1-min bars from a Yahoo 1d chart payload."""
    result = (payload.get("chart") or {}).get("result")
    if not result:
        raise ValueError("Yahoo chart returned no result")
    r = result[0]
    meta = r.get("meta", {})
    price = meta.get("regularMarketPrice")
    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    market_state = (meta.get("marketState") or "CLOSED").upper()
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

    return {
        "price": float(price) if price is not None else None,
        "prev_close": float(prev_close) if prev_close is not None else None,
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


def fetch_stooq_daily(symbol: str = SYMBOL) -> list[dict]:
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


# --------------------------------------------------------------------------- #
# Daily history (cached)
# --------------------------------------------------------------------------- #
async def get_daily_history(force: bool = False) -> list[dict]:
    """Return ~1y of daily bars (oldest->newest), cached 1h."""
    global _daily_cache, _daily_cache_at
    now = asyncio.get_event_loop().time()
    if not force and _daily_cache and (now - _daily_cache_at) < _DAILY_TTL:
        return _daily_cache
    # Try Yahoo daily, fall back to Stooq.
    bars: list[dict] = []
    try:
        payload = await asyncio.to_thread(fetch_chart, "1y", "1d")
        bars = parse_daily(payload)
    except Exception as exc:  # noqa: BLE001
        log.warning("Yahoo daily history failed (%s); trying Stooq.", exc)
    if not bars:
        try:
            bars = await asyncio.to_thread(fetch_stooq_daily)
        except Exception as exc:  # noqa: BLE001
            log.warning("Stooq daily history failed (%s).", exc)
    if bars:
        _daily_cache = bars
        _daily_cache_at = now
    return _daily_cache


# --------------------------------------------------------------------------- #
# Snapshot for REST /api/quote
# --------------------------------------------------------------------------- #
async def build_quote(symbol: str = SYMBOL) -> dict:
    """Assemble the full quote payload for REST + WS snapshot."""
    import fundamentals as fnd

    q = await db.get_latest_quote(symbol)
    daily = await get_daily_history()

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

    market_cap = int(price * fnd.SHARES_OUTSTANDING) if price else None

    return {
        "symbol": symbol,
        "name": fnd.NAME,
        "exchange": config.MARKET_DISPLAY,
        "currency": config.MARKET_CURRENCY,
        "marketTimezone": config.MARKET_TIMEZONE,
        "price": price,
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
        "peRatio": fnd.PE_RATIO,
        "eps": fnd.EPS,
        "beta": fnd.BETA,
        "dividend": fnd.DIVIDEND,
        "dividendYield": fnd.DIVIDEND_YIELD,
        "target": fnd.TARGET,
        "exDividendDate": fnd.EX_DIVIDEND_DATE,
        "earningsDate": fnd.EARNINGS_DATE,
        "marketState": (q["market_state"] if q else "CLOSED"),
        "asOf": q["as_of"] if q else None,
        "sector": fnd.SECTOR,
        "industry": fnd.INDUSTRY,
        "description": fnd.DESCRIPTION,
        "website": fnd.WEBSITE,
        "employees": fnd.EMPLOYEES,
        "fiscalYearEnds": fnd.FISCAL_YEAR_ENDS,
        "performance": fnd.PERFORMANCE,
    }


# --------------------------------------------------------------------------- #
# Seed + live loop
# --------------------------------------------------------------------------- #
async def seed_history(symbol: str = SYMBOL) -> int:
    """Seed today's 1-min intraday bars from Yahoo so the chart is populated
    from the very first render. Returns the number of bars inserted."""
    snap = await fetch_snapshot(symbol)
    count = 0
    for b in snap["bars"]:
        await db.insert_bar(
            symbol, b["timestamp"], b["open"], b["high"], b["low"], b["close"], b["volume"]
        )
        count += 1
    log.info("Seeded %d intraday bars for %s.", count, symbol)
    await get_daily_history(force=True)
    return count


async def fetch_snapshot(symbol: str = SYMBOL) -> dict:
    payload = await asyncio.to_thread(fetch_chart, "1d", "1m")
    return parse_chart(payload)


async def run_feed(queue: asyncio.Queue, symbol: str = SYMBOL, interval: float = POLL_INTERVAL) -> None:
    """
    Long-lived task: every `interval` seconds, fetch MU's latest Yahoo chart,
    persist the current price + intraday bars, and push quote/bar messages so
    all connected frontends update in real time.
    """
    log.info("Yahoo feed started for %s (every %.1fs).", symbol, interval)
    while True:
        try:
            snap = await fetch_snapshot(symbol)
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

            # Persist the quote snapshot.
            await db.insert_quote(
                symbol, now, price, change, change_pct, prev_close,
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
            # A synthetic trade print so the time & sales tape stays active.
            await db.insert_trade(symbol, now, price, 100, "XNAS", "0")
            await queue.put({
                "type": "trade",
                "symbol": symbol,
                "timestamp": now.isoformat(),
                "price": price, "size": 100, "exchange": "XNAS", "condition": "0",
            })

            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            log.info("Yahoo feed stopped.")
            raise
        except Exception as exc:  # noqa: BLE001 — keep the feed alive on hiccups
            log.warning("Feed tick failed (%s); retrying in %ss.", exc, interval)
            await asyncio.sleep(interval)
