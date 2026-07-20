"use client";

import { useEffect, useState } from "react";
import { useMarketStore } from "../lib/store";
import { fmtPrice, fmtSigned, fmtPct } from "../lib/format";

export default function QuoteHeader() {
  const quote = useMarketStore((s) => s.quote);
  const lastTickDir = useMarketStore((s) => s.lastTickDir);

  // Clock tick for live time display — must be above any conditional return.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!quote) {
    return (
      <section className="quote-header">
        <div className="qh-loading">Loading quote…</div>
      </section>
    );
  }

  const closePrice = quote.price;          // regular market close / live during REGULAR
  const currentPrice = quote.currentPrice; // latest trade incl. extended hours

  // Change from previous session close (always the primary change display).
  const change = quote.change;
  const pct = quote.changePercent;
  const up = (change ?? 0) >= 0;
  const dirClass = up ? "up" : "down";
  const flashClass =
    lastTickDir === "up" ? "flash-up" : lastTickDir === "down" ? "flash-down" : "";

  // Change from today's close for the extended/overnight price.
  const hasExt = currentPrice != null && closePrice != null && currentPrice !== closePrice;
  const extChange =
    hasExt && closePrice != null ? round(currentPrice! - closePrice) : null;
  const extPct =
    hasExt && closePrice != null && closePrice !== 0
      ? round(((currentPrice! - closePrice) / closePrice) * 100)
      : null;
  const extUp = (extChange ?? 0) >= 0;

  const isPre = quote.marketState === "PRE";
  const isPost = quote.marketState === "POST";
  const isRegular = quote.marketState === "REGULAR";
  const isExtended = isPre || isPost;

  const tz = quote.marketTimezone ?? "America/New_York";
  const fmtTime = (iso: string | null) => {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZone: tz,
      timeZoneName: "short",
    });
  };

  // Main label: describes the primary price being shown.
  const closeLabel = isRegular
    ? "As of " + fmtTime(quote.asOf)
    : "At close";
  // Extended/overnight label
  const extLabel = isPre
    ? "Pre‑Market"
    : isPost
    ? "After‑Hours"
    : "Overnight";
  const extTime = hasExt ? fmtTime(quote.asOf) : "";

  return (
    <section className="quote-header">
      {/* ---- Top meta row ---- */}
      <div className="qh-meta">
        <span className="qh-exchange">{quote.exchange} · Real-Time</span>
        <span className="qh-currency">{quote.currency}</span>
        <span className={`qh-state-pill ${isRegular ? "open" : isExtended ? "ext" : "closed"}`}>
          {isRegular ? "● Live" : isPre ? "◉ Pre‑Market" : isPost ? "◉ After‑Hours" : "◉ Closed"}
        </span>
      </div>

      {/* ---- Title ---- */}
      <div className="qh-title-row">
        <h1 className="qh-name">
          {quote.name} <span className="qh-ticker">({quote.symbol})</span>
        </h1>
        <span className={`qh-badge ${dirClass}`}>
          {up ? "▲" : "▼"} {fmtSigned(change)} ({fmtPct(pct)})
        </span>
      </div>

      {/* ---- Close / live price row ---- */}
      <div className="qh-price-row">
        <span className={`qh-price ${flashClass}`}>${fmtPrice(closePrice)}</span>
        <span className={`qh-change ${dirClass}`}>
          {fmtSigned(change)} ({fmtPct(pct)})
        </span>
      </div>
      <div className="qh-price-label">{closeLabel}</div>

      {/* ---- Extended / overnight price row (only when different from close) ---- */}
      {hasExt && (
        <div className="qh-ext-row">
          <span className="qh-ext-price">${fmtPrice(currentPrice)}</span>
          <span className={`qh-ext-change ${extUp ? "up" : "down"}`}>
            {extUp ? "▲" : "▼"} {fmtSigned(extChange)} ({fmtPct(extPct)})
          </span>
          <span className="qh-ext-label">{extLabel} · {extTime}</span>
        </div>
      )}
    </section>
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
