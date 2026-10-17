"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handler = (e: Event) => {
      // If app is already installed in standalone mode, don't show install banner
      if (window.matchMedia("(display-mode: standalone)").matches) return;
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowInstall(true);
    };

    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  async function handleInstallClick() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setShowInstall(false);
    }
    setDeferredPrompt(null);
  }

  return (
    <>
      {showInstall && (
        <aside
          role="region"
          aria-label="PWA install banner"
          className="card"
          style={{
            margin: "12px 0",
            padding: "12px 16px",
            background: "rgba(139, 124, 255, 0.08)",
            border: "1px solid var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span aria-hidden="true" style={{ fontSize: "20px" }}>📲</span>
            <div>
              <strong style={{ fontSize: "14px" }}>Install StreamPay</strong>
              <div style={{ fontSize: "12px", color: "var(--muted)" }}>
                Install on your device for instant offline access to payment streams and accrual counters.
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              onClick={handleInstallClick}
              style={{ padding: "6px 14px", fontSize: "13px" }}
            >
              Install App
            </button>
            <button
              type="button"
              onClick={() => setShowInfoModal(true)}
              style={{
                background: "transparent",
                border: "1px solid var(--line)",
                padding: "6px 12px",
                fontSize: "13px",
              }}
            >
              Mobile Info
            </button>
            <button
              type="button"
              onClick={() => setShowInstall(false)}
              aria-label="Dismiss install prompt"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--muted)",
                fontSize: "18px",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
        </aside>
      )}

      {/* Info modal for mobile quirks */}
      {showInfoModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-info-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
            zIndex: 10000,
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: "520px",
              width: "100%",
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: "12px",
              padding: "24px",
            }}
          >
            <h2 id="mobile-info-title" style={{ marginTop: 0 }}>
              Mobile Installation & Wallet Quirks
            </h2>

            <div style={{ fontSize: "14px", color: "var(--text)", lineHeight: 1.6 }}>
              <p>
                <strong>iOS (Safari):</strong> Apple WebKit does not trigger automatic install banners.
                To install, tap the <strong>Share</strong> button at the bottom of Safari, then select{" "}
                <strong>&quot;Add to Home Screen&quot;</strong>.
              </p>

              <p>
                <strong>Android (Chrome):</strong> Tap the browser menu (⋮) and select{" "}
                <strong>&quot;Install app&quot;</strong> or <strong>&quot;Add to Home Screen&quot;</strong>.
              </p>

              <div
                style={{
                  background: "rgba(245, 158, 11, 0.1)",
                  borderLeft: "4px solid var(--amber)",
                  padding: "10px 12px",
                  borderRadius: "4px",
                  margin: "12px 0",
                  fontSize: "13px",
                }}
              >
                <strong>Mobile Wallet Sandboxing:</strong>
                <br />
                Standalone PWAs on iOS and Android run in restricted WebViews where browser extensions
                (including the desktop Freighter extension) cannot inject themselves.
                <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
                  <li>
                    <strong>Offline Reads:</strong> 100% supported! You can inspect all cached streams and
                    real-time accruals in standalone PWA mode anywhere in the field.
                  </li>
                  <li>
                    <strong>Transaction Signing:</strong> To sign transactions on mobile, open StreamPay
                    directly inside a wallet dApp browser (such as Lobstr or mobile browsers with extension support like Kiwi) or use deep-link wallet connections.
                  </li>
                </ul>
              </div>
            </div>

            <div style={{ textAlign: "right", marginTop: "16px" }}>
              <button
                type="button"
                onClick={() => setShowInfoModal(false)}
                style={{ padding: "8px 16px" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
