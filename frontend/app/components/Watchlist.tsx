"use client";

// Placeholder watchlist — will be wired to multi-stock tracking in the future.
export default function Watchlist() {
  const symbols = [
    { symbol: "MU", active: true },
    { symbol: "AAPL", active: false },
    { symbol: "NVDA", active: false },
    { symbol: "MSFT", active: false },
  ];

  return (
    <nav className="watchlist">
      <div className="wl-label">Watchlist</div>
      {symbols.map((s) => (
        <div
          key={s.symbol}
          className={`wl-item ${s.active ? "active" : ""}`}
        >
          {s.symbol}
        </div>
      ))}
      <div className="wl-item placeholder">+ Add symbol</div>
    </nav>
  );
}
