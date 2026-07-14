"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  createChart,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useMarketStore } from "../lib/store";
import type { Bar } from "../lib/types";
import { fmtPrice, fmtCompact } from "../lib/format";

interface Props {
  showPrevClose: boolean;
  showDayHigh: boolean;
  showDayLow: boolean;
  resetZoomTrigger: number;
}

function toTime(b: Bar): UTCTimestamp {
  const v = b.timestamp ? Date.parse(b.timestamp) : Date.parse(b.date + "T00:00:00Z");
  return Math.floor(v / 1000) as UTCTimestamp;
}

function toCandle(b: Bar) {
  return { time: toTime(b), open: b.open, high: b.high, low: b.low, close: b.close };
}

function toVolume(b: Bar) {
  return {
    time: toTime(b),
    value: b.volume,
    color: b.close >= b.open ? "rgba(30,143,85,0.45)" : "rgba(204,58,50,0.45)",
  };
}

function fmtTool(t: UTCTimestamp, d: Bar | null) {
  if (!d) return null;
  return {
    time: new Date((t as number) * 1000).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    }),
    o: fmtPrice(d.open),
    h: fmtPrice(d.high),
    l: fmtPrice(d.low),
    c: fmtPrice(d.close),
    v: fmtCompact(d.volume),
    up: d.close >= d.open,
  };
}

