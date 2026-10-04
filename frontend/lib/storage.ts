/**
 * Session persistence for the stream list.
 *
 * The on-chain indexes (`fetchStreamsFor`) are the canonical discovery path;
 * this localStorage cache is a UX convenience so the list survives page
 * reloads without a chain scan for returning users. Keys are scoped by
 * network and wallet address — ids from testnet never show up on publicnet.
 */
import { NETWORK_LABEL } from "./stellar";

const keyFor = (address: string) =>
  `streampay:${NETWORK_LABEL}:${address}:streamIds`;

/** Stream ids previously saved for this address (oldest first). */
export function loadStreamIds(address: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** Remembers a stream id (deduplicated, insertion-ordered). */
export function saveStreamId(address: string, id: string): void {
  if (typeof window === "undefined") return;
  const ids = loadStreamIds(address);
  if (!ids.includes(id)) {
    ids.push(id);
    window.localStorage.setItem(keyFor(address), JSON.stringify(ids));
  }
}
