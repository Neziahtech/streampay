"use client";

import { useState } from "react";
import { isConnected, requestAccess } from "@stellar/freighter-api";
import {
  createStream,
  createStreams,
  withdrawFromStream,
  withdrawMaxFromStream,
  topUpStream,
  cancelStream,
  readStream,
  fetchStreamsFor,
  describeError,
  type StreamView,
} from "@/lib/stellar";
import { loadStreamIds, saveStreamId } from "@/lib/storage";
import StreamDashboardView from "@/components/StreamDashboardView";
import { useToast } from "@/components/toast";

export default function Home() {
  const toast = useToast();
  const [address, setAddress] = useState<string | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);

  async function connect() {
    try {
      const { isConnected: connected, error: connectedError } =
        await isConnected();
      if (connectedError || !connected) {
        toast.error("Freighter not detected — install the extension and reload.");
        return;
      }
      const { address, error: accessError } = await requestAccess();
      if (accessError || !address) {
        toast.error(
          `Wallet connection failed: ${
            accessError?.message ?? "no address returned from Freighter."
          }`
        );
        return;
      }
      setAddress(address);
      toast.success(`Connected as ${address.slice(0, 8)}…`);
      // Rehydrate the cached list (ids only; state is always read fresh).
      const cached = loadStreamIds(address);
      if (cached.length > 0) {
        const views = await Promise.all(
          cached.map((id) => readStream(id).catch(() => null))
        );
        setStreams(
          views.filter((s): s is StreamView => s !== null).reverse()
        );
      }
    } catch (e) {
      toast.error(`Wallet connection failed: ${String(e)}`);
    }
  }

  async function refresh(id: string) {
    try {
      const s = await readStream(id);
      setStreams((prev) => [s, ...prev.filter((x) => x.id !== id)]);
      if (address) saveStreamId(address, id);
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function discover() {
    if (!address) return;
    try {
      const [asRecipient, asSender] = await Promise.all([
        fetchStreamsFor(address, "recipient"),
        fetchStreamsFor(address, "sender"),
      ]);
      const byId = new Map<string, StreamView>();
      for (const s of [...asRecipient, ...asSender]) byId.set(s.id, s);
      const found = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
      setStreams(found);
      toast.info(`Discovered ${found.length} stream(s) on-chain.`);
      for (const s of found) saveStreamId(address, s.id);
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function fetchStreamById() {
    const id = lookupId.trim();

    if (!id) {
      toast.error("Enter a stream ID.");
      return;
    }

    setLookupLoading(true);

    try {
      const stream = await readStream(id);
      setStreams((prev) => [stream, ...prev.filter((x) => x.id !== stream.id)]);
      toast.success(`Stream #${stream.id} loaded.`);
      setLookupId("");
    } catch {
      toast.error("Stream not found. Check the ID and try again.");
    } finally {
      setLookupLoading(false);
    }
  }

  return (
    <StreamDashboardView
      address={address}
      streams={streams}
      lookupId={lookupId}
      lookupLoading={lookupLoading}
      onConnect={connect}
      onLookupChange={setLookupId}
      onLookupSubmit={fetchStreamById}
      onCreateStream={async (args) => {
        if (!address) return;
        try {
          const id = await createStream(address, args);
          toast.success(`Stream #${id} created.`);
          await refresh(String(id));
        } catch (e) {
          toast.error(describeError(e));
        }
      }}
      onCreateBatch={async (token, entries, cancelable) => {
        if (!address) return false;
        try {
          const ids = await createStreams(address, token, entries, cancelable);
          toast.success(
            `${ids.length} stream${ids.length === 1 ? "" : "s"} created: ${ids
              .map((id) => `#${id}`)
              .join(", ")}.`
          );
          await Promise.all(ids.map((id) => refresh(String(id))));
          return true;
        } catch (e) {
          toast.error(describeError(e));
          return false;
        }
      }}
      onDiscover={discover}
      onWithdraw={async (id, amount) => {
        if (!address) return;
        try {
          await withdrawFromStream(address, id, amount);
          toast.success(`Withdrew ${amount} units from stream #${id}.`);
          await refresh(id);
        } catch (e) {
          toast.error(describeError(e));
        }
      }}
      onWithdrawMax={async (id) => {
        if (!address) return;
        try {
          const paid = await withdrawMaxFromStream(address, id);
          toast.success(`Claimed ${paid} units from stream #${id}.`);
          await refresh(id);
        } catch (e) {
          toast.error(describeError(e));
        }
      }}
      onTopUp={async (id, amount) => {
        if (!address) return;
        try {
          await topUpStream(address, id, amount);
          toast.success(`Topped up stream #${id} by ${amount} units.`);
          await refresh(id);
        } catch (e) {
          toast.error(describeError(e));
        }
      }}
      onCancel={async (id) => {
        if (!address) return;
        try {
          await cancelStream(address, id);
          toast.success(`Stream #${id} cancelled.`);
          await refresh(id);
        } catch (e) {
          toast.error(describeError(e));
        }
      }}
      onRefresh={(id) => refresh(id)}
    />
  );
}
