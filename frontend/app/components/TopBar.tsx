"use client";

import { useEffect, useState } from "react";
import { useMarketStore } from "../lib/store";
import { setActiveSymbol } from "../lib/api";
import { getLocalMarketState, marketStateLabel } from "../lib/types";

export default function TopBar() {
  const connected = useMarketStore((s) => s.connected);
  const quote = useMarketStore((s) => s.quote);
  const unreadCount = useMarketStore((s) => s.unreadNotificationCount);
  const markNotificationsRead = useMarketStore((s) => s.markNotificationsRead);
  const trackedStocks = useMarketStore((s) => s.trackedStocks);
  const activeSymbol = useMarketStore((s) => s.activeSymbol);
  const setActiveSymbolStore = useMarketStore((s) => s.setActiveSymbol);
  const addTrackedStock = useMarketStore((s) => s.addTrackedStock);
  const stockMeta = useMarketStore((s) => s.stockMeta);
  const [now, setNow] = useState<number | null>(null);
  const [tickerInput, setTickerInput] = useState("");
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Active stock: use the real server-pushed marketState from the quote.
  const activeState = quote?.marketState ?? "CLOSED";
  const stateLabel = marketStateLabel(activeState);

  const tz = quote?.marketTimezone ?? "America/New_York";
  const clock = now
    ? new Date(now).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZone: tz,
        timeZoneName: "short",
      })
    : "";

  const switchTo = async (symbol: string) => {
    setActiveSymbolStore(symbol);
    try {
      await setActiveSymbol(symbol);
    } catch {
      /* server will broadcast symbol_changed when ready */
    }
  };

  const handleAddTicker = async () => {
    const sym = tickerInput.trim().toUpperCase();
    if (!sym) return;
    addTrackedStock({ symbol: sym, name: sym, market: "" });
    setTickerInput("");
    await switchTo(sym);
  };

  /** Compute the dot color class for the given market state. */
  const stateClass = (s: string): string => {
    switch (s) {
      case "REGULAR": return "state-open";
      case "PRE":
      case "POST": return "state-ext";
      default: return "state-closed";
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand">InvestApp</span>
        <div className="topbar-ticker">
          <input
            type="text"
            value={tickerInput}
            onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddTicker();
            }}
            maxLength={10}
            placeholder="SYM"
          />
          <button className="ticker-add" onClick={handleAddTicker} title="Add & switch to symbol">
            +
          </button>
        </div>
        <div className="topbar-chips">
          {trackedStocks.map((t) => {
            const meta = stockMeta[t.symbol];
            const chipState = meta
              ? getLocalMarketState(meta.timezone)
              : "CLOSED";
            return (
              <button
                key={t.symbol}
                className={`topbar-chip ${t.symbol === activeSymbol ? "active" : ""}`}
                onClick={() => switchTo(t.symbol)}
                title={`${t.name} — ${marketStateLabel(chipState)}${meta ? ` · ${meta.exchange}` : ""}`}
              >
                <span className={`chip-dot ${stateClass(chipState)}`} />
                {t.symbol}
                {meta && <span className="chip-exch">{meta.exchange.split(" ")[0]}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="topbar-right">
        <button
          className="topbar-bell"
          onClick={() => {
            setShowNotifPanel((v) => !v);
            markNotificationsRead();
          }}
          title="Notifications"
        >
          🔔
          {unreadCount > 0 && <span className="bell-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </button>
        <span className={`topbar-state ${stateClass(activeState)}`}>
          <span className={`state-dot ${stateClass(activeState)}`} />
          {stateLabel}
        </span>
        <span className="topbar-clock">{clock}</span>
      </div>
    </header>
  );
}
