"use client";

import { useSyncExternalStore, useState } from "react";

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineSnapshot() {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

function getOnlineServerSnapshot() {
  return true;
}

export default function OfflineBanner() {
  const isOnline = useSyncExternalStore(
    subscribeOnline,
    getOnlineSnapshot,
    getOnlineServerSnapshot
  );
  const [dismissed, setDismissed] = useState<boolean>(false);

  if (isOnline || dismissed) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="offline-banner"
      style={{
        background: "rgba(245, 158, 11, 0.12)",
        borderBottom: "1px solid var(--amber)",
        color: "var(--text)",
        padding: "10px 16px",
        fontSize: "14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        zIndex: 9999,
        position: "sticky",
        top: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: "var(--amber)",
          }}
        />
        <span>
          <strong>Offline Mode:</strong> You are browsing cached stream state.
          Signed transactions are queued and will remain safely saved until connectivity returns.
        </span>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss offline banner"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--muted)",
          cursor: "pointer",
          fontSize: "18px",
          lineHeight: 1,
          padding: "4px 8px",
        }}
      >
        ×
      </button>
    </div>
  );
}
