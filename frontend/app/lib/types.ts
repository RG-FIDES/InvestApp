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

// Messages pushed over the WebSocket.
export type ServerMessage =
  | { type: "snapshot"; quote: Quote; recent_trades: Trade[] }
  | {
      type: "quote";
      symbol: string;
      price: number;
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
  | { type: "alert"; message: string };

export type ClientMessage =
  | { action: "set_alert"; price: number }
  | { action: "clear_alert" };

export type ChartRange = "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y";
export type BarInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type MarketState = "PRE" | "REGULAR" | "POST" | "CLOSED" | "PREPRE" | "POSTPOST";
