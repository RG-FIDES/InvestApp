"use client";

import { useMarketStore } from "../lib/store";
import { fmtInt } from "../lib/format";

export default function OverviewPanel() {
  const q = useMarketStore((s) => s.quote);
  if (!q) return null;

  return (
    <section className="panel overview">
      <div className="panel-title">About {q.name}</div>
      <p className="overview-desc">{q.description}</p>
      <div className="overview-grid">
        <div className="overview-item">
          <div className="overview-label">Sector</div>
          <div className="overview-value">{q.sector}</div>
        </div>
        <div className="overview-item">
          <div className="overview-label">Industry</div>
          <div className="overview-value">{q.industry}</div>
        </div>
        <div className="overview-item">
          <div className="overview-label">Employees</div>
          <div className="overview-value">{fmtInt(q.employees)}</div>
        </div>
        <div className="overview-item">
          <div className="overview-label">Fiscal Year Ends</div>
          <div className="overview-value">{q.fiscalYearEnds}</div>
        </div>
        <div className="overview-item">
          <div className="overview-label">Earnings (est.)</div>
          <div className="overview-value">{q.earningsDate}</div>
        </div>
        <div className="overview-item">
          <div className="overview-label">Ex-Dividend</div>
          <div className="overview-value">{q.exDividendDate}</div>
        </div>
      </div>
      <a className="overview-link" href={q.website} target="_blank" rel="noreferrer">
        {q.website}
      </a>
    </section>
  );
}
