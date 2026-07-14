"use client";

import { useMarketStore } from "../lib/store";
import { fmtPrice, fmtSigned, fmtPct, fmtET } from "../lib/format";

export default function QuoteHeader() {
  const quote = useMarketStore((s) => s.quote);
  const lastTickDir = useMarketStore((s) => s.lastTickDir);

  if (!quote) {
    return (
      <section className="quote-header">
        <div className="qh-loading">Loading quote…</div>
      </section>
    );
  }

  const price = quote.price;
  const change = quote.change;
  const pct = quote.changePercent;
  const up = (change ?? 0) >= 0;
  const dirClass = up ? "up" : "down";
  const flashClass = lastTickDir === "up" ? "flash-up" : lastTickDir === "down" ? "flash-down" : "";

  const showPrePost = quote.marketState === "PRE" || quote.marketState === "POST";
  const sessionLabel =
    quote.marketState === "PRE" ? "Pre-Market" : quote.marketState === "POST" ? "After-Hours" : "At Close";
  const tz = quote.marketTimezone ?? "America/New_York";

  return (
    <section className="quote-header">
      <div className="qh-meta">
        <span className="qh-exchange">{quote.exchange} · Real-Time</span>
        <span className="qh-currency">{quote.currency}</span>
      </div>

      <div className="qh-title-row">
        <h1 className="qh-name">
          {quote.name} <span className="qh-ticker">({quote.symbol})</span>
        </h1>
        <span className={`qh-badge ${dirClass}`}>
          {up ? "▲" : "▼"} {fmtSigned(change)} ({fmtPct(pct)})
        </span>
      </div>

      <div className="qh-price-row">
        <span className={`qh-price ${flashClass}`}>${fmtPrice(price)}</span>
        <span className={`qh-change ${dirClass}`}>
          {fmtSigned(change)} ({fmtPct(pct)})
        </span>
      </div>

      <div className="qh-sub">
        {showPrePost ? (
          <span>
            <strong>{sessionLabel}:</strong> {fmtET(quote.asOf, tz)}
          </span>
        ) : (
          <span>As of {fmtET(quote.asOf, tz)}</span>
        )}
        <span className="qh-prevclose">Prev Close: ${fmtPrice(quote.prevClose)}</span>
      </div>
    </section>
  );
}
