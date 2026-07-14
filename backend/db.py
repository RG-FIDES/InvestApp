"""
db.py — SQLite persistence layer for InvestApp (rebuilt).

Single source of truth for market data. The frontend never talks to the
market-data provider directly; it reads from here (via the FastAPI server).

All functions are async (aiosqlite) and safe to call from the single
FastAPI/uvicorn event loop. WAL mode lets REST readers never block the
writer (the live feed), which is critical for sub-minute latency.

Tables
------
mu_bars   : 1-minute OHLCV candles (PK = symbol + timestamp) for MU.
mu_quotes : latest quote *snapshot* each tick (price, change, prevClose,
            open, dayHigh, dayLow, bid, ask, volume, marketState, asOf…).
mu_trades : live "last sale" prints (time & sales tape).

A `symbol` column is present on every table so the schema is ready for
multi-stock support; v1 only ever streams "MU".

Timestamps are stored as UTC ISO-8601 strings ("2026-07-11T13:30:00+00:00").
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

import aiosqlite

DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), "market_data.db")
DB_PATH = os.environ.get("MARKET_DB_PATH", DEFAULT_DB_PATH)

DEFAULT_SYMBOL = "MU"

_connection: Optional[aiosqlite.Connection] = None


# --------------------------------------------------------------------------- #
# Connection / schema
# --------------------------------------------------------------------------- #
async def init_db(path: str = DB_PATH) -> aiosqlite.Connection:
    """Open the DB, enable WAL, create tables, and cache the connection."""
    global _connection
    conn = await aiosqlite.connect(path)
    await conn.execute("PRAGMA journal_mode=WAL")
    await conn.execute("PRAGMA synchronous=NORMAL")
    await conn.execute("PRAGMA busy_timeout=5000")
    await _create_schema(conn)
    await conn.commit()
    _connection = conn
    return conn


def get_connection() -> aiosqlite.Connection:
    if _connection is None:
        raise RuntimeError("DB not initialized. Call init_db() during startup.")
    return _connection


async def close_db() -> None:
    global _connection
    if _connection is not None:
        await _connection.close()
        _connection = None


async def _create_schema(conn: aiosqlite.Connection) -> None:
    # Drop any pre-existing tables first. The previous InvestApp used a
    # different mu_quotes schema (bid/ask only, no price/change), and
    # `CREATE TABLE IF NOT EXISTS` would otherwise preserve that stale
    # layout and break the new inserts. Data is fully regenerated from the
    # Yahoo feed on startup, so dropping is safe.
    await conn.executescript(
        """
        DROP TABLE IF EXISTS mu_bars;
        DROP TABLE IF EXISTS mu_quotes;
        DROP TABLE IF EXISTS mu_trades;

        CREATE TABLE mu_bars (
            symbol    TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            open      REAL NOT NULL,
            high      REAL NOT NULL,
            low       REAL NOT NULL,
            close     REAL NOT NULL,
            volume    INTEGER NOT NULL,
            PRIMARY KEY (symbol, timestamp)
        );

        CREATE TABLE IF NOT EXISTS mu_quotes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol      TEXT NOT NULL,
            timestamp   TEXT NOT NULL,
            price       REAL NOT NULL,
            change      REAL,
            change_pct  REAL,
            prev_close  REAL,
            open        REAL,
            day_high    REAL,
            day_low     REAL,
            bid         REAL,
            ask         REAL,
            bid_size    INTEGER,
            ask_size    INTEGER,
            volume      INTEGER,
            market_state TEXT,
            as_of       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mu_quotes_sym_ts ON mu_quotes(symbol, timestamp);

        CREATE TABLE IF NOT EXISTS mu_trades (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol    TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            price     REAL NOT NULL,
            size      INTEGER NOT NULL,
            exchange  TEXT,
            condition TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mu_trades_sym_ts ON mu_trades(symbol, timestamp);
        """
    )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _to_iso(ts) -> str:
    if isinstance(ts, datetime):
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc).isoformat()
    return str(ts)


# --------------------------------------------------------------------------- #
# Inserts (called by feed.py)
# --------------------------------------------------------------------------- #
async def insert_bar(symbol: str, timestamp, open_, high, low, close, volume) -> None:
    conn = get_connection()
    await conn.execute(
        """
        INSERT OR REPLACE INTO mu_bars (symbol, timestamp, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (symbol, _to_iso(timestamp), float(open_), float(high), float(low), float(close), int(volume)),
    )
    await conn.commit()


async def insert_quote(symbol: str, timestamp, price, change, change_pct, prev_close,
                       open_, day_high, day_low, bid, ask, bid_size, ask_size,
                       volume, market_state, as_of) -> None:
    conn = get_connection()
    await conn.execute(
        """
        INSERT INTO mu_quotes
            (symbol, timestamp, price, change, change_pct, prev_close, open,
             day_high, day_low, bid, ask, bid_size, ask_size, volume, market_state, as_of)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (symbol, _to_iso(timestamp), float(price), _none(change), _none(change_pct),
         _none(prev_close), _none(open_), _none(day_high), _none(day_low),
         _none(bid), _none(ask), _none(bid_size), _none(ask_size), _none(volume),
         market_state, as_of),
    )
    await conn.commit()


async def insert_trade(symbol: str, timestamp, price, size, exchange=None, condition=None) -> None:
    conn = get_connection()
    await conn.execute(
        """
        INSERT INTO mu_trades (symbol, timestamp, price, size, exchange, condition)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (symbol, _to_iso(timestamp), float(price), int(size), exchange, condition),
    )
    await conn.commit()


def _none(v):
    return None if v is None else v


# --------------------------------------------------------------------------- #
# Queries (called by main.py / REST)
# --------------------------------------------------------------------------- #
_BAR_COLS = ("symbol", "timestamp", "open", "high", "low", "close", "volume")
_TRADE_COLS = ("symbol", "timestamp", "price", "size", "exchange", "condition")


async def get_today_bars(symbol: str = DEFAULT_SYMBOL):
    """All 1-min bars for `symbol` ordered oldest -> newest (intraday chart)."""
    conn = get_connection()
    async with conn.execute(
        f"SELECT {', '.join(_BAR_COLS)} FROM mu_bars "
        "WHERE symbol = ? ORDER BY timestamp ASC",
        (symbol,),
    ) as cur:
        rows = await cur.fetchall()
    return [dict(zip(_BAR_COLS, r)) for r in rows]


async def get_latest_quote(symbol: str = DEFAULT_SYMBOL):
    """Most recent quote snapshot (None if no quotes yet)."""
    conn = get_connection()
    async with conn.execute(
        "SELECT id, symbol, timestamp, price, change, change_pct, prev_close, open, "
        "day_high, day_low, bid, ask, bid_size, ask_size, volume, market_state, as_of "
        "FROM mu_quotes WHERE symbol = ? ORDER BY id DESC LIMIT 1",
        (symbol,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        return None
    cols = ("id", "symbol", "timestamp", "price", "change", "change_pct", "prev_close",
            "open", "day_high", "day_low", "bid", "ask", "bid_size", "ask_size",
            "volume", "market_state", "as_of")
    return dict(zip(cols, row))


async def get_recent_trades(symbol: str = DEFAULT_SYMBOL, limit: int = 60):
    """Most recent `limit` trades for `symbol`, oldest -> newest for tape display."""
    conn = get_connection()
    async with conn.execute(
        f"SELECT {', '.join(_TRADE_COLS)} FROM mu_trades "
        "WHERE symbol = ? ORDER BY id DESC LIMIT ?",
        (symbol, limit),
    ) as cur:
        rows = await cur.fetchall()
    rows.reverse()
    return [dict(zip(_TRADE_COLS, r)) for r in rows]
