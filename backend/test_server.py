"""
test_server.py — server smoke test (no Alpaca credentials required).

Boots the FastAPI app via TestClient (which runs the lifespan: init DB,
attempt backfill [skipped w/o creds], spawn ingestion + broadcaster), then
hits the REST endpoints and opens the WebSocket to confirm the snapshot.
"""

import os
import tempfile

# Isolate this test's DB so the demo seeder (no Alpaca creds) doesn't pollute
# the real market_data.db or other tests' data.
_fd, _tmp = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.remove(_tmp)
os.environ["MARKET_DB_PATH"] = _tmp

from fastapi.testclient import TestClient

import main  # noqa: E402  (imported after MARKET_DB_PATH is set)


def _main() -> None:
    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200
        hist = client.get("/api/history")
        assert hist.status_code == 200
        assert isinstance(hist.json(), list)
        stats = client.get("/api/stats").json()
        assert "last_price" in stats and "vwap" in stats

        with client.websocket_connect("/ws/live") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "snapshot", msg
            assert "stats" in msg and "recent_trades" in msg

    print("SERVER SMOKE TEST PASSED ✅")
    print("  /api/stats:", stats)


if __name__ == "__main__":
    _main()
