"use client";

import { useMarketStore } from "../lib/store";
import { fmtPrice, fmtInt, fmtET } from "../lib/format";

const EXCHANGE_LABELS: Record<string, string> = {
  XNAS: "NSDQ", XNYS: "NYSE", ARCX: "ARCA", BATS: "BATS",
  XCHI: "CHIX", XCIS: "CISX", XAMS: "AEB", XLON: "LSE",
  XTKS: "TSE", XHKG: "HKEX", XPAR: "EUR", XFRA: "FRA",
};
function fmtExchange(ex: string | null | undefined): string {
  if (!ex) return "";
  const e = ex.toUpperCase().trim();
  return EXCHANGE_LABELS[e] ?? e.slice(0, 4);
}

/** Condition code label: @ = regular sale, T = extended hours, others raw. */
function fmtCond(c: string | null | undefined): string {
  if (!c) return "";
  if (c === "@") return "";       // regular — implied
  if (c === "T") return "EXT";    // extended hours (pre/post)
  return c;
}

export default function TradesTape() {
  const trades = useMarketStore((s) => s.trades);
  const quote = useMarketStore((s) => s.quote);
  const prevClose = quote?.prevClose ?? null;
  const tz = quote?.marketTimezone ?? "America/New_York";

  // Newest on the left — cap at 60, show real bar-level data.
  const recent = trades.length ? [...trades].slice(-60).reverse() : [];

  // When market is closed and no fresh bars, the tape should be empty —
  // honest and not misleading.
  if (recent.length === 0) {
    return (
      <section className="panel tape tape-horizontal">
        <div className="panel-title">Time &amp; Sales</div>
        <div className="tape-track-wrap">
          <div className="tape-track">
            <div className="muted tape-empty">No trades — market closed</div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel tape tape-horizontal">
      <div className="panel-title">
        Time &amp; Sales
        <span className="tape-live-dot" title="Live trade prints (Finnhub real-time when configured, otherwise Yahoo 1-min bars)">●</span>
      </div>
      <div
        className={`tape-track-wrap ${recent.length > 2 ? "marquee" : ""}`}
      >
        <div className="tape-track">
          {recent.map((t, i) => {
            const up = prevClose != null ? t.price >= prevClose : t.price >= 0;
            const size = (t.size ?? 0) > 0 ? fmtInt(t.size) : null;
            return (
              <div
                className={`deal ${up ? "up" : "down"}`}
                key={`${t.timestamp}-${i}`}
              >
                <div className="deal-top">
                  <span className="deal-arrow">{up ? "▲" : "▼"}</span>
                  <span className="deal-price">{fmtPrice(t.price)}</span>
                  {fmtCond(t.condition) && (
                    <span className="deal-cond">{fmtCond(t.condition)}</span>
                  )}
                </div>
                <div className="deal-bottom">
                  {size && <span className="deal-size">×{size}</span>}
                  <span className="deal-exch">{fmtExchange(t.exchange)}</span>
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
