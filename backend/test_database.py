"""
test_database.py — local sanity test for the DB layer (no Alpaca needed).

Run:
    python test_database.py

It spins up a throwaway SQLite file, inserts known data, and asserts the
VWAP / volume math and the various getters behave correctly.
"""

import asyncio
import os
import tempfile

import database as db


async def _main() -> None:
    # Use a temp file so we never touch market_data.db.
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.remove(tmp)  # aiosqlite will create it
    try:
        await db.init_db(tmp)

        # ---- Bars across 3 trading days (we pretend each day has 2 bars) ----
        # Day 1: 100 vol @ 10, 100 vol @ 20  -> vwap day1 = 15
        # Day 2: 200 vol @ 10, 200 vol @ 20  -> vwap day2 = 15, cum vol 400
        # Day 3: 300 vol @ 30, 300 vol @ 40  -> vwap day3 = 35, cum vol 600
        bars = [
            ("MU", "2026-07-07T13:30:00+00:00", 10, 10, 10, 10, 100),
            ("MU", "2026-07-07T13:31:00+00:00", 20, 20, 20, 20, 100),
            ("MU", "2026-07-08T13:30:00+00:00", 10, 10, 10, 10, 200),
            ("MU", "2026-07-08T13:31:00+00:00", 20, 20, 20, 20, 200),
            ("MU", "2026-07-09T13:30:00+00:00", 30, 30, 30, 30, 300),
            ("MU", "2026-07-09T13:31:00+00:00", 40, 40, 40, 40, 300),
        ]
        await db.bulk_insert_bars(bars)

        # ---- Trades + quotes ----
        await db.insert_trade("MU", "2026-07-09T13:31:30+00:00", 40.5, 500, "X", " ")
        await db.insert_trade("MU", "2026-07-09T13:31:31+00:00", 40.6, 700, "X", " ")
        await db.insert_quote("MU", "2026-07-09T13:31:31+00:00", 40.4, 40.7, 100, 200)

        # ---- Assertions ----
        history = await db.get_history_3mo()
        assert len(history) == 6, f"expected 6 bars, got {len(history)}"

        stats = await db.get_3day_vwap_and_volume()
        # 3-day volume = 100+100 + 200+200 + 300+300 = 1200
        assert stats["volume_3d"] == 1200, stats
        # 3-day VWAP = (100*10+100*20 + 200*10+200*20 + 300*30+300*40)/1200
        expected_vwap = (100*10 + 100*20 + 200*10 + 200*20 + 300*30 + 300*40) / 1200
        assert abs(stats["vwap"] - expected_vwap) < 1e-9, stats
        # current bar volume = last bar = 300
        assert stats["current_bar_volume"] == 300, stats
        # today volume (latest day 2026-07-09) = 300+300 = 600
        assert stats["today_volume"] == 600, stats
        # last close = 40
        assert stats["last_close"] == 40, stats

        trades = await db.get_recent_trades(limit=10)
        assert len(trades) == 2
        assert trades[0]["price"] == 40.5 and trades[-1]["price"] == 40.6

        quotes = await db.get_latest_quote()
        assert quotes["bid"] == 40.4 and quotes["ask"] == 40.7

        recent_quotes = await db.get_recent_quotes(limit=10)
        assert len(recent_quotes) == 1

        print("ALL DB SANITY CHECKS PASSED ✅")
        print("  stats:", stats)
    finally:
        await db.close_db()
        for ext in ("", "-wal", "-shm"):
            p = tmp + ext
            if os.path.exists(p):
                os.remove(p)


if __name__ == "__main__":
    asyncio.run(_main())
