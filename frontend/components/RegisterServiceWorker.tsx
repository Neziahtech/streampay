"use client";

import { useEffect } from "react";
import { purgeStaleContractStorage } from "@/lib/offline-storage";

export default function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const contractId = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "default";

    // Clean any outdated contract localStorage cache
    purgeStaleContractStorage(contractId);

    // Register service worker with version and contract-id scoping
    navigator.serviceWorker
      .register(`/sw.js?contractId=${encodeURIComponent(contractId)}&v=1`, {
        scope: "/",
      })
      .then((registration) => {
        // If an active SW exists and contractId changed, send invalidation message
        if (registration.active) {
          registration.active.postMessage({
            type: "INVALIDATE_CONTRACT_CACHE",
            contractId,
          });
        }
      })
      .catch(() => {
        // Non-fatal if SW registration fails (e.g. unsupported private browsing)
      });
  }, []);

  return null;
}
