"use client";

import { useMarketStore } from "../lib/store";
import { fmtPrice, fmtInt } from "../lib/format";

export default function NbboPanel() {
  const q = useMarketStore((s) => s.quote);
  if (!q) return null;

  const spread = q.bid != null && q.ask != null ? q.ask - q.bid : null;

  return (
    <section className="panel nbbo">
      <div className="panel-title">NBBO Quote</div>
      <div className="nbbo-grid">
        <div className="nbbo-cell bid">
          <div className="nbbo-label">Bid</div>
          <div className="nbbo-value">{q.bid != null ? fmtPrice(q.bid) : "—"}</div>
          <div className="nbbo-sub">{q.bidSize != null ? `${fmtInt(q.bidSize)} @` : "—"}</div>
        </div>
        <div className="nbbo-cell ask">
          <div className="nbbo-label">Ask</div>
          <div className="nbbo-value">{q.ask != null ? fmtPrice(q.ask) : "—"}</div>
          <div className="nbbo-sub">{q.askSize != null ? `${fmtInt(q.askSize)} @` : "—"}</div>
        </div>
      </div>
      <div className="nbbo-spread">
        Spread: {spread != null ? fmtPrice(spread) : "—"}
      </div>
    </section>
  );
}
