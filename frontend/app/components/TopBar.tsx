"use client";

import { useEffect, useState } from "react";
import { useMarketStore } from "../lib/store";

export default function TopBar() {
  const connected = useMarketStore((s) => s.connected);
  const quote = useMarketStore((s) => s.quote);
  const [now, setNow] = useState<number | null>(null);
  const [tickerInput, setTickerInput] = useState("MU");

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const stateLabel =
    quote?.marketState === "REGULAR"
      ? "MARKET OPEN"
      : quote?.marketState === "PRE"
      ? "PRE-MARKET"
      : quote?.marketState === "POST"
      ? "AFTER HOURS"
      : "MARKET CLOSED";

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

  const handleAddTicker = () => {
    // TODO: future — add tickerInput to watchlist / switch to that symbol
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
            maxLength={5}
          />
          <button className="ticker-add" onClick={handleAddTicker} title="Add to watchlist">
            +
          </button>
        </div>
      </div>
      <div className="topbar-right">
        <span className="topbar-state">
          <span className="state-dot" />
          {stateLabel}
        </span>
        <span className="topbar-clock">{clock}</span>
      </div>
    </header>
  );
}
