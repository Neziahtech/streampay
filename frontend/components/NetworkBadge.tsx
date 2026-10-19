"use client";

/**
 * Network / contract indicator (issue #33).
 *
 * Shows the network and streaming contract every transaction here is built
 * for, and — once a wallet is connected — warns if Freighter is pointed at a
 * different network, which would otherwise surface only as an opaque signing
 * error. The warning is dismissible; the badge itself is not.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  APP_CONTRACT_ID,
  APP_NETWORK_BADGE,
  APP_NETWORK_LABEL,
  checkWalletNetwork,
  defaultNetworkWarningStore,
  explorerContractUrl,
  mismatchHint,
  networkDisplayName,
  truncateContractId,
  type NetworkWarningStore,
} from "@/lib/network";

const INITIAL_STATE = { warning: null, dismissed: false } as const;
const getServerSnapshot = () => INITIAL_STATE;

export default function NetworkBadge({
  store = defaultNetworkWarningStore,
}: {
  store?: NetworkWarningStore;
}) {
  const { warning, dismissed } = useSyncExternalStore(
    store.subscribe,
    store.getState,
    getServerSnapshot
  );

  // A wallet connected before this page loaded (extension already authorised)
  // must not silently sign for the wrong network. With no extension present
  // getNetwork answers with an error, which reports nothing.
  useEffect(() => {
    void checkWalletNetwork(store);
  }, [store]);

  return (
    <header className="network-indicator">
      <div className="network-bar">
        <span className={`network-chip network-chip-${APP_NETWORK_LABEL}`}>
          {APP_NETWORK_BADGE}
        </span>
        <span className="network-text">
          Stellar {networkDisplayName(APP_NETWORK_LABEL)}
        </span>
        {APP_CONTRACT_ID ? (
          <a
            className="network-contract mono"
            href={explorerContractUrl()}
            target="_blank"
            rel="noreferrer noopener"
            title={APP_CONTRACT_ID}
          >
            <span aria-hidden="true">
              contract {truncateContractId(APP_CONTRACT_ID)}
            </span>
            {/* The exact id, spelled out for assistive tech and copy. */}
            <span className="sr-only">
              Streaming contract id {APP_CONTRACT_ID} — opens the block
              explorer
            </span>
          </a>
        ) : (
          <span className="network-contract-unset">
            contract id not configured
          </span>
        )}
      </div>

      {warning && !dismissed && (
        <div className="network-warning" role="alert">
          <div className="network-warning-body">
            <strong className="network-warning-title">
              Wallet is on {networkDisplayName(warning.walletLabel)}
            </strong>
            <p className="network-warning-text">
              This app signs for {networkDisplayName(warning.appLabel)}.
              Transactions will fail until the wallet matches.
            </p>
            <p className="network-warning-hint">{mismatchHint(warning)}</p>
          </div>
          <button
            type="button"
            className="network-warning-dismiss toast-close"
            onClick={store.dismiss}
            aria-label="Dismiss network warning"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
    </header>
  );
}
