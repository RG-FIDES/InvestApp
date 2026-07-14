"use client";

import { useState } from "react";
import { useMarketStore } from "../lib/store";
import PriceChart from "./PriceChart";
import type { BarInterval, ChartRange } from "../lib/types";

const RANGES: ChartRange[] = ["1D", "5D", "1M", "6M", "YTD", "1Y"];

const INTERVALS_BY_RANGE: Partial<Record<ChartRange, { value: BarInterval; label: string }[]>> = {
  "1D": [
    { value: "1m", label: "1m" },
    { value: "5m", label: "5m" },
    { value: "15m", label: "15m" },
    { value: "30m", label: "30m" },
    { value: "1h", label: "1h" },
  ],
  "5D": [
    { value: "15m", label: "15m" },
    { value: "30m", label: "30m" },
    { value: "1h", label: "1h" },
    { value: "1d", label: "1d" },
  ],
  "1M": [
    { value: "30m", label: "30m" },
    { value: "1h", label: "1h" },
    { value: "4h", label: "4h" },
    { value: "1d", label: "1d" },
  ],
};

export default function ChartCard() {
  const range = useMarketStore((s) => s.range);
  const setRange = useMarketStore((s) => s.setRange);
  const barInterval = useMarketStore((s) => s.barInterval);
  const setBarInterval = useMarketStore((s) => s.setBarInterval);
  const showPrevClose = useMarketStore((s) => s.showPrevCloseLine);
  const setShowPrevClose = useMarketStore((s) => s.setShowPrevCloseLine);
  const showDayHigh = useMarketStore((s) => s.showDayHighLine);
  const setShowDayHigh = useMarketStore((s) => s.setShowDayHighLine);
  const showDayLow = useMarketStore((s) => s.showDayLowLine);
  const setShowDayLow = useMarketStore((s) => s.setShowDayLowLine);
  const [resetKey, setResetKey] = useState(0);

  const isIntraday = range === "1D" || range === "5D";
  const intervals = INTERVALS_BY_RANGE[range] ?? [];
  const showIntervals = intervals.length > 0;

  const handleRangeChange = (r: ChartRange) => {
    const ivs = INTERVALS_BY_RANGE[r];
    if (ivs && ivs.length > 0) {
      setBarInterval(ivs[0].value);
    }
    setRange(r);
  };

  return (
    <section className="panel chart-card">
      <div className="chart-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="range-tabs">
            {RANGES.map((r) => (
              <button
                key={r}
                className={`range-tab ${range === r ? "active" : ""}`}
                onClick={() => handleRangeChange(r)}
              >
                {r}
              </button>
            ))}
          </div>
          {showIntervals && (
            <div className="interval-tabs">
              {intervals.map((iv) => (
                <button
                  key={iv.value}
                  className={`interval-tab ${barInterval === iv.value ? "active" : ""}`}
                  onClick={() => setBarInterval(iv.value)}
                >
                  {iv.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isIntraday && (
            <>
              <button
                className={`ref-toggle ref-pc ${showPrevClose ? "on" : ""}`}
                onClick={() => setShowPrevClose(!showPrevClose)}
                title="Toggle previous close line"
              >
                PC
              </button>
              <button
                className={`ref-toggle ref-hi ${showDayHigh ? "on" : ""}`}
                onClick={() => setShowDayHigh(!showDayHigh)}
                title="Toggle day high line"
              >
                HI
              </button>
              <button
                className={`ref-toggle ref-lo ${showDayLow ? "on" : ""}`}
                onClick={() => setShowDayLow(!showDayLow)}
                title="Toggle day low line"
              >
                LO
              </button>
              <span className="ref-toggle-sep" />
            </>
          )}
          <span className="chart-live">
            <span className="chart-live-dot" /> live
          </span>
          <button
            className="reset-zoom-btn"
            onClick={() => setResetKey((k) => k + 1)}
            title="Reset chart zoom to full view"
          >
            ↺
          </button>
        </div>
      </div>
      <div className="chart-host">
        <PriceChart
          showPrevClose={showPrevClose}
          showDayHigh={showDayHigh}
          showDayLow={showDayLow}
          resetZoomTrigger={resetKey}
        />
      </div>
    </section>
  );
}
