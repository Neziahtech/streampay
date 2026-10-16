"use server";

import {
  fetchStreamIdsPage,
  readAvailable,
  readStream,
} from "@/lib/stellar-read";

export async function readStreamAction(streamId: string) {
  return readStream(streamId);
}

export async function readAvailableAction(streamId: string) {
  return (await readAvailable(streamId)).toString();
}

export async function fetchStreamIdsPageAction(
  address: string,
  role: "recipient" | "sender",
  offset: number
) {
  return fetchStreamIdsPage(address, role, offset);
}