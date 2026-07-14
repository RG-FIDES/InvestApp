"use client";

import { useMarketStore } from "../lib/store";
import { fmtPrice, fmtCompact, fmtPct } from "../lib/format";

type Row = {
  label: string;
  current: number | null;
  average: number | null;
};

function compareRow({ label, current, average }: Row) {
  const has = current != null && average != null && average !== 0;
  const diff = has ? current! - average! : null;
  const pct = has ? (diff! / average!) * 100 : null;
  const up = (diff ?? 0) >= 0;
  const cls = !has ? "" : up ? "up" : "down";
  return (
    <div className="cmp-line">
      <span className="cmp-label">{label}</span>
      <span className="cmp-cur">{current != null ? fmtPrice(current) : "—"}</span>
      <span className="cmp-avg">{average != null ? fmtPrice(average) : "—"}</span>
      <span className={`cmp-delta ${cls}`}>
        {pct != null ? `${fmtPct(pct)}` : "—"}
      </span>
    </div>
  );
}

export default function ComparisonPanel() {
  const q = useMarketStore((s) => s.quote);
  if (!q) return null;

  return (
    <section className="panel comparison">
      <div className="panel-title">Price &amp; Volume vs Average</div>

      <div className="cmp-block">
        <div className="cmp-head">Last 3 Days</div>
        {compareRow({ label: "Price", current: q.price, average: q.avgPrice3d })}
        {compareRow({ label: "Volume", current: q.volume, average: q.avgVolume3d })}
      </div>

      <div className="cmp-block">
        <div className="cmp-head">Last 3 Months</div>
        {compareRow({ label: "Price", current: q.price, average: q.avgPrice3m })}
        {compareRow({ label: "Volume", current: q.volume, average: q.avgVolume3m })}
      </div>

      <div className="cmp-foot muted">
        Current vs avg {fmtCompact(q.avgVolume3d)} (3D) · {fmtCompact(q.avgVolume3m)} (3M)
      </div>
    </section>
  );
}
