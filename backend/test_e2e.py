"""
test_e2e.py — end-to-end server pipeline test (no Alpaca needed).

Simulates the live data path without a real market feed:
  1. Seeds SQLite with known bars/trades/quotes.
  2. Boots the app via TestClient (lifespan: init DB, spawn broadcaster).
  3. Asserts /api/history, /api/stats math, and the WS snapshot payload.
  4. Feeds a synthetic bar into the broadcast queue and confirms it is fanned
     out to a connected WebSocket.
  5. Sets a price alert, feeds a crossing bar, and confirms the alert fires.

The only untested link here is the Alpaca->DB ingestion (blocked by the local
numpy/App-Control policy and requiring live creds); that code path is covered
by unit review + the live smoke path in test_server.py.
"""

import asyncio
import os
import tempfile

# Isolate this test's DB so the demo seeder (no Alpaca creds) doesn't pollute
# the real market_data.db or overwrite the 3 bars we seed below.
_fd, _tmp = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.remove(_tmp)
os.environ["MARKET_DB_PATH"] = _tmp

from fastapi.testclient import TestClient

import database as db  # noqa: E402  (imported after MARKET_DB_PATH is set)
import main  # noqa: E402


async def _seed() -> None:
    await db.init_db()
    bars = [
        ("MU", "2026-07-09T13:30:00+00:00", 30, 30, 30, 30, 100),
        ("MU", "2026-07-09T13:31:00+00:00", 35, 35, 35, 35, 100),
        ("MU", "2026-07-09T13:32:00+00:00", 40, 40, 40, 40, 100),
    ]
    await db.bulk_insert_bars(bars)
    await db.insert_trade("MU", "2026-07-09T13:32:30+00:00", 40.5, 500, "X", " ")
    await db.insert_quote("MU", "2026-07-09T13:32:31+00:00", 39.9, 40.2, 100, 200)


def _run() -> None:
    asyncio.run(_seed())

    with TestClient(main.app) as client:
        # ---- REST ----
        history = client.get("/api/history").json()
        assert len(history) == 3, history
        stats = client.get("/api/stats").json()
        # vwap over last 3 days (all 3 bars) = (30*100+35*100+40*100)/300 = 35
        assert abs(stats["vwap"] - 35.0) < 1e-9, stats
        assert stats["volume_3d"] == 300, stats
        assert stats["today_volume"] == 300, stats
        assert stats["last_price"] == 40.0, stats
        assert stats["bid"] == 39.9 and stats["ask"] == 40.2, stats

        # ---- WS snapshot + broadcaster fan-out + alert ----
        with client.websocket_connect("/ws/live") as ws:
            snapshot = ws.receive_json()
            assert snapshot["type"] == "snapshot"
            assert len(snapshot["recent_trades"]) == 1
            assert snapshot["stats"]["last_price"] == 40.0

            # Set an alert at 38; previous close is 40 (last bar).
            ws.send_json({"action": "set_alert", "price": 38})

            # Feed a bar that crosses DOWN through 38 (40 -> 35).
            main.prev_close = 40.0
            main.broadcast_queue.put_nowait(
                {
                    "type": "bar",
                    "symbol": "MU",
                    "timestamp": "2026-07-09T13:33:00+00:00",
                    "open": 40,
                    "high": 40,
                    "low": 35,
                    "close": 35,
                    "volume": 100,
                }
            )

            # Expect: the echoed bar, then the alert message.
            got_bar = False
            got_alert = False
            for _ in range(5):
                msg = ws.receive_json()
                if msg["type"] == "bar":
                    got_bar = True
                elif msg["type"] == "alert":
                    got_alert = True
                    assert "38.00" in msg["message"], msg
                if got_bar and got_alert:
                    break
            assert got_bar, "broadcaster did not fan out the bar"
            assert got_alert, "alert did not fire on crossing bar"

    print("E2E PIPELINE TEST PASSED ✅")
    print("  /api/stats:", stats)


if __name__ == "__main__":
    _run()
