"use client";

import { useState } from "react";
import { useMarketStore } from "../lib/store";
import { wsSender } from "../lib/wsSender";
import {
  NOTIFICATION_EVENT_LABELS,
  type CustomNotification,
  type CustomNotificationConditions,
  type NotificationEventType,
} from "../lib/types";

const EMPTY_CONDITIONS: CustomNotificationConditions = {
  priceAbove: null,
  priceBelow: null,
  dayHighBroken: false,
  dayLowBroken: false,
  volumeAbove: null,
  volumeSpike: false,
  percentMoveUp: null,
  percentMoveDown: null,
  marketStateIs: null,
};

const PRESET_EVENTS: NotificationEventType[] = [
  "day_high",
  "day_low",
  "volume_spike",
  "market_transition",
  "percent_move",
];

function makeId() {
  return `cn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function countActiveConditions(c: CustomNotificationConditions): number {
  let n = 0;
  if (c.priceAbove != null) n++;
  if (c.priceBelow != null) n++;
  if (c.dayHighBroken) n++;
  if (c.dayLowBroken) n++;
  if (c.volumeAbove != null) n++;
  if (c.volumeSpike) n++;
  if (c.percentMoveUp != null) n++;
  if (c.percentMoveDown != null) n++;
  if (c.marketStateIs != null) n++;
  return n;
}

function describeConditions(c: CustomNotificationConditions): string {
  const parts: string[] = [];
  if (c.priceAbove != null) parts.push(`price above $${c.priceAbove.toFixed(2)}`);
  if (c.priceBelow != null) parts.push(`price below $${c.priceBelow.toFixed(2)}`);
  if (c.dayHighBroken) parts.push("day high broken");
  if (c.dayLowBroken) parts.push("day low broken");
  if (c.volumeSpike) parts.push("volume spikes");
  if (c.volumeAbove != null) parts.push(`volume above ${c.volumeAbove.toLocaleString()}`);
  if (c.percentMoveUp != null) parts.push(`up +${c.percentMoveUp}% from open`);
  if (c.percentMoveDown != null) parts.push(`down -${c.percentMoveDown}% from open`);
  if (c.marketStateIs) parts.push(`market is ${c.marketStateIs.toLowerCase()}`);
  if (parts.length === 0) return "No conditions";
  return parts.join(" AND ");
}

export default function AlertsPanel() {
  const customNotifs = useMarketStore((s) => s.customNotifications);
  const subs = useMarketStore((s) => s.notificationSubs);
  const togglePreset = useMarketStore((s) => s.toggleNotificationEvent);
  const browserPushEnabled = useMarketStore((s) => s.browserPushEnabled);
  const setBrowserPushEnabled = useMarketStore((s) => s.setBrowserPushEnabled);
  const addCustom = useMarketStore((s) => s.addCustomNotification);
  const updateCustom = useMarketStore((s) => s.updateCustomNotification);
  const removeCustom = useMarketStore((s) => s.removeCustomNotification);
  const toggleCustom = useMarketStore((s) => s.toggleCustomNotification);
  const clearAll = useMarketStore((s) => s.clearAllNotifications);
  const unreadCount = useMarketStore((s) => s.unreadNotificationCount);

  const [showBuilder, setShowBuilder] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Builder form state
  const [name, setName] = useState("");
  const [repeat, setRepeat] = useState<"once" | "every">("every");
  const [conds, setConds] = useState<CustomNotificationConditions>({ ...EMPTY_CONDITIONS });

  const isEditing = editingId != null;
  const activeConditions = countActiveConditions(conds);

  const resetForm = () => {
    setName("");
    setRepeat("every");
    setConds({ ...EMPTY_CONDITIONS });
    setEditingId(null);
    setShowBuilder(false);
  };

  const openBuilder = () => {
    resetForm();
    setShowBuilder(true);
  };

  const openEdit = (n: CustomNotification) => {
    setName(n.name);
    setRepeat(n.repeat);
    setConds({ ...EMPTY_CONDITIONS, ...n.conditions });
    setEditingId(n.id);
    setShowBuilder(true);
  };

  const updateConds = (patch: Partial<CustomNotificationConditions>) => {
    setConds((prev) => ({ ...prev, ...patch }));
  };

  const saveAlert = () => {
    if (activeConditions === 0) return;
    const base = {
      name: name.trim() || describeConditions(conds),
      repeat,
      conditions: conds,
    };

    if (isEditing && editingId) {
      const existing = customNotifs.find((n) => n.id === editingId)!;
      const updated: CustomNotification = { ...existing, ...base };
      updateCustom(editingId, updated);
      if (updated.enabled) {
        wsSender.send({ action: "update_custom", notification: updated });
      }
    } else {
      const cn: CustomNotification = {
        ...base,
        id: makeId(),
        enabled: true,
        createdAt: new Date().toISOString(),
        lastFiredAt: null,
        fireCount: 0,
      };
      addCustom(cn);
      wsSender.send({ action: "add_custom", notification: cn });
    }
    resetForm();
  };

  const handleToggleCustom = (n: CustomNotification) => {
    toggleCustom(n.id);
    const updated = { ...n, enabled: !n.enabled };
    if (updated.enabled) {
      wsSender.send({ action: "add_custom", notification: updated });
    } else {
      wsSender.send({ action: "remove_custom", id: n.id });
    }
  };

  const handleRemove = (id: string) => {
    removeCustom(id);
    wsSender.send({ action: "remove_custom", id });
    if (editingId === id) resetForm();
  };

  const handleBrowserPush = async () => {
    if (!browserPushEnabled) {
      if (Notification.permission === "default") {
        const granted = await Notification.requestPermission();
        if (granted !== "granted") return;
      } else if (Notification.permission === "denied") {
        alert("Browser notifications are blocked. Enable them in your browser settings.");
        return;
      }
    }
    setBrowserPushEnabled(!browserPushEnabled);
  };

  return (
    <section className="panel alerts-panel">
      <div className="alerts-header">
        <div className="alerts-title-row">
          <span className="panel-title">Alerts</span>
          <button className="alerts-add-btn" onClick={openBuilder}>
            + New Alert
          </button>
        </div>
        <p className="alerts-subtitle">Choose preset market alerts or build your own.</p>
      </div>

      {/* ---- Preset market alerts ---- */}
      <div className="alerts-section">
        <div className="alerts-section-title">Market Alerts</div>
        <div className="alerts-preset-grid">
          {PRESET_EVENTS.map((event) => (
            <label key={event} className="alerts-preset-card">
              <input
                type="checkbox"
                checked={subs[event]}
                onChange={() => togglePreset(event)}
              />
              <span className="alerts-preset-check" />
              <span className="alerts-preset-label">
                {NOTIFICATION_EVENT_LABELS[event]}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* ---- Custom alerts list ---- */}
      <div className="alerts-section">
        <div className="alerts-section-title">My Alerts ({customNotifs.length})</div>
        {customNotifs.length === 0 ? (
          <div className="alerts-empty">
            No custom alerts yet. Click <strong>+ New Alert</strong> to create one.
          </div>
        ) : (
          <div className="alerts-list">
            {customNotifs.map((n) => (
              <div key={n.id} className={`alerts-item ${n.enabled ? "" : "disabled"}`}>
                <div className="alerts-item-main">
                  <div className="alerts-item-name">{n.name}</div>
                  <div className="alerts-item-desc">{describeConditions(n.conditions)}</div>
                  <div className="alerts-item-meta">
                    {n.repeat === "once" ? "Run once" : "Run every time"}
                    {n.fireCount > 0 && ` · Fired ${n.fireCount}x`}
                  </div>
                </div>
                <div className="alerts-item-actions">
                  <button
                    className={`alerts-item-toggle ${n.enabled ? "on" : ""}`}
                    onClick={() => handleToggleCustom(n)}
                    title={n.enabled ? "Disable" : "Enable"}
                  >
                    {n.enabled ? "On" : "Off"}
                  </button>
                  <button className="alerts-item-btn" onClick={() => openEdit(n)} title="Edit">
                    ✎
                  </button>
                  <button
                    className="alerts-item-btn alerts-item-delete"
                    onClick={() => handleRemove(n.id)}
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Alert builder ---- */}
      {showBuilder && (
        <div className="alerts-builder">
          <div className="alerts-builder-title">
            {isEditing ? "Edit Alert" : "New Alert"}
          </div>

          <div className="alerts-builder-summary">
            Notify me when <strong>{describeConditions(conds)}</strong>
          </div>

          {/* Name */}
          <div className="alerts-field">
            <label className="alerts-field-label">Alert name (optional)</label>
            <input
              className="alerts-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={describeConditions(conds)}
              maxLength={50}
            />
          </div>

          {/* Price */}
          <div className="alerts-condition-group">
            <label className="alerts-condition-title">Price</label>
            <div className="alerts-condition-row">
              <span>is above</span>
              <input
                className="alerts-input alerts-input-sm"
                type="number"
                step="0.01"
                value={conds.priceAbove ?? ""}
                onChange={(e) =>
                  updateConds({ priceAbove: e.target.value ? parseFloat(e.target.value) : null })
                }
                placeholder="0.00"
              />
            </div>
            <div className="alerts-condition-row">
              <span>is below</span>
              <input
                className="alerts-input alerts-input-sm"
                type="number"
                step="0.01"
                value={conds.priceBelow ?? ""}
                onChange={(e) =>
                  updateConds({ priceBelow: e.target.value ? parseFloat(e.target.value) : null })
                }
                placeholder="0.00"
              />
            </div>
          </div>

          {/* Day high/low */}
          <div className="alerts-condition-group">
            <label className="alerts-condition-title">Session</label>
            <label className="alerts-check">
              <input
                type="checkbox"
                checked={conds.dayHighBroken}
                onChange={(e) => updateConds({ dayHighBroken: e.target.checked })}
              />
              Day high is broken
            </label>
            <label className="alerts-check">
              <input
                type="checkbox"
                checked={conds.dayLowBroken}
                onChange={(e) => updateConds({ dayLowBroken: e.target.checked })}
              />
              Day low is broken
            </label>
          </div>

          {/* Volume */}
          <div className="alerts-condition-group">
            <label className="alerts-condition-title">Volume</label>
            <label className="alerts-check">
              <input
                type="checkbox"
                checked={conds.volumeSpike}
                onChange={(e) => updateConds({ volumeSpike: e.target.checked })}
              />
              Spikes above 3× average
            </label>
            <div className="alerts-condition-row">
              <span>is above</span>
              <input
                className="alerts-input alerts-input-sm"
                type="number"
                step="1"
                value={conds.volumeAbove ?? ""}
                onChange={(e) =>
                  updateConds({ volumeAbove: e.target.value ? parseInt(e.target.value, 10) : null })
                }
                placeholder="shares"
              />
            </div>
          </div>

          {/* Percent move */}
          <div className="alerts-condition-group">
            <label className="alerts-condition-title">% Move from Open</label>
            <div className="alerts-condition-row">
              <span>Up at least</span>
              <input
                className="alerts-input alerts-input-sm"
                type="number"
                step="0.1"
                value={conds.percentMoveUp ?? ""}
                onChange={(e) =>
                  updateConds({ percentMoveUp: e.target.value ? parseFloat(e.target.value) : null })
                }
                placeholder="2.0"
              />
              <span>%</span>
            </div>
            <div className="alerts-condition-row">
              <span>Down at least</span>
              <input
                className="alerts-input alerts-input-sm"
                type="number"
                step="0.1"
                value={conds.percentMoveDown ?? ""}
                onChange={(e) =>
                  updateConds({ percentMoveDown: e.target.value ? parseFloat(e.target.value) : null })
                }
                placeholder="2.0"
              />
              <span>%</span>
            </div>
          </div>

          {/* Market state */}
          <div className="alerts-condition-group">
            <label className="alerts-condition-title">Market State</label>
            <div className="alerts-condition-row">
              <span>is</span>
              <select
                className="alerts-input alerts-input-sm"
                value={conds.marketStateIs ?? ""}
                onChange={(e) => updateConds({ marketStateIs: e.target.value || null })}
              >
                <option value="">— any —</option>
                <option value="PRE">Pre-Market</option>
                <option value="REGULAR">Regular Hours</option>
                <option value="POST">After Hours</option>
              </select>
            </div>
          </div>

          {/* Repeat */}
          <div className="alerts-condition-group">
            <label className="alerts-condition-title">Run Frequency</label>
            <div className="alerts-radio-row">
              <label className="alerts-radio">
                <input
                  type="radio"
                  name="repeat"
                  value="every"
                  checked={repeat === "every"}
                  onChange={() => setRepeat("every")}
                />
                Every time triggered
              </label>
              <label className="alerts-radio">
                <input
                  type="radio"
                  name="repeat"
                  value="once"
                  checked={repeat === "once"}
                  onChange={() => setRepeat("once")}
                />
                Once only
              </label>
            </div>
          </div>

          {/* Builder actions */}
          <div className="alerts-builder-actions">
            <button
              className="alerts-btn alerts-btn-primary"
              onClick={saveAlert}
              disabled={activeConditions === 0}
            >
              {isEditing ? "Update Alert" : "Create Alert"}
            </button>
            <button className="alerts-btn" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---- Settings ---- */}
      <div className="alerts-settings">
        <label className="alerts-settings-toggle">
          <input
            type="checkbox"
            checked={browserPushEnabled}
            onChange={handleBrowserPush}
          />
          <span>Desktop notifications</span>
          <small>Show OS toasts when tab is hidden</small>
        </label>
        <button className="alerts-clear" onClick={clearAll} disabled={unreadCount === 0}>
          Clear all notifications ({unreadCount})
        </button>
      </div>
    </section>
  );
}
