// Market session helpers, dependency-free & DST-aware. Session boundaries are
// modeled on the US equity day (pre 04:00–09:30, regular 09:30–16:00, post
// 16:00–20:00). The timezone is parameterised so the same logic works for any
// registered market (Tokyo, London, …) once its sessions are configured.
// Sessions (in the market's local time, Mon–Fri):
//   pre-market : 04:00–09:30
//   regular    : 09:30–16:00
//   post-market : 16:00–20:00
//   closed     : overnight (20:00–04:00) and weekends

const DEFAULT_TZ = "America/New_York";

export type MarketSession = "pre" | "regular" | "post" | "closed";

const PRE_OPEN = { h: 4, m: 0 };
const REG_OPEN = { h: 9, m: 30 };
const REG_CLOSE = { h: 16, m: 0 };
const POST_CLOSE = { h: 20, m: 0 };

interface NYParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getNYParts(date: Date, tz: string = DEFAULT_TZ): NYParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  // Intl may emit "24" for midnight in some engines; normalize to 0.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function tzOffsetMs(date: Date): number {
  const p = getNYParts(date);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - date.getTime();
}

function nyWallToEpoch(c: NYParts): number {
  const approx = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  const refined = approx - tzOffsetMs(new Date(approx));
  return refined - tzOffsetMs(new Date(refined));
}

function nyWeekday(epoch: number): number {
  const p = getNYParts(new Date(epoch));
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function isWeekday(epoch: number): boolean {
  const wd = nyWeekday(epoch);
  return wd >= 1 && wd <= 5;
}

export function getMarketSession(now: Date = new Date(), tz: string = DEFAULT_TZ): MarketSession {
  const p = getNYParts(now, tz);
  const nowMs = now.getTime();
  if (!isWeekday(nowMs)) return "closed";
  const preOpen = nyWallToEpoch({ ...p, hour: PRE_OPEN.h, minute: PRE_OPEN.m, second: 0 });
  const regOpen = nyWallToEpoch({ ...p, hour: REG_OPEN.h, minute: REG_OPEN.m, second: 0 });
  const regClose = nyWallToEpoch({ ...p, hour: REG_CLOSE.h, minute: REG_CLOSE.m, second: 0 });
  const postClose = nyWallToEpoch({ ...p, hour: POST_CLOSE.h, minute: POST_CLOSE.m, second: 0 });
  if (nowMs >= preOpen && nowMs < regOpen) return "pre";
  if (nowMs >= regOpen && nowMs < regClose) return "regular";
  if (nowMs >= regClose && nowMs < postClose) return "post";
  return "closed";
}

export function formatCountdown(targetEpoch: number, nowMs: number): string {
  const diff = Math.max(0, targetEpoch - nowMs);
  const totalSec = Math.floor(diff / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}
