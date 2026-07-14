"use client";

import { useMarketStore } from "../lib/store";
import { fmtPrice, fmtInt, fmtET } from "../lib/format";

const EXCHANGE_LABELS: Record<string, string> = {
  XNAS: "NSDQ",
  XNYS: "NYSE",
  ARCX: "ARCA",
  BATS: "BATS",
  XCHI: "CHIX",
  XCIS: "CISX",
  XAMS: "AEB",
  XLON: "LSE",
  XTKS: "TSE",
  XHKG: "HKEX",
  XPAR: "EUR",
  XFRA: "FRA",
};
function fmtExchange(ex: string | null | undefined): string {
  if (!ex) return "";
  const e = ex.toUpperCase().trim();
  return EXCHANGE_LABELS[e] ?? e.slice(0, 4);
}

export default function TradesTape() {
  const trades = useMarketStore((s) => s.trades);
  const quote = useMarketStore((s) => s.quote);
  const prevClose = quote?.prevClose ?? null;
  const tz = quote?.marketTimezone ?? "America/New_York";

  // Newest deal on the left; cap the visible strip for performance.
  const recent = trades.length ? [...trades].slice(-50).reverse() : [];

  // Duplicate list for seamless marquee loop (needs at least 2 * width).
  const marqueeItems = recent.length > 2 ? [...recent, ...recent] : recent;

  return (
    <section className="panel tape tape-horizontal">
      <div className="panel-title">Time &amp; Sales</div>
      <div
        className={`tape-track-wrap ${recent.length > 2 ? "marquee" : ""}`}
      >
        <div className="tape-track">
          {marqueeItems.length === 0 && (
            <div className="muted tape-empty">Waiting for live trades…</div>
          )}
          {marqueeItems.map((t, i) => {
            const up = prevClose != null ? t.price >= prevClose : t.price >= 0;
            return (
              <div
                className={`deal ${up ? "up" : "down"}`}
                key={`${t.timestamp}-${i}`}
              >
                <div className="deal-top">
                  <span className="deal-arrow">{up ? "▲" : "▼"}</span>
                  <span className="deal-price">{fmtPrice(t.price)}</span>
                  <span className={`deal-badge ${up ? "up" : "down"}`}>
                    {fmtExchange(t.exchange)}
                  </span>
                </div>
                <div className="deal-bottom">
                  <span className="deal-size">{fmtInt(t.size)}</span>
                  <span className="deal-time">{fmtET(t.timestamp, tz)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
