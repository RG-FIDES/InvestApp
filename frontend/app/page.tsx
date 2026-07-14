"use client";

import { useEffect } from "react";
import { useMarketData } from "./hooks/useMarketData";
import { useMarketStore } from "./lib/store";
import TopBar from "./components/TopBar";
import Watchlist from "./components/Watchlist";
import QuoteHeader from "./components/QuoteHeader";
import ChartCard from "./components/ChartCard";
import KeyStats from "./components/KeyStats";
import ComparisonPanel from "./components/ComparisonPanel";
import NbboPanel from "./components/NbboPanel";
import TradesTape from "./components/TradesTape";
import AlertControl from "./components/AlertControl";
import OverviewPanel from "./components/OverviewPanel";

export default function Home() {
  useMarketData();
  const hydrateSettings = useMarketStore((s) => s.hydrateSettings);

  // Hydrate persisted settings from localStorage on client-side mount.
  // Must run after first render so SSR always uses defaults (no hydration mismatch).
  useEffect(() => {
    hydrateSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page">
      <TopBar />
      <div className="app-body">
        <Watchlist />
        <div className="main-content">
          <main className="quote-page">
            <QuoteHeader />
            <div className="main-grid">
              <div className="col-main">
                <TradesTape />
                <ChartCard />
                <OverviewPanel />
              </div>
              <aside className="col-side">
                <KeyStats />
                <ComparisonPanel />
                <NbboPanel />
                <AlertControl />
              </aside>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
