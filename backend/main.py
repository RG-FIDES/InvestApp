"""
main.py — FastAPI server for InvestApp (rebuilt).

Responsibilities
----------------
* Lifespan startup: open SQLite (WAL), seed today's intraday bars + daily
  history from Yahoo, then spawn the live feed task and the broadcaster task.
* REST:
    GET /api/quote     -> full quote snapshot (price, change, stats, fundamentals)
    GET /api/history   -> bars for the chart (?range=1D|5D|1M|6M|YTD|1Y)
* WebSocket /ws/live  -> pushes quote/trade/bar messages; accepts per-connection
  price-alert thresholds and emits an "alert" message on a cross.

The broadcaster task owns every client send_json, so a slow client can never
block the Yahoo feed or DB writes (those only do fast inserts + queue.put).
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

import config
import db
import feed

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("server")

_CORS_ORIGINS = [o.strip() for o in os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000").split(",") if o.strip()]
FRONTEND_ORIGIN = _CORS_ORIGINS[0] if _CORS_ORIGINS else "http://localhost:3000"

broadcast_queue: Optional[asyncio.Queue] = None
active_connections: set[WebSocket] = set()
connection_alerts: dict[WebSocket, float] = {}
connection_custom_notifications: dict[WebSocket, dict[str, dict]] = {}
prev_close: Optional[float] = None  # for alert cross-detection

# Notification tracking — compared against each incoming quote to detect
# meaningful events (day high/low broken, volume spikes, market transitions,
# percentage moves from open).
_prev_day_high: Optional[float] = None
_prev_day_low: Optional[float] = None
_prev_volume: Optional[float] = None
_prev_market_state: Optional[str] = None
_prev_price: Optional[float] = None
_day_open: Optional[float] = None  # cached open for percent-move calc


# --------------------------------------------------------------------------- #
# Broadcaster
# --------------------------------------------------------------------------- #
async def broadcaster() -> None:
    assert broadcast_queue is not None
    while True:
        msg = await broadcast_queue.get()
        disconnected: set[WebSocket] = set()
        for ws in list(active_connections):
            try:
                await ws.send_json(msg)
            except Exception:
                disconnected.add(ws)
        for ws in disconnected:
            await _remove_connection(ws)
        if msg.get("type") == "quote":
            await _check_alerts(msg)
            await _check_events(msg)
            await _check_custom_notifications(msg)
        broadcast_queue.task_done()


async def _check_events(q: dict) -> None:
    """Check the incoming quote for notification-worthy events and push
    ``notification`` messages onto the broadcast queue when detected.

    Detects:
    * Day high / day low broken
    * Volume spike (current > 3× the running EMA average)
    * Market-state transition (PRE → REGULAR, REGULAR → POST, etc.)
    * Percent move from open (±2 % / ±5 %)
    """
    global _prev_day_high, _prev_day_low, _prev_volume, _prev_market_state
    global _prev_price, _day_open
    assert broadcast_queue is not None

    price = q.get("price")
    day_high = q.get("dayHigh")
    day_low = q.get("dayLow")
    volume = q.get("volume")
    market_state = q.get("marketState")
    day_open = q.get("open")
    now_iso = datetime.utcnow().isoformat()

    # Capture day-open once per session so percent-move detection works.
    if day_open is not None and _day_open is None:
        _day_open = day_open
    # Reset open-tracking when market transitions to a new session.
    if market_state == "PRE" and _prev_market_state == "CLOSED":
        _day_open = day_open

    def _notify(event: str, level: str, title: str, body: str) -> None:
        assert broadcast_queue is not None
        broadcast_queue.put_nowait({
            "type": "notification",
            "id": str(uuid.uuid4()),
            "event": event,
            "level": level,
            "title": title,
            "body": body,
            "timestamp": now_iso,
        })

    # --- Day high broken ---------------------------------------------------
    if (
        day_high is not None
        and _prev_day_high is not None
        and day_high > _prev_day_high
    ):
        _notify("day_high", "warning",
                 f"New Day High — ${day_high:,.2f}",
                 f"{feed.SYMBOL} broke above the session high. "
                 f"Previous high was ${_prev_day_high:,.2f}.")
    _prev_day_high = day_high

    # --- Day low broken ----------------------------------------------------
    if (
        day_low is not None
        and _prev_day_low is not None
        and day_low < _prev_day_low
    ):
        _notify("day_low", "warning",
                 f"New Day Low — ${day_low:,.2f}",
                 f"{feed.SYMBOL} broke below the session low. "
                 f"Previous low was ${_prev_day_low:,.2f}.")
    _prev_day_low = day_low

    # --- Volume spike ------------------------------------------------------
    if (
        volume is not None
        and _prev_volume is not None
        and _prev_volume > 0
        and volume >= _prev_volume * 3.0
    ):
        _notify("volume_spike", "info",
                 f"Volume Spike — {volume:,.0f} shares",
                 f"{feed.SYMBOL} volume surged past 3× the recent run rate "
                 f"({_prev_volume:,.0f} avg).")
    if volume is not None:
        if _prev_volume is None:
            _prev_volume = volume
        else:
            _prev_volume = _prev_volume * 0.9 + volume * 0.1

    # --- Market-state transition -------------------------------------------
    if market_state and _prev_market_state and market_state != _prev_market_state:
        labels: dict[str, str] = {
            "PRE": "Pre-Market",
            "REGULAR": "Regular Trading",
            "POST": "After Hours",
            "CLOSED": "Closed",
        }
        old = labels.get(_prev_market_state, _prev_market_state)
        new = labels.get(market_state, market_state)
        _notify("market_transition", "info",
                 f"Market: {new}",
                 f"{feed.SYMBOL} session transitioned from {old} to {new}.")
    _prev_market_state = market_state

    # --- Percent move from open --------------------------------------------
    if price is not None and _day_open is not None and _day_open > 0:
        pct = ((price - _day_open) / _day_open) * 100
        prev_pct = ((_prev_price - _day_open) / _day_open) * 100 if _prev_price is not None else None
        for threshold, level in [(2.0, "info"), (5.0, "warning")]:
            if abs(pct) >= threshold and (prev_pct is None or abs(prev_pct) < threshold):
                direction = "up" if pct > 0 else "down"
                _notify("percent_move", level,
                         f"{direction.upper()} {abs(pct):.1f}%" if pct > 0 else f"DOWN {abs(pct):.1f}%",
                         f"{feed.SYMBOL} moved {pct:+.1f}% from open (${_day_open:,.2f}). "
                         f"Now at ${price:,.2f}.")
    _prev_price = price


async def _check_custom_notifications(q: dict) -> None:
    """Evaluate every connection's custom notifications against the current
    quote.  When *all* of a notif's conditions are met, send a ``custom_alert``
    message to that specific connection.  If ``repeat`` is ``"once"``, the
    notification is disabled after firing."""
    if not connection_custom_notifications:
        return

    price = q.get("price")
    day_high = q.get("dayHigh")
    day_low = q.get("dayLow")
    volume = q.get("volume")
    market_state = q.get("marketState")
    day_open = q.get("open")
    _now_iso = datetime.utcnow().isoformat()

    for ws, notifs in list(connection_custom_notifications.items()):
        if ws not in active_connections:
            continue
        for nid, n in list(notifs.items()):
            if not n.get("enabled", True):
                continue
            conds = n.get("conditions", {})
            if _evaluate_conditions(conds, price, day_high, day_low,
                                    volume, market_state, day_open,
                                    _prev_day_high, _prev_day_low):
                body = _build_custom_body(n["name"], conds, price)
                try:
                    await ws.send_json({
                        "type": "custom_alert",
                        "notification_id": nid,
                        "name": n["name"],
                        "body": body,
                        "timestamp": _now_iso,
                    })
                except Exception:
                    pass
                n["fire_count"] = n.get("fire_count", 0) + 1
                n["last_fired_at"] = _now_iso
                if n.get("repeat") == "once":
                    n["enabled"] = False
                    try:
                        await ws.send_json({
                            "type": "custom_notif_disabled",
                            "notification_id": nid,
                        })
                    except Exception:
                        pass


def _evaluate_conditions(
    conds: dict,
    price: Optional[float],
    day_high: Optional[float],
    day_low: Optional[float],
    volume: Optional[float],
    market_state: Optional[str],
    day_open: Optional[float],
    prev_day_high: Optional[float],
    prev_day_low: Optional[float],
) -> bool:
    """Return True when *all* non-null conditions in ``conds`` are satisfied."""
    if price is None:
        return False

    # -- price above -------------------------------------------------------
    pa = conds.get("price_above")
    if pa is not None and (not isinstance(price, (int, float)) or price <= pa):
        return False

    # -- price below -------------------------------------------------------
    pb = conds.get("price_below")
    if pb is not None and (not isinstance(price, (int, float)) or price >= pb):
        return False

    # -- day high broken ---------------------------------------------------
    if conds.get("day_high_broken") and day_high is not None and prev_day_high is not None:
        if day_high <= prev_day_high:
            return False

    # -- day low broken ----------------------------------------------------
    if conds.get("day_low_broken") and day_low is not None and prev_day_low is not None:
        if day_low >= prev_day_low:
            return False

    # -- volume above ------------------------------------------------------
    va = conds.get("volume_above")
    if va is not None and volume is not None:
        if volume < va:
            return False

    # -- volume spike ------------------------------------------------------
    if conds.get("volume_spike") and volume is not None and _prev_volume is not None and _prev_volume > 0:
        if volume < _prev_volume * 3.0:
            return False

    # -- percent move up ---------------------------------------------------
    pmu = conds.get("percent_move_up")
    if pmu is not None and day_open is not None and day_open > 0:
        pct = ((price - day_open) / day_open) * 100
        if pct < pmu:
            return False

    # -- percent move down -------------------------------------------------
    pmd = conds.get("percent_move_down")
    if pmd is not None and day_open is not None and day_open > 0:
        pct = ((day_open - price) / day_open) * 100
        if pct < pmd:
            return False

    # -- market state is ---------------------------------------------------
    ms = conds.get("market_state_is")
    if ms is not None and market_state is not None:
        if market_state.upper() != ms.upper():
            return False

    return True


def _build_custom_body(name: str, conds: dict, price: Optional[float]) -> str:
    """Build a human-readable body for the custom alert."""
    parts = [f'"{name}" triggered']
    if price is not None:
        parts.append(f"at ${price:,.2f}")
    pa = conds.get("price_above")
    pb = conds.get("price_below")
    if pa is not None:
        parts.append(f"(price above ${pa:,.2f})")
    if pb is not None:
        parts.append(f"(price below ${pb:,.2f})")
    if conds.get("day_high_broken"):
        parts.append("(day high broken)")
    if conds.get("day_low_broken"):
        parts.append("(day low broken)")
    pmu = conds.get("percent_move_up")
    if pmu is not None:
        parts.append(f"(+{pmu}% from open)")
    pmd = conds.get("percent_move_down")
    if pmd is not None:
        parts.append(f"(-{pmd}% from open)")
    return " ".join(parts)


async def _check_alerts(q: dict) -> None:
    global prev_close
    price = q.get("price")
    # Legacy simple price alerts: kept for API compatibility but superseded
    # by the custom notification system.
    for ws, threshold in list(connection_alerts.items()):
        if ws not in active_connections:
            continue
        crossed = False
        if prev_close is not None and price is not None:
            crossed = (prev_close < threshold <= price) or (prev_close > threshold >= price)
        if crossed:
            try:
                await ws.send_json({
                    "type": "alert",
                    "message": f"{feed.SYMBOL} crossed {threshold:.2f} (now {price:.2f})",
                })
            except Exception:
                pass
    if price is not None:
        prev_close = price


async def _remove_connection(ws: WebSocket) -> None:
    active_connections.discard(ws)
    connection_alerts.pop(ws, None)
    connection_custom_notifications.pop(ws, None)


def reset_event_tracking() -> None:
    """Reset the notification/event tracking state when the tracked symbol
    changes, so day-high/low/volume/state baselines re-establish for the new
    instrument instead of carrying over the previous symbol's values."""
    global _prev_day_high, _prev_day_low, _prev_volume, _prev_market_state
    global _prev_price, _day_open, prev_close
    _prev_day_high = None
    _prev_day_low = None
    _prev_volume = None
    _prev_market_state = None
    _prev_price = None
    _day_open = None
    prev_close = None


