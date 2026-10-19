"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getAddress, isConnected } from "@stellar/freighter-api";
import {
  cancelStream,
  describeError,
  readAvailable,
  readBeneficiaryKey,
  readSponsor,
  readStream,
  RELAY_URL,
  SPONSOR_ADDRESS,
  STREAMING_CONTRACT_ID,
  withdrawFromStream,
  withdrawMaxFromStream,
  fetchAssetMeta,
  type AssetMeta,
  type SponsorView,
  type StreamView,
} from "@/lib/stellar";
import { useClaimScheduler } from "@/lib/use-claim-scheduler";
import ClaimSchedulerSettings from "@/components/ClaimSchedulerSettings";
import { computeAvailable, StreamSnapshot } from "@/lib/accrual";
import {
  consentPublicKeyHex,
  DEFAULT_INTENT_TTL_SECONDS,
  intentDeadline,
  loadOrCreateConsentKey,
  nextNonce,
  requestSponsoredClaim,
  signClaim,
  type ClaimIntent,
} from "@/lib/sponsor";
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
  const [assetMeta, setAssetMeta] = useState<AssetMeta | null>(null);
  const [available, setAvailable] = useState<bigint | null>(null);
  const [displayAvailable, setDisplayAvailable] = useState<bigint | null>(null);
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [isAmountDirty, setIsAmountDirty] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [sponsor, setSponsor] = useState<SponsorView | null>(null);
  const [consentPub, setConsentPub] = useState<string>("");
  const [enrolledKey, setEnrolledKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [discoveryModalOpen, setDiscoveryModalOpen] = useState<boolean>(false);

  const reload = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    try {
      const [s, a] = await Promise.all([readStream(id), readAvailable(id)]);
      setStream(s);
      setAvailable(a);
      fetchAssetMeta(s.token).then((meta) => setAssetMeta(meta));
      setSnapshot({
        deposit: BigInt(s.deposit),
        startTime: s.startTime,
        endTime: s.endTime,
        withdrawn: BigInt(s.withdrawn),
        status: s.status,
      });

      // Auto-prefill the input with accrued balance on initial load if not modified by user
      if (!isAmountDirty && a !== null && a > 0n) {
        setAmount(a.toString());
      }
      setLoadError("");
    } catch (e) {
      const msg = describeError(e);
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setRefreshing(false);
    }
  }, [id, isAmountDirty, toast]);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
    const t = setInterval(() => void reload(), 15_000); // live accrual poll
    return () => clearInterval(t);
  }, [reload]);

  // Cosmetic linear interpolation: updates the displayed counter every 1s for visual smoothness.
  // CRITICAL NOTE: displayAvailable and this 1-second interpolator are purely cosmetic.
  // Submission decisions and client-side guards are strictly validated against the canonical
  // on-chain `available` value. A client-side guard can only ever prevent, never guarantee,
  // a successful on-chain claim (e.g. near end_time or right after a concurrent cancel).
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
    setSubmitting(true);
    try {
      if (max) {
        const paid = await withdrawMaxFromStream(address, stream!.id);
        const paidStr = assetMeta
          ? `${formatAmount(paid, assetMeta.decimals)} ${assetMeta.code}`
          : `${paid} units`;
        toast.success(`Claimed ${paidStr}.`);
        setAmount("");
        setIsAmountDirty(false);
      } else {
        if (!validation.valid) {
          const availStr =
            available !== null && assetMeta
              ? `${formatAmount(available, assetMeta.decimals)} ${assetMeta.code}`
              : `${available?.toString()} units`;
          toast.error(
            validation.error ||
              `Amount exceeds the accrued balance (${availStr}). Try “Withdraw max”.`
          );
          return;
        }
        await withdrawFromStream(address, stream!.id, validation.amount.toString());
        const withdrewStr = assetMeta
          ? `${formatAmount(validation.amount, assetMeta.decimals)} ${assetMeta.code}`
          : `${validation.amount} units`;
        toast.success(`Successfully withdrew ${withdrewStr}.`);
        setAmount("");
        setIsAmountDirty(false);
      }
      await reload();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function doEnableSponsorship() {
    if (!address || consentPub === "") return;
    setError("");
    setStatus("");
    setBusy(true);
    try {
      await enrollBeneficiary(address, consentPub);
      setStatus("Consent key enrolled — you can now claim without paying gas.");
      await loadSponsorship(address);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Sponsored claim: sign the intent locally, hand it to the sponsor's
   * relayer, and let the operator pay the transaction fee.
   */
  async function doClaimForFree() {
    if (!address || !sponsor) return;
    const claimAmount =
      amount !== "" ? BigInt(amount) : (displayAvailable ?? available ?? 0n);
    if (claimAmount <= 0n) {
      setError("Nothing has accrued yet.");
      return;
    }
    setError("");
    setStatus("");
    setBusy(true);
    try {
      const intent: ClaimIntent = {
        contractId: STREAMING_CONTRACT_ID,
        sponsor: SPONSOR_ADDRESS,
        beneficiary: address,
        token: stream!.token,
        streamId: stream!.id,
        amount: claimAmount.toString(),
        nonce: nextNonce(`${SPONSOR_ADDRESS}:${address}`).toString(),
        deadline: intentDeadline(),
      };
      const beneficiarySig = await signClaim(
        loadOrCreateConsentKey(),
        intent
      );
      const res = await requestSponsoredClaim(RELAY_URL, {
        intent,
        beneficiarySig,
      });
      setStatus(
        `Claimed ${claimAmount.toString()} units — gas paid by the sponsor. tx ${res.txHash}`
      );
      setAmount("");
      await Promise.all([reload(), loadSponsorship(address)]);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function doCancel() {
    if (!address) return;
    setSubmitting(true);
    try {
      await cancelStream(address, stream!.id);
      toast.success("Stream cancelled.");
      await reload();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const handlePrefillMax = () => {
    if (available !== null && available > 0n) {
      setAmount(available.toString());
      setIsAmountDirty(true);
    }
  };

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