// Import the REAL module under a forced-UTC process so Intl results are
// deterministic (the module itself pins timeZone: "America/New_York").
process.env.TZ = "UTC";
const { getMarketSession, nextSessionBoundary, formatCountdown } = await import("./app/lib/marketHours.ts").catch(async () => {
  // If direct .ts import isn't supported, fall back to a transpile-free check.
  throw new Error("ts-import-not-supported");
});

const cases = [
  "2026-07-14T08:00:00Z", // 04:00 ET -> pre
  "2026-07-14T12:00:00Z", // 08:00 ET -> pre
  "2026-07-14T14:00:00Z", // 10:00 ET -> regular
  "2026-07-14T19:59:00Z", // 15:59 ET -> regular
  "2026-07-14T20:00:30Z", // 16:00:30 ET -> post
  "2026-07-14T23:59:00Z", // 19:59 ET -> post
  "2026-07-15T00:00:30Z", // 20:00:30 ET -> closed (overnight)
  "2026-07-18T14:00:00Z", // Sat 10:00 ET -> closed
  "2026-07-20T07:59:00Z", // Mon 03:59 ET -> closed
];

for (const lbl of cases) {
  const now = new Date(lbl);
  const s = getMarketSession(now);
  const t = nextSessionBoundary(now);
  console.log(lbl, "=> session", s, "|", t.label, formatCountdown(t.epoch, now.getTime()));
}
