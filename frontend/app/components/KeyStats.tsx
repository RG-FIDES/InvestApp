"use client";

import { useMarketStore } from "../lib/store";
import { fmtPrice, fmtCompact, fmtInt } from "../lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="kstat">
      <div className="kstat-label">{label}</div>
      <div className="kstat-value">{value}</div>
    </div>
  );
}

export default function KeyStats() {
  const q = useMarketStore((s) => s.quote);
  if (!q) return null;

  const bidAsk =
    q.bid != null && q.ask != null ? `${fmtPrice(q.bid)} x ${fmtPrice(q.ask)}` : "—";
  const dayRange =
    q.dayLow != null && q.dayHigh != null ? `${fmtPrice(q.dayLow)} - ${fmtPrice(q.dayHigh)}` : "—";
  const yrRange =
    q.fiftyTwoWeekLow != null && q.fiftyTwoWeekHigh != null
      ? `${fmtPrice(q.fiftyTwoWeekLow)} - ${fmtPrice(q.fiftyTwoWeekHigh)}`
      : "—";

  return (
    <section className="panel keystats">
      <div className="panel-title">Key Statistics</div>
      <div className="kstat-grid">
        <Stat label="Previous Close" value={fmtPrice(q.prevClose)} />
        <Stat label="Open" value={fmtPrice(q.open)} />
        <Stat label="Bid" value={q.bid != null ? fmtPrice(q.bid) : "—"} />
        <Stat label="Ask" value={q.ask != null ? fmtPrice(q.ask) : "—"} />
        <Stat label="Day's Range" value={dayRange} />
        <Stat label="52 Week Range" value={yrRange} />
        <Stat label="Volume" value={fmtCompact(q.volume)} />
        <Stat label="Avg. Volume (3D)" value={fmtCompact(q.avgVolume3d)} />
        <Stat label="Avg. Volume (3M)" value={fmtCompact(q.avgVolume3m)} />
        <Stat label="Market Cap" value={fmtCompact(q.marketCap)} />
        <Stat label="P/E (TTM)" value={q.peRatio != null ? q.peRatio.toFixed(2) : "—"} />
      </div>
    </section>
  );
}
