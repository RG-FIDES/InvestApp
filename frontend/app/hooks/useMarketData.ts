"use client";

import { useEffect, useRef } from "react";
import { fetchHistory, fetchQuote } from "../lib/api";
import { connectMarketWS } from "../lib/ws";
import { wsSender } from "../lib/wsSender";
import { useMarketStore } from "../lib/store";
import type { Bar, Quote, Trade, ChartRange } from "../lib/types";

/**
 * Wires the REST seed (quote + history) and the live WebSocket into the
 * zustand store. Mount once (in the page). Auto-reconnects via lib/ws.
 */
export function useMarketData() {
  const setQuote = useMarketStore((s) => s.setQuote);
  const patchQuote = useMarketStore((s) => s.patchQuote);
  const setBars = useMarketStore((s) => s.setBars);
  const addTrade = useMarketStore((s) => s.addTrade);
  const setConnected = useMarketStore((s) => s.setConnected);
  const setAlertMessage = useMarketStore((s) => s.setAlertMessage);
  const setLastTickDir = useMarketStore((s) => s.setLastTickDir);
  const range = useMarketStore((s) => s.range);
  const barInterval = useMarketStore((s) => s.barInterval);

  // Remember the last price to compute the flash direction on each quote tick.
  const lastPriceRef = useRef<number | null>(null);

  // Seed quote + history for the current range, then open the WS.
  // Re-runs when `range` changes so the chart re-seeds for the new range.
  useEffect(() => {
    let handle: ReturnType<typeof connectMarketWS> | null = null;
    let stopped = false;

    const seed = async () => {
      try {
        const [quote, bars] = await Promise.all([
          fetchQuote(),
          fetchHistory(range, (range === "1D" || range === "5D" || range === "1M") ? barInterval : undefined),
        ]);
        if (stopped) return;
        setQuote(quote);
        setBars(bars);
        lastPriceRef.current = quote.price;
      } catch (err) {
        console.error("Failed to seed from REST:", err);
      }

      if (stopped) return;
      handle = connectMarketWS(
        (msg) => {
          switch (msg.type) {
            case "snapshot": {
              if (stopped) break;
              setQuote(msg.quote as Quote);
              (msg.recent_trades as Trade[]).forEach((t) => addTrade(t));
              lastPriceRef.current = msg.quote.price;
              break;
            }
            case "quote": {
              const prev = lastPriceRef.current;
              if (prev != null && msg.price > prev) setLastTickDir("up");
              else if (prev != null && msg.price < prev) setLastTickDir("down");
              lastPriceRef.current = msg.price;
              patchQuote({
                price: msg.price,
                change: msg.change,
                changePercent: msg.changePercent,
                prevClose: msg.prevClose,
                open: msg.open,
                dayHigh: msg.dayHigh,
                dayLow: msg.dayLow,
                bid: msg.bid,
                ask: msg.ask,
                bidSize: msg.bidSize,
                askSize: msg.askSize,
                volume: msg.volume,
                marketState: msg.marketState,
                asOf: msg.asOf,
              });
              break;
            }
            case "bar": {
              if (useMarketStore.getState().range !== "1D") break;
              const bars = useMarketStore.getState().bars as Bar[];
              const nb: Bar = {
                timestamp: msg.timestamp,
                open: msg.open,
                high: msg.high,
                low: msg.low,
                close: msg.close,
                volume: msg.volume,
              };
              const last = bars[bars.length - 1];
              if (last && last.timestamp === msg.timestamp) {
                setBars([...bars.slice(0, -1), nb]);
              } else if (!last || new Date(msg.timestamp) > new Date(last.timestamp || "")) {
                setBars([...bars, nb]);
              }
              break;
            }
            case "trade":
              addTrade(msg as Trade);
              break;
            case "alert":
              setAlertMessage(msg.message);
              break;
          }
        },
        (connected) => setConnected(connected)
      );
      wsSender.register((m) => handle!.send(m));
    };

    seed();

    return () => {
      stopped = true;
      handle?.close();
    };
  }, [range, barInterval, setQuote, setBars, addTrade, setConnected, setAlertMessage, patchQuote, setLastTickDir]);

  // Refresh the full quote (fundamentals / 52w / avg volume) every 60s.
  useEffect(() => {
    let stopped = false;
    const refreshQuote = async () => {
      try {
        const q = await fetchQuote();
        if (!stopped) setQuote(q);
      } catch {
        /* keep last known */
      }
    };
    const id = setInterval(refreshQuote, 60_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [setQuote]);
}
