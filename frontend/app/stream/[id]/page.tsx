"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getAddress, isConnected } from "@stellar/freighter-api";
import {
  cancelStream,
  describeError,
  readAvailable,
  readStream,
  withdrawFromStream,
  withdrawMaxFromStream,
  type StreamView,
} from "@/lib/stellar";
import { computeAvailable, StreamSnapshot } from "@/lib/accrual";
import { useToast } from "@/components/toast";
import StreamDetailView from "@/components/StreamDetailView";

function fmtUnits(v: bigint): string {
  return v.toString();
}

export default function StreamDetail() {
  const toast = useToast();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [stream, setStream] = useState<StreamView | null>(null);
  const [available, setAvailable] = useState<bigint | null>(null);
  const [displayAvailable, setDisplayAvailable] = useState<bigint | null>(
    null
  );
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [address, setAddress] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string>("");

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const [s, a] = await Promise.all([readStream(id), readAvailable(id)]);
      setStream(s);
      setAvailable(a);
      setSnapshot({
        deposit: BigInt(s.deposit),
        startTime: s.startTime,
        endTime: s.endTime,
        withdrawn: BigInt(s.withdrawn),
        status: s.status,
      });
      setLoadError("");
    } catch (e) {
      const msg = describeError(e);
      setLoadError(msg);
      toast.error(msg);
    }
  }, [id, toast]);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
    const t = setInterval(() => void reload(), 15_000); // live accrual
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (!snapshot) return;
    const timer = setInterval(() => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const next = computeAvailable(
        snapshot.deposit,
        snapshot.startTime,
        snapshot.endTime,
        snapshot.withdrawn,
        snapshot.status,
        now
      );
      setDisplayAvailable(next);
    }, 1000);
    return () => clearInterval(timer);
  }, [snapshot]);

  useEffect(() => {
    void (async () => {
      try {
        if (await isConnected()) {
          const { address } = await getAddress();
          setAddress(address);
        }
      } catch {
        // Detail view stays read-only without a wallet.
      }
    })();
  }, []);

  const overWithdrawal =
    available !== null && amount !== "" && BigInt(amount || "0") > available;

  async function doWithdraw(max: boolean) {
    if (!address) return;
    try {
      if (max) {
        const paid = await withdrawMaxFromStream(address, stream!.id);
        toast.success(`Claimed ${fmtUnits(paid)} units.`);
      } else {
        if (overWithdrawal) {
          toast.error(
            `Amount exceeds the accrued balance (${available?.toString()} units). Try “Withdraw max”.`
          );
          return;
        }
        await withdrawFromStream(address, stream!.id, amount || "0");
        toast.success("Withdrawal sent.");
      }
      setAmount("");
      await reload();
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  async function doCancel() {
    if (!address) return;
    try {
      await cancelStream(address, stream!.id);
      toast.success("Stream cancelled.");
      await reload();
    } catch (e) {
      toast.error(describeError(e));
    }
  }

  return (
    <StreamDetailView
      id={id}
      stream={stream}
      loadError={loadError}
      available={available}
      displayAvailable={displayAvailable}
      address={address}
      amount={amount}
      onAmountChange={setAmount}
      onWithdraw={doWithdraw}
      onCancel={doCancel}
    />
  );
}
