import { create } from "zustand";
import type {
  Bar,
  BarInterval,
  CustomNotification,
  Market,
  NotificationEventType,
  NotificationItem,
  Quote,
  SearchResult,
  StockMeta,
  Trade,
  TrackedStock,
} from "./types";

const MAX_TRADES = 60;
const MAX_NOTIFICATIONS = 50;
const STORAGE_KEY = "investapp_settings";

/** Default: all notification event types enabled. */
const DEFAULT_NOTIFICATION_SUBS: Record<NotificationEventType, boolean> = {
  day_high: true,
  day_low: true,
  volume_spike: true,
  market_transition: true,
  percent_move: true,
  price_alert: true,
};

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

  notifications: NotificationItem[];
  unreadNotificationCount: number;
  notificationSubs: Record<NotificationEventType, boolean>;
  browserPushEnabled: boolean;

  customNotifications: CustomNotification[];

  // ---- Multi-stock tracking --------------------------------------------
  markets: Record<string, Market>;
  selectedMarket: string; // "" = all markets
  trackedStocks: TrackedStock[];
  activeSymbol: string;
  stockMeta: Record<string, StockMeta>;
  searchQuery: string;
  searchResults: SearchResult[];
  searching: boolean;

  setMarkets: (m: Record<string, Market>) => void;
  setSelectedMarket: (code: string) => void;
  setActiveSymbol: (symbol: string) => void;
  setStockMeta: (symbol: string, meta: StockMeta) => void;
  addTrackedStock: (stock: TrackedStock) => void;
  removeTrackedStock: (symbol: string) => void;
  setSearchQuery: (q: string) => void;
  setSearchResults: (r: SearchResult[]) => void;
  setSearching: (v: boolean) => void;

  setQuote: (q: Quote | null) => void;
  patchQuote: (p: Partial<Quote>) => void;
  setBars: (bars: Bar[]) => void;
  setRange: (r: "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y") => void;
  setBarInterval: (i: BarInterval) => void;
  addTrade: (t: Trade) => void;
  clearTrades: () => void;
  setShowPrevCloseLine: (v: boolean) => void;
  setShowDayHighLine: (v: boolean) => void;
  setShowDayLowLine: (v: boolean) => void;
  setConnected: (v: boolean) => void;
  setAlertPrice: (p: number | null) => void;
  setAlertMessage: (m: string | null) => void;
  setLastTickDir: (d: "up" | "down" | null) => void;
  hydrateSettings: () => void;

  addNotification: (n: NotificationItem) => void;
  dismissNotification: (id: string) => void;
  clearAllNotifications: () => void;
  markNotificationsRead: () => void;
  toggleNotificationEvent: (event: NotificationEventType) => void;
  setBrowserPushEnabled: (v: boolean) => void;

  addCustomNotification: (n: CustomNotification) => void;
  updateCustomNotification: (id: string, patch: Partial<CustomNotification>) => void;
  removeCustomNotification: (id: string) => void;
  disableCustomNotification: (id: string) => void;
  toggleCustomNotification: (id: string) => void;
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

  notifications: [],
  unreadNotificationCount: 0,
  notificationSubs: { ...DEFAULT_NOTIFICATION_SUBS },
  browserPushEnabled: false,

  customNotifications: [],

  markets: {},
  selectedMarket: "",
  trackedStocks: [{ symbol: "MU", name: "Micron Technology", market: "US" }],
  activeSymbol: "MU",
  stockMeta: {},
  searchQuery: "",
  searchResults: [],
  searching: false,

  setMarkets: (m) => set({ markets: m }),
  setSelectedMarket: (code) => {
    saveSettings({ selectedMarket: code });
    set({ selectedMarket: code });
  },
  setActiveSymbol: (symbol) => {
    saveSettings({ activeSymbol: symbol });
    set({ activeSymbol: symbol });
  },
  addTrackedStock: (stock) =>
    set((s) => {
      const existing = s.trackedStocks.find((t) => t.symbol === stock.symbol);
      if (existing) {
        if (existing.market && stock.market) return {};
      }
      const next = existing
        ? s.trackedStocks.map((t) => t.symbol === stock.symbol ? { ...t, ...stock } : t)
        : [...s.trackedStocks, stock];
      saveSettings({ trackedStocks: next });
      return { trackedStocks: next };
    }),
  removeTrackedStock: (symbol) =>
    set((s) => {
      const next = s.trackedStocks.filter((t) => t.symbol !== symbol);
      saveSettings({ trackedStocks: next });
      const patch: Partial<MarketState> = { trackedStocks: next };
      if (s.activeSymbol === symbol && next.length > 0) {
        patch.activeSymbol = next[0].symbol;
        saveSettings({ activeSymbol: next[0].symbol });
      }
      return patch;
    }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (r) => set({ searchResults: r }),
  setSearching: (v) => set({ searching: v }),
  setStockMeta: (symbol, meta) =>
    set((s) => ({
      stockMeta: { ...s.stockMeta, [symbol]: meta },
    })),

  setQuote: (q) =>
    set((s) => {
      const patch: Partial<MarketState> = { quote: q };
      if (q) {
        patch.stockMeta = {
          ...s.stockMeta,
          [q.symbol]: {
            exchange: q.exchange,
            currency: q.currency,
            timezone: q.marketTimezone,
          },
        };
      }
      return patch;
    }),
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
  clearTrades: () => set({ trades: [] }),
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

  addNotification: (n) =>
    set((s) => {
      // Respect per-event subscription toggles.
      if (!s.notificationSubs[n.event]) return {};
      const notifications = [...s.notifications, n];
      if (notifications.length > MAX_NOTIFICATIONS) notifications.shift();
      return {
        notifications,
        unreadNotificationCount: s.unreadNotificationCount + 1,
      };
    }),

  dismissNotification: (id) =>
    set((s) => ({
      notifications: s.notifications.filter((n) => n.id !== id),
    })),

  clearAllNotifications: () => set({ notifications: [], unreadNotificationCount: 0 }),

  markNotificationsRead: () => set({ unreadNotificationCount: 0 }),

  toggleNotificationEvent: (event) => {
    set((s) => {
      const next = { ...s.notificationSubs, [event]: !s.notificationSubs[event] };
      saveSettings({ notificationSubs: next });
      return { notificationSubs: next };
    });
  },

  setBrowserPushEnabled: (v) => {
    saveSettings({ browserPushEnabled: v });
    set({ browserPushEnabled: v });
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
    if (saved.notificationSubs) patch.notificationSubs = saved.notificationSubs as Record<NotificationEventType, boolean>;
    if (saved.browserPushEnabled !== undefined) patch.browserPushEnabled = !!saved.browserPushEnabled;
    if (saved.customNotifications) patch.customNotifications = saved.customNotifications as CustomNotification[];
    if (saved.selectedMarket !== undefined) patch.selectedMarket = saved.selectedMarket as string;
    if (saved.trackedStocks) patch.trackedStocks = saved.trackedStocks as TrackedStock[];
    if (saved.activeSymbol) patch.activeSymbol = saved.activeSymbol as string;
    if (Object.keys(patch).length > 0) set(patch);
  },

  // ---- Custom notification CRUD ----------------------------------------
  addCustomNotification: (n) =>
    set((s) => {
      const next = [...s.customNotifications, n];
      saveSettings({ customNotifications: next });
      return { customNotifications: next };
    }),

  updateCustomNotification: (id, patch) =>
    set((s) => {
      const next = s.customNotifications.map((n) =>
        n.id === id ? { ...n, ...patch } : n
      );
      saveSettings({ customNotifications: next });
      return { customNotifications: next };
    }),

  removeCustomNotification: (id) =>
    set((s) => {
      const next = s.customNotifications.filter((n) => n.id !== id);
      saveSettings({ customNotifications: next });
      return { customNotifications: next };
    }),

  disableCustomNotification: (id) =>
    set((s) => {
      const next = s.customNotifications.map((n) =>
        n.id === id ? { ...n, enabled: false } : n
      );
      saveSettings({ customNotifications: next });
      return { customNotifications: next };
    }),

  toggleCustomNotification: (id) =>
    set((s) => {
      const next = s.customNotifications.map((n) =>
        n.id === id ? { ...n, enabled: !n.enabled } : n
      );
      saveSettings({ customNotifications: next });
      return { customNotifications: next };
    }),
}));
