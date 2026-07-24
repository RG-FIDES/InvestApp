"""
config.py — Instrument + market configuration for InvestApp.

The app is being built so that *any* stock on *any* market (NASDAQ, Tokyo,
London, …) can be tracked by simply adding an entry here — no other code
changes are required elsewhere. This is the single place to "register" a new
market or point the app at a different symbol.

How to add a new market later
-----------------------------
1. Append an entry to MARKETS below (key = short code, value = timezone +
   display name + currency).
2. Point SYMBOL at a ticker that trades on that market (set the SYMBOL env
   var, or change the default).
That's it — feed.py, main.py and the entire frontend become market-agnostic
automatically (timezone-aware market hours, currency, exchange label).

Only the default market ("US" / MU) is actually configured today; the others
are registered so the structure is ready and they can be activated on demand.
"""

from __future__ import annotations

import os

# The ticker the app currently tracks. Override with the SYMBOL env var to
# point at a different instrument without touching code.
SYMBOL = os.getenv("SYMBOL", "MU")

# Which registered market SYMBOL trades on. Override with the MARKET env var.
DEFAULT_MARKET = os.getenv("MARKET", "US")

# Registry of supported markets. Adding a market = appending one entry.
#   timezone : IANA tz used for market-hours math + UI clocks
#   display  : exchange label shown in the quote header (e.g. "NasdaqGS")
#   currency : ISO currency code for price formatting
MARKETS: dict[str, dict[str, str]] = {
    "US": {
        "timezone": "America/New_York",
        "display": "NasdaqGS",
        "currency": "USD",
        "city": "New York",
        "flag": "🇺🇸",
    },
    "NYSE": {
        "timezone": "America/New_York",
        "display": "NYSE",
        "currency": "USD",
        "city": "New York",
        "flag": "🇺🇸",
    },
    "TSE": {
        "timezone": "Asia/Tokyo",
        "display": "TSE",
        "currency": "JPY",
        "city": "Tokyo",
        "flag": "🇯🇵",
    },
    "LSE": {
        "timezone": "Europe/London",
        "display": "LSE",
        "currency": "GBP",
        "city": "London",
        "flag": "🇬🇧",
    },
    # Add more markets here as needed (e.g. "FRA", "HKEX", "EURONEXT") …
}

# Resolve the active market; fall back to US if an unknown code is given.
MARKET = MARKETS.get(DEFAULT_MARKET, MARKETS["US"])
MARKET_CODE = DEFAULT_MARKET if DEFAULT_MARKET in MARKETS else "US"
MARKET_TIMEZONE = MARKET["timezone"]
MARKET_DISPLAY = MARKET["display"]
MARKET_CURRENCY = MARKET["currency"]
