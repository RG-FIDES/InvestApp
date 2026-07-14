"""
fundamentals.py — Slow-moving company fundamentals for the quote page.

These values change at most a few times a quarter (P/E, EPS, dividend, target,
beta, shares outstanding, sector/industry). They are hard-coded for v1 (the
app tracks a single symbol, MU) so the quote page looks complete without a
paid fundamentals API. Market cap is computed live from price * shares.

To refresh, update the numbers below (or later swap this module for a
quoteSummary fetch).
"""

from __future__ import annotations

SYMBOL = "MU"
NAME = "Micron Technology, Inc."
EXCHANGE = "NasdaqGS"
CURRENCY = "USD"
SECTOR = "Technology"
INDUSTRY = "Semiconductors"
WEBSITE = "https://www.micron.com"
EMPLOYEES = 53000
FISCAL_YEAR_ENDS = "August 28"
DESCRIPTION = (
    "Micron Technology, Inc. designs, develops, manufactures, and sells memory "
    "and storage products worldwide. It operates through the Cloud Memory, Core "
    "Data Center, Mobile and Client, and Automotive and Embedded business units, "
    "offering DRAM, NAND, and storage products under the Micron and Crucial brands."
)

# Used to compute a live market cap (shares outstanding x price).
SHARES_OUTSTANDING = 11.26e9

# Static valuation / risk metrics (approximate, refresh periodically).
PE_RATIO = 22.13
EPS = 42.35
BETA = 2.14
DIVIDEND = 0.53
DIVIDEND_YIELD = 0.05  # percent
TARGET = 1486.00
EX_DIVIDEND_DATE = "Jul 6, 2026"
EARNINGS_DATE = "Sep 23, 2026"

# Trailing performance vs S&P 500 (Yahoo-style "Performance" panel).
PERFORMANCE = {
    "ytd": {"stock": 228.49, "bench": 9.79},
    "one_year": {"stock": 653.64, "bench": 20.06},
    "three_year": {"stock": 1368.26, "bench": 71.30},
}
