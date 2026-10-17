/**
 * Offline storage for StreamPay stream state.
 *
 * Provides resilient, field-accessible caching of stream lists and individual
 * stream details. In the field with spotty or zero connectivity, users can
 * inspect their active payment streams, recipients, deposits, and start/end times.
 *
 * Caches are scoped by network and contract ID to avoid cross-network or stale
 * contract pollution.
 */

import type { StreamView } from "./stream-types.ts";

const NETWORK_LABEL =
  process.env.NEXT_PUBLIC_NETWORK === "PUBLIC" ? "public" : "testnet";
const CONTRACT_ID = process.env.NEXT_PUBLIC_STREAMING_CONTRACT_ID || "default";

export interface CachedStreamList {
  address: string;
  streams: StreamView[];
  cachedAt: number;
  contractId: string;
}

export interface CachedStreamDetail {
  stream: StreamView;
  available: string; // stringified bigint
  cachedAt: number;
  contractId: string;
}

function listKey(address: string): string {
  return `streampay:${NETWORK_LABEL}:${CONTRACT_ID}:${address}:cachedStreamList`;
}

function detailKey(streamId: string): string {
  return `streampay:${NETWORK_LABEL}:${CONTRACT_ID}:stream:${streamId}`;
}

/**
 * Saves a list of discovered streams for an address to offline storage.
 */
export function saveCachedStreams(address: string, streams: StreamView[]): void {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedStreamList = {
      address,
      streams,
      cachedAt: Date.now(),
      contractId: CONTRACT_ID,
    };
    window.localStorage.setItem(listKey(address), JSON.stringify(payload));
  } catch {
    // LocalStorage write quota or private mode error
  }
}

/**
 * Loads cached stream list for an address if available.
 */
export function loadCachedStreams(address: string): CachedStreamList | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(listKey(address));
    if (!raw) return null;
    const data = JSON.parse(raw) as CachedStreamList;
    if (data.contractId !== CONTRACT_ID) {
      window.localStorage.removeItem(listKey(address));
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Saves full detail of a single stream and its latest available balance.
 */
export function saveCachedStreamDetail(
  streamId: string,
  stream: StreamView,
  available: string | bigint
): void {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedStreamDetail = {
      stream,
      available: available.toString(),
      cachedAt: Date.now(),
      contractId: CONTRACT_ID,
    };
    window.localStorage.setItem(detailKey(streamId), JSON.stringify(payload));
  } catch {
    // LocalStorage quota or private mode
  }
}

/**
 * Loads cached stream detail for offline viewing in the field.
 */
export function loadCachedStreamDetail(streamId: string): CachedStreamDetail | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(detailKey(streamId));
    if (!raw) return null;
    const data = JSON.parse(raw) as CachedStreamDetail;
    if (data.contractId !== CONTRACT_ID) {
      window.localStorage.removeItem(detailKey(streamId));
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Purges any cached entries belonging to older contract IDs.
 */
export function purgeStaleContractStorage(currentContractId: string): void {
  if (typeof window === "undefined") return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(`streampay:${NETWORK_LABEL}:`)) {
        if (!key.includes(`:${currentContractId}:`)) {
          keysToRemove.push(key);
        }
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Non-fatal
  }
}
