"use client";

import { useEffect, useRef } from "react";
import { fetchHistory, fetchQuote } from "../lib/api";
import { connectMarketWS } from "../lib/ws";
import { wsSender } from "../lib/wsSender";
import { useMarketStore } from "../lib/store";
import type { Bar, CustomNotification, NotificationItem, Quote, Trade, ChartRange } from "../lib/types";

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
  const setLastTickDir = useMarketStore((s) => s.setLastTickDir);
  const addNotification = useMarketStore((s) => s.addNotification);
  const disableCustomNotification = useMarketStore((s) => s.disableCustomNotification);
  const browserPushEnabled = useMarketStore((s) => s.browserPushEnabled);
  const range = useMarketStore((s) => s.range);
  const barInterval = useMarketStore((s) => s.barInterval);
  const activeSymbol = useMarketStore((s) => s.activeSymbol);
  const clearTrades = useMarketStore((s) => s.clearTrades);
  const setStockMeta = useMarketStore((s) => s.setStockMeta);

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
        async (msg) => {
          switch (msg.type) {
            case "snapshot": {
              if (stopped) break;
              setQuote(msg.quote as Quote);
              (msg.recent_trades as Trade[]).forEach((t) => addTrade(t));
              lastPriceRef.current = msg.quote.price;
              // Send all custom notifications to the backend so it can fire them.
              const customNotifs = useMarketStore.getState().customNotifications;
              if (customNotifs.length > 0) {
                wsSender.send({ action: "sync_custom", notifications: customNotifs });
              }
              break;
            }
            case "quote": {
              const prev = lastPriceRef.current;
              if (prev != null && msg.price > prev) setLastTickDir("up");
              else if (prev != null && msg.price < prev) setLastTickDir("down");
              lastPriceRef.current = msg.price;
              patchQuote({
                price: msg.price,
                currentPrice: msg.currentPrice,
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
            case "notification": {
              const n: NotificationItem = {
                id: msg.id,
                event: msg.event,
                level: msg.level,
                title: msg.title,
                body: msg.body,
                timestamp: msg.timestamp,
              };
              addNotification(n);
              // Browser Notification API (if user opted in).
              if (useMarketStore.getState().browserPushEnabled && Notification.permission === "granted") {
                new Notification(`InvestApp — ${n.title}`, {
                  body: n.body,
                  icon: "/favicon.ico",
                });
              }
              break;
            }
            case "custom_alert": {
              // Push custom alerts into the notification stream.
              addNotification({
                id: `custom-${msg.notification_id}-${Date.now()}`,
                event: "price_alert",
                level: "warning",
                title: msg.name,
                body: msg.body,
                timestamp: msg.timestamp,
              });
              if (useMarketStore.getState().browserPushEnabled && Notification.permission === "granted") {
                new Notification(`InvestApp — ${msg.name}`, {
                  body: msg.body,
                  icon: "/favicon.ico",
                });
              }
              break;
            }
            case "custom_notif_disabled": {
              // Backend auto-disabled a "once" notification.
              disableCustomNotification(msg.notification_id);
              break;
            }
            case "symbol_changed": {
              // Backend finished switching the tracked instrument — re-seed
              // the quote + history for the new symbol.
              if (stopped) break;
              try {
                const [q, bars] = await Promise.all([
                  fetchQuote(),
                  fetchHistory(
                    useMarketStore.getState().range,
                    (useMarketStore.getState().range === "1D" ||
                      useMarketStore.getState().range === "5D" ||
                      useMarketStore.getState().range === "1M")
                      ? useMarketStore.getState().barInterval
                      : undefined
                  ),
                ]);
                if (stopped) break;
                setQuote(q);
                setBars(bars);
                lastPriceRef.current = q.price;
              } catch (err) {
                console.error("Re-seed after symbol_changed failed:", err);
              }
              break;
            }
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
  }, [range, barInterval, setQuote, setBars, addTrade, setConnected, patchQuote, setLastTickDir]);

  // Optimistically re-seed the quote + history when the user switches the
  // active symbol. The backend feed switches in parallel and will push live
  // ticks for the new symbol; the WS stays connected throughout.
  useEffect(() => {
    let stopped = false;
    const reseed = async () => {
      try {
        const [q, bars] = await Promise.all([
          fetchQuote(),
          fetchHistory(
            useMarketStore.getState().range,
            (useMarketStore.getState().range === "1D" ||
              useMarketStore.getState().range === "5D" ||
              useMarketStore.getState().range === "1M")
              ? useMarketStore.getState().barInterval
              : undefined
          ),
        ]);
        if (stopped) return;
        setQuote(q);
        setBars(bars);
        lastPriceRef.current = q.price;
      } catch (err) {
        console.error("Re-seed on symbol switch failed:", err);
      }
    };
    reseed();
    // Clear the time & sales tape so trades from the previous symbol don't
    // mix with the new one's prints.
    clearTrades();
    return () => {
      stopped = true;
    };
  }, [activeSymbol, setQuote, setBars, clearTrades]);

  // On first mount, push the frontend's last-selected symbol to the backend
  // so the live feed tracks what the UI is showing (handles reloads where the
  // backend may have been restarted on its default symbol).
  useEffect(() => {
    const sym = useMarketStore.getState().activeSymbol;
    if (sym) {
      import("../lib/api").then(({ setActiveSymbol }) =>
        setActiveSymbol(sym).catch(() => {})
      );
    }
  }, []);

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
