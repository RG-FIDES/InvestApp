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
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

import db
import feed

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("server")

FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000")

broadcast_queue: Optional[asyncio.Queue] = None
active_connections: set[WebSocket] = set()
connection_alerts: dict[WebSocket, float] = {}
prev_close: Optional[float] = None  # for alert cross-detection


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
        broadcast_queue.task_done()


async def _check_alerts(q: dict) -> None:
    global prev_close
    price = q.get("price")
    for ws, threshold in list(connection_alerts.items()):
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
    allow_origins=[FRONTEND_ORIGIN],
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
            bars = await db.get_today_bars()
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
    q = await db.get_latest_quote()
    return {
        "is_open": (q["market_state"] == "REGULAR") if q else False,
        "market_state": q["market_state"] if q else "CLOSED",
        "as_of": q["as_of"] if q else None,
    }


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
        recent = await db.get_recent_trades(limit=40)
        await websocket.send_json({"type": "snapshot", "quote": quote, "recent_trades": recent})
    except Exception as exc:  # noqa: BLE001
        log.warning("Snapshot send failed: %s", exc)

    try:
        while True:
            data = await websocket.receive_json()
            if data.get("action") == "set_alert":
                try:
                    connection_alerts[websocket] = float(data["price"])
                except (KeyError, ValueError, TypeError):
                    pass
            elif data.get("action") == "clear_alert":
                connection_alerts.pop(websocket, None)
    except WebSocketDisconnect:
        pass
    finally:
        await _remove_connection(websocket)