# --------------------------------------------------------------------------- #
# Lifespan
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(app: FastAPI):
    global broadcast_queue, prev_close
    await db.init_db()
    broadcast_queue = asyncio.Queue(maxsize=10_000)

    try:
        await feed.seed_history()
        stats = await db.get_latest_quote()
        prev_close = stats["prev_close"] if stats else None
    except Exception as exc:  # noqa: BLE001
        log.warning("Seed failed (%s); feed will populate on first tick.", exc)

    ingest_task = asyncio.create_task(feed.run_feed(broadcast_queue))
    bcast_task = asyncio.create_task(broadcaster())

    log.info("InvestApp backend started (Yahoo Finance feed, symbol=%s).", feed.SYMBOL)
    try:
        yield
    finally:
        ingest_task.cancel()
        bcast_task.cancel()
        await asyncio.gather(ingest_task, bcast_task, return_exceptions=True)
        await db.close_db()
        log.info("InvestApp backend stopped.")


app = FastAPI(title="InvestApp", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _range_to_days(range_: str) -> Optional[int]:
    return {
        "5D": 5, "1M": 22, "6M": 126, "YTD": None, "1Y": 252,
    }.get(range_.upper())


def _aggregate_bars(bars: list[dict], interval: str) -> list[dict]:
    """Aggregate 1‑min bars into wider intervals (5m / 15m / 30m / 1h).

    Bars are expected to be sorted oldest→newest with keys:
    timestamp, open, high, low, close, volume.
    """
    minutes = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440}.get(interval, 1)
    if minutes == 1:
        return bars

    result: list[dict] = []
    bucket: list[dict] = []
    bucket_start: Optional[str] = None

    def flush() -> None:
        if not bucket:
            return
        result.append({
            "timestamp": bucket[0]["timestamp"],
            "open": bucket[0]["open"],
            "high": max(b["high"] for b in bucket),
            "low": min(b["low"] for b in bucket),
            "close": bucket[-1]["close"],
            "volume": sum(b.get("volume", 0) or 0 for b in bucket),
        })

    for bar in bars:
        ts = bar.get("timestamp", "")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if minutes < 60:
                # Sub-hour — align to minute boundary
                aligned = dt.replace(second=0, microsecond=0)
                mn = (aligned.minute // minutes) * minutes
                slot = aligned.replace(minute=mn).isoformat()
            else:
                # Hour-based — align to hour block boundary
                block_hours = minutes // 60
                aligned = dt.replace(minute=0, second=0, microsecond=0)
                hr = (aligned.hour // block_hours) * block_hours
                slot = aligned.replace(hour=hr).isoformat()
        except Exception:
            continue

        if bucket_start is None:
            bucket_start = slot
        if slot != bucket_start:
            flush()
            bucket = []
            bucket_start = slot
        bucket.append(bar)

    flush()
    return result


# --------------------------------------------------------------------------- #
# REST
# --------------------------------------------------------------------------- #
@app.get("/api/quote")
async def api_quote():
    return await feed.build_quote()


@app.get("/api/history")
async def api_history(range: str = "1D", interval: str = "1m"):
    range = (range or "1D").upper()
    interval = (interval or "1m").lower()

    # Intraday ranges — fetch sub-daily bars with an appropriate source
    # interval that Yahoo supports for the given range.
    if range in ("1D", "5D", "1M") and interval != "1d":
        if range == "1D":
            bars = await db.get_today_bars(feed.SYMBOL)
        else:
            yahoo_range = {"5D": "5d", "1M": "1mo"}[range]
            # 1m works for 5d, but 1mo needs 5m (1m is too many bars for Yahoo).
            source_interval = "1m" if range == "5D" else "5m"
            payload = await asyncio.to_thread(feed.fetch_chart, yahoo_range, source_interval)
            parsed = feed.parse_chart(payload)
            bars = parsed.get("bars", [])
            for b in bars:
                if isinstance(b.get("timestamp"), datetime):
                    b["timestamp"] = b["timestamp"].isoformat()
        return _aggregate_bars(bars, interval)

    # Daily bars — 6M / YTD / 1Y, or "1d" interval
    daily = await feed.get_daily_history()
    if not daily:
        return []
    if range == "YTD":
        ytd = f"{datetime.now().year}-01-01"
        return [b for b in daily if b["date"] >= ytd]
    days = _range_to_days(range)
    if days:
        return daily[-days:]
    return daily


@app.get("/api/market-status")
async def api_market_status():
    q = await db.get_latest_quote(feed.SYMBOL)
    return {
        "is_open": (q["market_state"] == "REGULAR") if q else False,
        "market_state": q["market_state"] if q else "CLOSED",
        "as_of": q["as_of"] if q else None,
    }


@app.get("/api/markets")
async def api_markets():
    """List the registered markets the user can filter/track stocks on."""
    return {
        code: {
            "display": m["display"],
            "currency": m["currency"],
            "timezone": m["timezone"],
            "city": m.get("city", ""),
            "flag": m.get("flag", ""),
        }
        for code, m in config.MARKETS.items()
    }


@app.get("/api/symbol")
async def api_get_symbol():
    """Return the symbol the feed is currently tracking."""
    return {"symbol": feed.SYMBOL}


@app.post("/api/symbol")
async def api_set_symbol(body: dict):
    """Switch the tracked symbol. Re-seeds history for the new instrument,
    resets event-tracking baselines, and broadcasts a ``symbol_changed``
    message so every connected client re-fetches its quote/history."""
    new_symbol = (body.get("symbol") or "").strip().upper()
    if not new_symbol:
        return {"ok": False, "error": "symbol required"}
    new_symbol = feed.switch_symbol(new_symbol)
    reset_event_tracking()
    # Re-seed intraday bars + daily history for the new symbol in the background
    # so the first client re-fetch is fast.
    asyncio.create_task(_reseed_and_broadcast(new_symbol))
    return {"ok": True, "symbol": new_symbol}


async def _reseed_and_broadcast(symbol: str) -> None:
    try:
        await feed.seed_history(symbol)
    except Exception as exc:  # noqa: BLE001
        log.warning("Re-seed for %s failed (%s).", symbol, exc)
    if broadcast_queue is not None:
        await broadcast_queue.put({"type": "symbol_changed", "symbol": symbol})


@app.get("/api/search")
async def api_search(q: str = "", limit: int = 10):
    """Search Yahoo Finance for instruments matching `q`."""
    results = await asyncio.to_thread(feed.search_symbols, q, limit)
    return {"results": results}


# --------------------------------------------------------------------------- #
# WebSocket
# --------------------------------------------------------------------------- #
@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket):
    await websocket.accept()
    active_connections.add(websocket)
    # Send an initial snapshot so the UI populates instantly.
    try:
        quote = await feed.build_quote()
        recent = await db.get_recent_trades(feed.SYMBOL, limit=40)
        await websocket.send_json({"type": "snapshot", "quote": quote, "recent_trades": recent})
    except Exception as exc:  # noqa: BLE001
        log.warning("Snapshot send failed: %s", exc)

    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            if action == "sync_custom":
                notifs = data.get("notifications", [])
                connection_custom_notifications[websocket] = {}
                for n in notifs:
                    nid = n.get("id")
                    if nid:
                        connection_custom_notifications[websocket][nid] = {
                            "id": nid,
                            "name": n.get("name", ""),
                            "enabled": n.get("enabled", True),
                            "repeat": n.get("repeat", "every"),
                            "conditions": n.get("conditions", {}),
                            "fire_count": n.get("fireCount", 0),
                            "last_fired_at": n.get("lastFiredAt"),
                        }
            elif action == "add_custom":
                n = data.get("notification", {})
                nid = n.get("id")
                if nid:
                    connection_custom_notifications.setdefault(websocket, {})[nid] = {
                        "id": nid,
                        "name": n.get("name", ""),
                        "enabled": n.get("enabled", True),
                        "repeat": n.get("repeat", "every"),
                        "conditions": n.get("conditions", {}),
                        "fire_count": n.get("fireCount", 0),
                        "last_fired_at": n.get("lastFiredAt"),
                    }
            elif action == "update_custom":
                n = data.get("notification", {})
                nid = n.get("id")
                if nid and websocket in connection_custom_notifications:
                    existing = connection_custom_notifications[websocket].get(nid)
                    if existing:
                        existing["name"] = n.get("name", existing["name"])
                        existing["enabled"] = n.get("enabled", existing["enabled"])
                        existing["repeat"] = n.get("repeat", existing["repeat"])
                        existing["conditions"] = n.get("conditions", existing["conditions"])
            elif action == "remove_custom":
                nid = data.get("id")
                if nid and websocket in connection_custom_notifications:
                    connection_custom_notifications[websocket].pop(nid, None)
            elif action == "set_alert":
                # Legacy simple price alert — kept for API compatibility.
                try:
                    connection_alerts[websocket] = float(data["price"])
                except (KeyError, ValueError, TypeError):
                    pass
            elif action == "clear_alert":
                connection_alerts.pop(websocket, None)
    except WebSocketDisconnect:
        pass
    finally:
        await _remove_connection(websocket)
