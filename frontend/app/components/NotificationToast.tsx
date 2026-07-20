"use client";

import { useEffect, useRef, useState } from "react";
import { useMarketStore } from "../lib/store";

/** Auto-dismiss each toast after this many ms. */
const AUTO_DISMISS_MS = 6000;

export default function NotificationToast() {
  const notifications = useMarketStore((s) => s.notifications);
  const dismissNotification = useMarketStore((s) => s.dismissNotification);
  // Track ids that have been "seen" so we only animate new ones in.
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // When a new notification arrives that hasn't been seen yet, schedule its
  // auto-dismiss and mark it as seen.
  useEffect(() => {
    for (const n of notifications) {
      if (seenIds.has(n.id)) continue;
      setSeenIds((prev) => new Set(prev).add(n.id));
      const timer = setTimeout(() => {
        dismissNotification(n.id);
        timersRef.current.delete(n.id);
      }, AUTO_DISMISS_MS);
      timersRef.current.set(n.id, timer);
    }
    // Cleanup stale timers for dismissed notifications.
    const active = new Set(notifications.map((n) => n.id));
    for (const [id, timer] of timersRef.current) {
      if (!active.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [notifications, dismissNotification, seenIds]);

  const handleDismiss = (id: string) => {
    dismissNotification(id);
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  };

  if (notifications.length === 0) return null;

  const levelClass =
    (n: typeof notifications[number]) =>
      n.level === "critical" ? "nt-critical" : n.level === "warning" ? "nt-warning" : "nt-info";

  return (
    <div className="notification-toast-container">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`notification-toast ${levelClass(n)}`}
          onClick={() => handleDismiss(n.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && handleDismiss(n.id)}
        >
          <div className="nt-title">{n.title}</div>
          <div className="nt-body">{n.body}</div>
        </div>
      ))}
    </div>
  );
}
