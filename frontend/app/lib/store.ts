import { create } from "zustand";
import type { Bar, BarInterval, Quote, Trade } from "./types";

const MAX_TRADES = 60;
const STORAGE_KEY = "investapp_settings";

/* ---- localStorage helpers (client-only) ---- */
function loadSettings(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettings(patch: Record<string, unknown>) {
  try {
    const current = loadSettings();
    const merged = { ...current, ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* quota exceeded */
  }
}

interface MarketState {
  quote: Quote | null;
  bars: Bar[];
  range: "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y";
  barInterval: BarInterval;
  trades: Trade[];
  connected: boolean;
  alertPrice: number | null;
  alertMessage: string | null;
  lastTickDir: "up" | "down" | null;

  showPrevCloseLine: boolean;
  showDayHighLine: boolean;
  showDayLowLine: boolean;

  setQuote: (q: Quote | null) => void;
  patchQuote: (p: Partial<Quote>) => void;
  setBars: (bars: Bar[]) => void;
  setRange: (r: "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y") => void;
  setBarInterval: (i: BarInterval) => void;
  addTrade: (t: Trade) => void;
  setShowPrevCloseLine: (v: boolean) => void;
  setShowDayHighLine: (v: boolean) => void;
  setShowDayLowLine: (v: boolean) => void;
  setConnected: (v: boolean) => void;
  setAlertPrice: (p: number | null) => void;
  setAlertMessage: (m: string | null) => void;
  setLastTickDir: (d: "up" | "down" | null) => void;
  hydrateSettings: () => void;
}

export const useMarketStore = create<MarketState>((set, get) => ({
  quote: null,
  bars: [],
  range: "1D",
  barInterval: "1m",
  trades: [],
  connected: false,
  alertPrice: null,
  alertMessage: null,
  lastTickDir: null,
  showPrevCloseLine: true,
  showDayHighLine: true,
  showDayLowLine: true,

  setQuote: (q) => set({ quote: q }),
  patchQuote: (p) => set((s) => (s.quote ? { quote: { ...s.quote, ...p } } : { quote: s.quote })),
  setBars: (bars) => set({ bars }),
  setRange: (r) => {
    saveSettings({ range: r });
    set({ range: r });
  },
  setBarInterval: (i) => {
    saveSettings({ barInterval: i });
    set({ barInterval: i });
  },
  addTrade: (t) =>
    set((s) => {
      const trades = [...s.trades, t];
      if (trades.length > MAX_TRADES) trades.shift();
      return { trades };
    }),
  setConnected: (v) => set({ connected: v }),
  setAlertPrice: (p) => set({ alertPrice: p, alertMessage: null }),
  setAlertMessage: (m) => set({ alertMessage: m }),
  setLastTickDir: (d) => set({ lastTickDir: d }),
  setShowPrevCloseLine: (v) => {
    saveSettings({ showPrevCloseLine: v });
    set({ showPrevCloseLine: v });
  },
  setShowDayHighLine: (v) => {
    saveSettings({ showDayHighLine: v });
    set({ showDayHighLine: v });
  },
  setShowDayLowLine: (v) => {
    saveSettings({ showDayLowLine: v });
    set({ showDayLowLine: v });
  },

  // Hydrate persisted settings on the client side (never during SSR).
  // Call once from a client component via useEffect.
  hydrateSettings: () => {
    const saved = loadSettings();
    const patch: Partial<MarketState> = {};
    if (saved.range) patch.range = saved.range as MarketState["range"];
    if (saved.barInterval) patch.barInterval = saved.barInterval as BarInterval;
    if (saved.showPrevCloseLine !== undefined) patch.showPrevCloseLine = !!saved.showPrevCloseLine;
    if (saved.showDayHighLine !== undefined) patch.showDayHighLine = !!saved.showDayHighLine;
    if (saved.showDayLowLine !== undefined) patch.showDayLowLine = !!saved.showDayLowLine;
    if (Object.keys(patch).length > 0) set(patch);
  },
}));
