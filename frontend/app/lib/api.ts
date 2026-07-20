import type { Bar, BarInterval, ChartRange, Market, Quote, SearchResult } from "./types";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:8000";

export async function fetchQuote(): Promise<Quote> {
  const res = await fetch(`${API_URL}/api/quote`);
  if (!res.ok) throw new Error(`/api/quote ${res.status}`);
  return res.json();
}

export async function fetchHistory(
  range: ChartRange = "1D",
  interval?: BarInterval
): Promise<Bar[]> {
  let url = `${API_URL}/api/history?range=${range}`;
  if (interval && (range === "1D" || range === "5D" || range === "1M")) {
    url += `&interval=${interval}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/api/history ${res.status}`);
  return res.json();
}

export async function fetchMarkets(): Promise<Record<string, Market>> {
  const res = await fetch(`${API_URL}/api/markets`);
  if (!res.ok) throw new Error(`/api/markets ${res.status}`);
  return res.json();
}

export async function searchSymbols(q: string, limit = 10): Promise<SearchResult[]> {
  const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (!res.ok) throw new Error(`/api/search ${res.status}`);
  const data = await res.json();
  return data.results ?? [];
}

export async function getActiveSymbol(): Promise<string> {
  const res = await fetch(`${API_URL}/api/symbol`);
  if (!res.ok) throw new Error(`/api/symbol ${res.status}`);
  const data = await res.json();
  return data.symbol ?? "";
}

export async function setActiveSymbol(symbol: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/symbol`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol }),
  });
  if (!res.ok) throw new Error(`/api/symbol POST ${res.status}`);
  const data = await res.json();
  return data.symbol ?? symbol;
}
