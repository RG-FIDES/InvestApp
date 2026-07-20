// Shared domain types matching the rebuilt backend JSON contract.

export interface Bar {
  // 1-min intraday bar uses `timestamp` (ISO-8601 UTC); daily bar uses `date`
  // (YYYY-MM-DD). The chart normalizes both to a time value.
  symbol?: string;
  timestamp?: string; // ISO-8601 UTC (intraday)
  date?: string; // YYYY-MM-DD (daily)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  symbol: string;
  timestamp: string;
  price: number;
  size: number;
  exchange?: string | null;
  condition?: string | null;
}

export interface Quote {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  marketTimezone: string;
  price: number | null;
  currentPrice: number | null;
  change: number | null;
  changePercent: number | null;
  prevClose: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  volume: number | null;
  avgVolume: number | null;
  avgPrice3d: number | null;
  avgVolume3d: number | null;
  avgPrice3m: number | null;
  avgVolume3m: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  marketCap: number | null;
  peRatio: number | null;
  eps: number | null;
  beta: number | null;
  dividend: number | null;
  dividendYield: number | null;
  target: number | null;
  exDividendDate: string | null;
  earningsDate: string | null;
  marketState: string; // PRE | REGULAR | POST | CLOSED …
  asOf: string | null;
  sector: string;
  industry: string;
  description: string;
  website: string;
  employees: number;
  fiscalYearEnds: string;
  performance: {
    ytd: { stock: number; bench: number };
    one_year: { stock: number; bench: number };
    three_year: { stock: number; bench: number };
  };
}

export type NotificationEventType =
  | "day_high"
  | "day_low"
  | "volume_spike"
  | "market_transition"
  | "percent_move"
  | "price_alert";

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  day_high: "Day High Broken",
  day_low: "Day Low Broken",
  volume_spike: "Volume Spike",
  market_transition: "Market Transition",
  percent_move: "% Move from Open",
  price_alert: "Price Alerts",
};

export interface NotificationItem {
  id: string;
  event: NotificationEventType;
  level: "info" | "warning" | "critical";
  title: string;
  body: string;
  timestamp: string;
}

// Messages pushed over the WebSocket.
export type ServerMessage =
  | { type: "snapshot"; quote: Quote; recent_trades: Trade[] }
  | {
      type: "quote";
      symbol: string;
      price: number;
      currentPrice: number | null;
      change: number | null;
      changePercent: number | null;
      prevClose: number | null;
      open: number | null;
      dayHigh: number | null;
      dayLow: number | null;
      bid: number | null;
      ask: number | null;
      bidSize: number | null;
      askSize: number | null;
      volume: number | null;
      marketState: string;
      asOf: string;
    }
  | { type: "bar"; symbol: string; timestamp: string; open: number; high: number; low: number; close: number; volume: number }
  | { type: "trade"; symbol: string; timestamp: string; price: number; size: number; exchange?: string | null; condition?: string | null }
  | { type: "alert"; message: string }
  | { type: "notification"; event: NotificationEventType } & NotificationItem
  | {
      type: "custom_alert";
      notification_id: string;
      name: string;
      body: string;
      timestamp: string;
    }
  | { type: "custom_notif_disabled"; notification_id: string }
  | { type: "symbol_changed"; symbol: string };

// ---------------------------------------------------------------------------
// Markets + symbol search + multi-stock tracking
// ---------------------------------------------------------------------------

export interface Market {
  display: string;
  currency: string;
  timezone: string;
  city: string;
  flag: string;
}

export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  quoteType: string;
}

export interface TrackedStock {
  symbol: string;
  name: string;
  market: string; // market code (US, LSE, TSE, …) or ""
}

/** Per-symbol market metadata cached from the last quote for that symbol.
 *  Used to compute market-state dots on each topbar chip. */
export interface StockMeta {
  exchange: string;
  currency: string;
  timezone: string;
}

/** Map a market timezone + current time to a market-state code. */
export function getLocalMarketState(tz: string): "PRE" | "REGULAR" | "POST" | "CLOSED" {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    const mins = h * 60 + m;
    // Generic exchange hours (reasonable for most global markets):
    // PRE:  4:00 – 9:30   REGULAR: 9:30 – 16:00   POST: 16:00 – 20:00
    if (mins >= 240 && mins < 570) return "PRE";
    if (mins >= 570 && mins < 960) return "REGULAR";
    if (mins >= 960 && mins < 1200) return "POST";
    return "CLOSED";
  } catch {
    return "CLOSED";
  }
}

/** Human label for a market-state code. */
export function marketStateLabel(s: string): string {
  switch (s) {
    case "PRE": return "PRE-MARKET";
    case "REGULAR": return "MARKET OPEN";
    case "POST": return "AFTER HOURS";
    default: return "MARKET CLOSED";
  }
}

// ---------------------------------------------------------------------------
// Custom (user-defined) notifications — persisted in localStorage, synced to
// the backend over the WebSocket so the server fires them in real time.
// ---------------------------------------------------------------------------

export interface CustomNotificationConditions {
  priceAbove: number | null;
  priceBelow: number | null;
  dayHighBroken: boolean;
  dayLowBroken: boolean;
  volumeAbove: number | null;
  volumeSpike: boolean;
  percentMoveUp: number | null;   // e.g. 2 → fire when price is 2 % above open
  percentMoveDown: number | null; // e.g. 2 → fire when price is 2 % below open
  marketStateIs: string | null;   // "REGULAR" | "PRE" | "POST" …
}

export interface CustomNotification {
  id: string;
  name: string;
  enabled: boolean;
  repeat: "once" | "every";
  conditions: CustomNotificationConditions;
  createdAt: string;
  lastFiredAt: string | null;
  fireCount: number;
}

export type ClientMessage =
  | { action: "set_alert"; price: number }
  | { action: "clear_alert" }
  | { action: "sync_custom"; notifications: CustomNotification[] }
  | { action: "add_custom"; notification: CustomNotification }
  | { action: "update_custom"; notification: CustomNotification }
  | { action: "remove_custom"; id: string };

export type ChartRange = "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y";
export type BarInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type MarketState = "PRE" | "REGULAR" | "POST" | "CLOSED" | "PREPRE" | "POSTPOST";