export default function PriceChart({ showPrevClose, showDayHigh, showDayLow, resetZoomTrigger }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const prevCloseLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const dayHighLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const dayLowLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const barMapRef = useRef<Map<number, Bar>>(new Map());

  const bars = useMarketStore((s) => s.bars);
  const range = useMarketStore((s) => s.range);
  const barInterval = useMarketStore((s) => s.barInterval);
  const livePrice = useMarketStore((s) => s.quote?.price ?? null);
  const prevClose = useMarketStore((s) => s.quote?.prevClose ?? null);
  const dayHigh = useMarketStore((s) => s.quote?.dayHigh ?? null);
  const dayLow = useMarketStore((s) => s.quote?.dayLow ?? null);

  const crosshairHandler = useCallback(
    (param: Parameters<Parameters<IChartApi["subscribeCrosshairMove"]>[0]>[0]) => {
      const tt = tooltipRef.current;
      if (!tt || !param.time || param.point === undefined) { if (tt) tt.style.display = "none"; return; }
      const t = param.time as UTCTimestamp;
      const bar = barMapRef.current.get(t) ?? null;
      const data = fmtTool(t, bar);
      if (!data) { tt.style.display = "none"; return; }
      const dir = data.up ? "up" : "down";
      tt.innerHTML = [
        '<span class="cht-tm">' + data.time + '</span>',
        '<div class="cht-row"><span class="cht-label">O</span><span class="cht-val">' + data.o + '</span></div>',
        '<div class="cht-row"><span class="cht-label">H</span><span class="cht-val ' + dir + '">' + data.h + '</span></div>',
        '<div class="cht-row"><span class="cht-label">L</span><span class="cht-val ' + dir + '">' + data.l + '</span></div>',
        '<div class="cht-row"><span class="cht-label">C</span><span class="cht-val ' + dir + '">' + data.c + '</span></div>',
        '<div class="cht-row"><span class="cht-label">V</span><span class="cht-val">' + data.v + '</span></div>',
      ].join("");
      tt.style.display = "block";
      tt.style.left = (param.point.x + 16) + "px";
      tt.style.top = (param.point.y - 20) + "px";
    },
    []
  );

  // Create chart + series -- once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tt = document.createElement("div");
    tt.className = "chart-tooltip";
    el.style.position = "relative";
    el.appendChild(tt);
    tooltipRef.current = tt;

    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: "#0b0e13" }, textColor: "#737a86",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
      grid: { vertLines: { color: "#1c2128" }, horzLines: { color: "#1c2128" } },
      rightPriceScale: { borderColor: "#1c2128" },
      timeScale: { borderColor: "#1c2128", timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Magnet,
        vertLine: { color: "#4a5568", labelBackgroundColor: "#1a1f28" },
        horzLine: { color: "#4a5568", labelBackgroundColor: "#1a1f28" } },
      autoSize: true,
    });

    const candle = chart.addCandlestickSeries({
      upColor: "#1e8f55", downColor: "#cc3a32",
      borderUpColor: "#1e8f55", borderDownColor: "#cc3a32",
      wickUpColor: "#1e8f55", wickDownColor: "#cc3a32",
    });
    const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const prevLine = chart.addLineSeries({ color: "#c8a030", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
    prevLine.applyOptions({ crosshairMarkerVisible: false });
    const hiLine = chart.addLineSeries({ color: "#1e8f55", lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
    hiLine.applyOptions({ crosshairMarkerVisible: false });
    const loLine = chart.addLineSeries({ color: "#cc3a32", lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
    loLine.applyOptions({ crosshairMarkerVisible: false });

    chart.subscribeCrosshairMove(crosshairHandler);

    chartRef.current = chart;
    candleRef.current = candle;
    volumeRef.current = vol;
    prevCloseLineRef.current = prevLine;
    dayHighLineRef.current = hiLine;
    dayLowLineRef.current = loLine;

    return () => {
      chart.unsubscribeCrosshairMove(crosshairHandler);
      chart.remove();
      chartRef.current = null; candleRef.current = null; volumeRef.current = null;
      prevCloseLineRef.current = null; dayHighLineRef.current = null; dayLowLineRef.current = null;
      lastTimeRef.current = null;
      tt.remove();
    };
  }, []);

  // --- Data update effect ---
  // We ALWAYS call setData (not update) for correctness.
  // If the user has zoomed in, we snapshot their view before setData
  // and restore it after via double-requestAnimationFrame.
  const lockRangeRef = useRef<{ from: number; to: number } | null>(null);
  const userZoomedRef2 = useRef(false);
  const prevRangeRef = useRef(range);
  const prevIntervalRef = useRef(barInterval);

  useEffect(() => {
    if (!candleRef.current || !volumeRef.current) return;
    if (bars.length === 0) return;

    const ts = chartRef.current?.timeScale();
    const switched = range !== prevRangeRef.current || barInterval !== prevIntervalRef.current;
    prevRangeRef.current = range;
    prevIntervalRef.current = barInterval;

    if (switched) {
      userZoomedRef2.current = false;
      lockRangeRef.current = null;
    }

    // Snapshot current visible range before setData wipes it.
    if (userZoomedRef2.current && ts) {
      const lr = ts.getVisibleLogicalRange();
      if (lr) lockRangeRef.current = { from: lr.from, to: lr.to };
    }

    candleRef.current.setData(bars.map(toCandle));
    volumeRef.current.setData(bars.map(toVolume));

    const map = new Map<number, Bar>();
    for (const b of bars) map.set(toTime(b), b);
    barMapRef.current = map;
    lastTimeRef.current = toTime(bars[bars.length - 1]);

    if (!userZoomedRef2.current) {
      ts?.fitContent();
    } else if (lockRangeRef.current) {
      // Restore after chart finishes processing setData.
      // Double rAF: one for the chart's internal layout, one safety margin.
      const locked = lockRangeRef.current;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          ts?.setVisibleLogicalRange({ from: locked.from, to: locked.to });
        });
      });
    }
  }, [bars, range, barInterval]);

  // Track user zoom via mouse/gesture events on the chart container.
  // This is more reliable than subscribeVisibleLogicalRangeChange
  // which fires on every setData/fitContent too.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDown = () => { userZoomedRef2.current = true; };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, []);

  // Reset zoom button
  useEffect(() => {
    if (!chartRef.current || bars.length === 0) return;
    userZoomedRef2.current = false;
    lockRangeRef.current = null;
    chartRef.current.timeScale().fitContent();
  }, [resetZoomTrigger]);

  // Reference lines
  useEffect(() => {
    const prevLine = prevCloseLineRef.current, hiLine = dayHighLineRef.current, loLine = dayLowLineRef.current;
    if (!prevLine || !hiLine || !loLine || !bars.length) return;
    const ft = toTime(bars[0]), lt = toTime(bars[bars.length - 1]);
    const on = range === "1D" || range === "5D";

    if (prevClose != null && on && showPrevClose) {
      prevLine.setData([{ time: ft as UTCTimestamp, value: prevClose }, { time: lt as UTCTimestamp, value: prevClose }]);
      prevLine.applyOptions({ visible: true });
    } else { prevLine.applyOptions({ visible: false }); }

    if (dayHigh != null && on && showDayHigh) {
      hiLine.setData([{ time: ft as UTCTimestamp, value: dayHigh }, { time: lt as UTCTimestamp, value: dayHigh }]);
      hiLine.applyOptions({ visible: true });
    } else { hiLine.applyOptions({ visible: false }); }

    if (dayLow != null && on && showDayLow) {
      loLine.setData([{ time: ft as UTCTimestamp, value: dayLow }, { time: lt as UTCTimestamp, value: dayLow }]);
      loLine.applyOptions({ visible: true });
    } else { loLine.applyOptions({ visible: false }); }
  }, [prevClose, dayHigh, dayLow, bars, range, showPrevClose, showDayHigh, showDayLow]);

  // Live price
  useEffect(() => {
    if (!candleRef.current || livePrice == null || lastTimeRef.current == null) return;
    const last = bars[bars.length - 1];
    if (!last) return;
    const t = toTime(last);
    if (t !== lastTimeRef.current) return;
    candleRef.current.update({
      time: t, open: last.open,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
      close: livePrice,
    });
  }, [livePrice, bars]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
