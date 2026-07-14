import type { Bar, BarInterval, ChartRange, Quote } from "./types";

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
