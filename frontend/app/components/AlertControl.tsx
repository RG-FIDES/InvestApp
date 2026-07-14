"use client";

import { useState } from "react";
import { useMarketStore } from "../lib/store";
import { wsSender } from "../lib/wsSender";
import { fmtPrice } from "../lib/format";

export default function AlertControl() {
  const alertPrice = useMarketStore((s) => s.alertPrice);
  const setAlertPrice = useMarketStore((s) => s.setAlertPrice);
  const alertMessage = useMarketStore((s) => s.alertMessage);
  const setAlertMessage = useMarketStore((s) => s.setAlertMessage);
  const [input, setInput] = useState("");

  const setAlert = () => {
    const p = parseFloat(input);
    if (!isNaN(p)) {
      setAlertPrice(p);
      wsSender.send({ action: "set_alert", price: p });
    }
  };

  const clearAlert = () => {
    setAlertPrice(null);
    setAlertMessage(null);
    wsSender.send({ action: "clear_alert" });
  };

  return (
    <section className="panel alert">
      <div className="panel-title">Price Alert</div>
      <div className="alert-row">
        <input
          type="number"
          step="0.01"
          placeholder="Trigger price"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button onClick={setAlert}>Set</button>
        <button onClick={clearAlert}>Clear</button>
      </div>
      <div className="alert-status">
        {alertPrice != null && <span>Alert @ {fmtPrice(alertPrice)}</span>}
        {alertMessage && <span className="alert-banner">{alertMessage}</span>}
      </div>
    </section>
  );
}
