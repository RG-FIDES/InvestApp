"use client";

import { useEffect, useRef, useState } from "react";
import { useMarketStore } from "../lib/store";
import { fetchMarkets, searchSymbols, setActiveSymbol } from "../lib/api";
import { getLocalMarketState, marketStateLabel } from "../lib/types";

function _detectMarket(exchange: string | undefined): string {
  if (!exchange) return "";
  const e = exchange.toUpperCase();
  if (e.includes("NASDAQ") || e.includes("NMS") || e.includes("ARCA") || e.includes("AMEX") || e.includes("BATS") || e.includes("BZX")) {
    return "US";
  }
  if (e.includes("NYSE") || e.includes("NYQ")) {
    return "NYSE";
  }
  if (e.includes("TSE") || e.includes("TOKYO")) {
    return "TSE";
  }
  if (e.includes("LSE") || e.includes("LONDON")) {
    return "LSE";
  }
  return "";
}

export default function Watchlist() {
  const markets = useMarketStore((s) => s.markets);
  const setMarkets = useMarketStore((s) => s.setMarkets);
  const selectedMarket = useMarketStore((s) => s.selectedMarket);
  const setSelectedMarket = useMarketStore((s) => s.setSelectedMarket);
  const trackedStocks = useMarketStore((s) => s.trackedStocks);
  const activeSymbol = useMarketStore((s) => s.activeSymbol);
  const setActiveSymbolStore = useMarketStore((s) => s.setActiveSymbol);
  const addTrackedStock = useMarketStore((s) => s.addTrackedStock);
  const removeTrackedStock = useMarketStore((s) => s.removeTrackedStock);
  const stockMeta = useMarketStore((s) => s.stockMeta);
  const searchQuery = useMarketStore((s) => s.searchQuery);
  const setSearchQuery = useMarketStore((s) => s.setSearchQuery);
  const searchResults = useMarketStore((s) => s.searchResults);
  const setSearchResults = useMarketStore((s) => s.setSearchResults);
  const searching = useMarketStore((s) => s.searching);
  const setSearching = useMarketStore((s) => s.setSearching);

  const [showResults, setShowResults] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Load the market registry once.
  useEffect(() => {
    if (Object.keys(markets).length === 0) {
      fetchMarkets().then(setMarkets).catch(() => {});
    }
  }, [markets, setMarkets]);

  // Debounced symbol search.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = searchQuery.trim();
    if (q.length < 1) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchSymbols(q, 8, selectedMarket || undefined);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery, setSearchResults, setSearching]);

  // Close the results dropdown on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const handleSelectResult = async (r: { symbol: string; name: string; exchange: string }) => {
    const market = selectedMarket || _detectMarket(r.exchange);
    addTrackedStock({ symbol: r.symbol, name: r.name, market });
    setSearchQuery("");
    setSearchResults([]);
    setShowResults(false);
    await switchTo(r.symbol);
  };

  const switchTo = async (symbol: string) => {
    setActiveSymbolStore(symbol);
    try {
      await setActiveSymbol(symbol);
    } catch {
      /* server will broadcast symbol_changed when ready */
    }
  };

  const filtered = selectedMarket
    ? trackedStocks.filter((t) => t.market === selectedMarket)
    : trackedStocks;

  const countForMarket = (code: string) => {
    if (code === "") return trackedStocks.length;
    return trackedStocks.filter((t) => t.market === code).length;
  };

  const marketEntries = [["", { display: "All Exchanges", city: "Global", flag: "🏛️", currency: "", timezone: "" }] as const,
    ...Object.entries(markets)] as const;

  return (
    <nav className="watchlist">
      {/* ---- Exchange picker cards ---- */}
      <div className="wl-section-header">
        <span className="wl-section-icon">🏢</span>
        <span>Exchange</span>
      </div>
      <div className="wl-market-cards">
        {marketEntries.map(([code, m]) => {
          const count = code === "" ? trackedStocks.length : countForMarket(code);
          const isActive = selectedMarket === code;
          // Show active market state dot for each exchange (client-side calc)
          let state = "CLOSED";
          if (m.timezone) {
            state = getLocalMarketState(m.timezone);
          }
          return (
            <button
              key={code || "__all__"}
              className={`wl-market-card${isActive ? " active" : ""}${code === "" ? " all" : ""}`}
              onClick={() => setSelectedMarket(code)}
              title={
                code === ""
                  ? "Show all tracked stocks"
                  : `${m.display} — ${m.city} · ${m.currency} · ${marketStateLabel(state)}`
              }
            >
              <span className="wl-market-flag">{m.flag || "🏛️"}</span>
              <span className="wl-market-body">
                <span className="wl-market-name">{code === "" ? "All Markets" : m.display}</span>
                {code !== "" && (
                  <span className="wl-market-city">{m.city}</span>
                )}
              </span>
              {code !== "" && (
                <span className={`wl-market-dot state-${state.toLowerCase()}`} />
              )}
              {count > 0 && (
                <span className="wl-market-badge">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ---- Symbol search ---- */}
      <div className="wl-section-header">
        <span className="wl-section-icon">🔍</span>
        <span>Find Stock</span>
      </div>
      <div className="wl-search" ref={boxRef}>
        <input
          type="text"
          className="wl-search-input"
          placeholder="Symbol or name…"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setShowResults(true);
          }}
          onFocus={() => setShowResults(true)}
        />
        {showResults && searchQuery.trim().length > 0 && (
          <div className="wl-search-results">
            {searching && <div className="wl-result muted">Searching…</div>}
            {!searching && searchResults.length === 0 && (
              <div className="wl-result muted">No matches</div>
            )}
            {searchResults.map((r) => (
              <button
                key={r.symbol}
                className="wl-result"
                onClick={() => handleSelectResult(r)}
              >
                <span className="wl-result-sym">{r.symbol}</span>
                <span className="wl-result-name">{r.name}</span>
                <span className="wl-result-exch">{r.exchange}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---- Watchlist items ---- */}
      <div className="wl-section-header">
        <span className="wl-section-icon">⭐</span>
        <span>Watchlist</span>
        <span className="wl-section-count">{filtered.length}</span>
      </div>
      {filtered.map((t) => {
        const meta = stockMeta[t.symbol];
        const state = meta ? getLocalMarketState(meta.timezone) : "CLOSED";
        return (
          <button
            key={t.symbol}
            className={`wl-stock-row${t.symbol === activeSymbol ? " active" : ""}`}
            onClick={() => switchTo(t.symbol)}
            title={`${t.name} — ${marketStateLabel(state)}${meta ? ` · ${meta.exchange}` : ""}`}
          >
            <span className={`wl-stock-dot state-${state.toLowerCase()}`} />
            <span className="wl-stock-sym">{t.symbol}</span>
            <span className="wl-stock-name">{t.name}</span>
            <span
              className="wl-stock-remove"
              role="button"
              aria-label={`Remove ${t.symbol}`}
              onClick={(e) => {
                e.stopPropagation();
                removeTrackedStock(t.symbol);
              }}
            >
              ×
            </span>
          </button>
        );
      })}
      {filtered.length === 0 && (
        <div className="wl-empty">Search to add a stock above</div>
      )}
    </nav>
  );
}
