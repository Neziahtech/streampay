//! Core reconciliation engine that compares Horizon and Soroban stream states
//! and detects divergences outside the consistency lag window.
//!
//! The merkleized audit (`src/audit/`) is the authoritative continuous
//! checker; this engine remains the per-stream dual read that explains *which*
//! field of a record a root divergence came from.

import type {
  AlertingConfig,
  StreamState,
  DivergenceRecord,
  DivergenceClassification,
  ReconciliationResult,
} from "../types.js";

/** The part of the alerting service this engine depends on. */
export interface AlertTransport {
  log(level: AlertingConfig["logLevel"], message: string, details?: Record<string, unknown>): void;
  dispatchWebhook(divergence: DivergenceRecord): Promise<unknown>;
  beginPass?(): void;
  endPass?(): string[];
  recordRounding?(divergence: DivergenceRecord): void;
}

/**
 * Accrual Floor Tolerance Derivation:
 *
 * Soroban's `streamed_at` uses integer floor division. The truncation
 * remainder is strictly less than one base unit, so a single rate segment can
 * accumulate less than one stroop of floor dust. Differences at or below the
 * configured epsilon are recorded as rounding rather than paged as conservation
 * violations. Decimal token values are converted to base units before the
 * comparison.
 */
export function parseAmountToBaseUnits(amountStr: string, decimals: number = 7): bigint {
  const trimmed = String(amountStr).trim();
  if (trimmed.includes(".")) {
    const [wholePart, fracPart = ""] = trimmed.split(".");
    const negative = wholePart.startsWith("-");
    const absWhole = negative ? wholePart.slice(1) : wholePart;
    const paddedFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
    const baseVal = BigInt(absWhole || "0") * (10n ** BigInt(decimals)) + BigInt(paddedFrac || "0");
    return negative ? -baseVal : baseVal;
  }
  return BigInt(trimmed || "0");
}

export function computeAmountDiff(hStr: string, sStr: string, decimals: number = 7): bigint {
  const hTrim = String(hStr).trim();
  const sTrim = String(sStr).trim();
  const isDecimal = hTrim.includes(".") || sTrim.includes(".");

  if (isDecimal) {
    const hBase = parseAmountToBaseUnits(hTrim, decimals);
    const sBase = parseAmountToBaseUnits(sTrim, decimals);
    return hBase > sBase ? hBase - sBase : sBase - hBase;
  }

  const hInt = BigInt(hTrim || "0");
  const sInt = BigInt(sTrim || "0");
  return hInt > sInt ? hInt - sInt : sInt - hInt;
}

export function calculateAccrualFloorEpsilon(
  _decimals: number = 7,
  multiplier: number = 1
): bigint {
  return BigInt(Math.max(1, Math.floor(multiplier)));
}

export interface ReconciliationEngineConfig {
  consistencyWindowMs: number;
  alertOnLagThreshold?: number;
  alertingService: AlertTransport;
  defaultDecimals?: number;
  toleranceMultiplier?: number;
  /**
   * Optional de-duplication gate for divergence alerts. Given the keys
   * diverging this cycle it returns the ones worth paging on; omit it to
   * dispatch every critical divergence, as before.
   */
  alertGate?: (faultingKeys: string[], atMs: number) => string[];
}

interface ReaderLike {
  pollStreams(ids: string[]): Promise<StreamState[]>;
  healthCheck(): Promise<{ healthy: boolean; error?: string }>;
}

export class ReconciliationEngine {
  private readonly config: ReconciliationEngineConfig;
  private readonly alerting: AlertTransport;

  constructor(config: ReconciliationEngineConfig) {
    this.config = config;
    this.alerting = config.alertingService;
  }

  /** Reconciles two sets of stream states and detects divergences. */
  async reconcile(
    horizonStates: StreamState[],
    sorobanStates: StreamState[],
    atMs: number = Date.now()
  ): Promise<ReconciliationResult> {
    const startedAt = Date.now();

    const horizonMap = new Map(horizonStates.map((state) => [state.streamId, state]));
    const sorobanMap = new Map(sorobanStates.map((state) => [state.streamId, state]));
    const allStreamIds = new Set([
      ...horizonStates.map((state) => state.streamId),
      ...sorobanStates.map((state) => state.streamId),
    ]);

    const divergences: DivergenceRecord[] = [];
    let inSyncCount = 0;
    let withinLagCount = 0;
    let roundingCount = 0;
    let realDivergenceCount = 0;

    for (const streamId of allStreamIds) {
      const horizonState = horizonMap.get(streamId);
      const sorobanState = sorobanMap.get(streamId);

      if (horizonState !== undefined && sorobanState !== undefined) {
        const result = this.compareStates(horizonState, sorobanState);
        if (result === null) {
          inSyncCount += 1;
        } else if (result === "lag") {
          withinLagCount += 1;
        } else {
          if (result.classification === "rounding_within_epsilon") {
            roundingCount += 1;
          } else {
            realDivergenceCount += 1;
          }
          divergences.push(result);
        }
      } else if (horizonState !== undefined) {
        realDivergenceCount += 1;
        divergences.push(
          this.createDivergenceRecord(
            streamId,
            "missing_record",
            "critical",
            "missing_record",
            { streamId: horizonState.streamId, ledger: horizonState.ledger },
            { streamId: "N/A", ledger: 0 },
            horizonState.ledger,
            0
          )
        );
      } else if (sorobanState !== undefined) {
        realDivergenceCount += 1;
        divergences.push(
          this.createDivergenceRecord(
            streamId,
            "missing_record",
            "warning",
            "missing_record",
            { streamId: "N/A", ledger: 0 },
            { streamId: sorobanState.streamId, ledger: sorobanState.ledger },
            0,
            sorobanState.ledger
          )
        );
      }
    }

    const ledgerGap = this.calculateLedgerGap(horizonStates, sorobanStates);
    const critical = divergences.filter(
      (divergence) =>
        divergence.severity === "critical" &&
        divergence.classification !== "rounding_within_epsilon"
    );
    const dispatchable =
      this.config.alertGate === undefined
        ? critical
        : (() => {
            const allowed = new Set(
              this.config.alertGate?.(critical.map((divergence) => divergence.streamId), atMs) ?? []
            );
            return critical.filter((divergence) => allowed.has(divergence.streamId));
          })();

    // One reconciliation pass is one de-duplication pass. Keys absent this pass
    // age towards resolution, while rounding is recorded without paging.
    this.alerting.beginPass?.();
    try {
      for (const divergence of dispatchable) {
        await this.alerting.dispatchWebhook(divergence);
      }
      for (const divergence of divergences) {
        if (divergence.classification === "rounding_within_epsilon") {
          this.alerting.recordRounding?.(divergence);
        }
      }
    } finally {
      this.alerting.endPass?.();
    }

    this.alerting.log("INFO", "Reconciliation complete", {
      totalChecked: allStreamIds.size,
      inSync: inSyncCount,
      withinLagWindow: withinLagCount,
      divergences: divergences.length,
      dispatched: dispatchable.length,
      roundingWithinTolerance: roundingCount,
      realDivergences: realDivergenceCount,
      ledgerGap,
      durationMs: Date.now() - startedAt,
    });

    return {
      totalChecked: allStreamIds.size,
      inSync: inSyncCount,
      withinLagWindow: withinLagCount,
      roundingWithinTolerance: roundingCount,
      realDivergences: realDivergenceCount,
      divergences,
      timestamp: new Date(atMs).toISOString(),
      ledgerGap,
      metrics: {
        roundingCount,
        divergenceCount: realDivergenceCount,
      },
    };
  }

  /** `null` when in sync, `"lag"` inside the consistency window, else the record. */
  private compareStates(h: StreamState, s: StreamState): null | "lag" | DivergenceRecord {
    const depositMatch = h.data.deposit === s.data.deposit;
    const withdrawnMatch = h.data.withdrawn === s.data.withdrawn;
    const statusMatch = h.data.status === s.data.status;

    if (depositMatch && withdrawnMatch && statusMatch) return null;

    const timeDiffMs = Math.abs(
      new Date(h.timestamp).getTime() - new Date(s.timestamp).getTime()
    );

    if (timeDiffMs <= this.config.consistencyWindowMs) {
      this.alerting.log("WARN", `Stream ${h.streamId} shows lag-induced divergence`, {
        horizonLedger: h.ledger,
        sorobanLedger: s.ledger,
        timeDiffMs,
        consistencyWindowMs: this.config.consistencyWindowMs,
        horizonData: h.data,
        sorobanData: s.data,
      });
      return "lag";
    }

    if (!statusMatch && depositMatch && withdrawnMatch) {
      return this.createDivergenceRecord(
        h.streamId,
        "stream_status",
        "warning",
        "status_mismatch",
        { streamId: h.streamId, ledger: h.ledger, timestamp: h.timestamp, data: h.data },
        { streamId: s.streamId, ledger: s.ledger, timestamp: s.timestamp, data: s.data },
        h.ledger,
        s.ledger
      );
    }

    const decimals =
      (s.data as { decimals?: number }).decimals ??
      (h.data as { decimals?: number }).decimals ??
      this.config.defaultDecimals ??
      7;
    const multiplier = this.config.toleranceMultiplier ?? 1;
    const epsilon = calculateAccrualFloorEpsilon(decimals, multiplier);

    let maxDiff = 0n;
    try {
      const depositDiff = computeAmountDiff(h.data.deposit, s.data.deposit, decimals);
      const withdrawnDiff = computeAmountDiff(h.data.withdrawn, s.data.withdrawn, decimals);
      maxDiff = depositDiff > withdrawnDiff ? depositDiff : withdrawnDiff;
    } catch {
      maxDiff = epsilon + 1n;
    }

    const isWithinTolerance = maxDiff <= epsilon;
    const classification: DivergenceClassification = isWithinTolerance
      ? "rounding_within_epsilon"
      : "value_mismatch";
    const severity: "warning" | "critical" = isWithinTolerance ? "warning" : "critical";

    return this.createDivergenceRecord(
      h.streamId,
      "stream_balance",
      severity,
      classification,
      { streamId: h.streamId, ledger: h.ledger, timestamp: h.timestamp, data: h.data },
      { streamId: s.streamId, ledger: s.ledger, timestamp: s.timestamp, data: s.data },
      h.ledger,
      s.ledger,
      maxDiff.toString(),
      epsilon.toString()
    );
  }

  private createDivergenceRecord(
    streamId: string,
    checkType: DivergenceRecord["checkType"],
    severity: DivergenceRecord["severity"],
    classification: DivergenceClassification,
    indexedValue: Record<string, unknown>,
    onChainValue: Record<string, unknown>,
    horizonLedger: number,
    sorobanLedger: number,
    delta?: string,
    toleranceEpsilon?: string
  ): DivergenceRecord {
    const now = Date.now();
    return {
      streamId,
      checkType,
      severity,
      classification,
      indexedValue,
      onChainValue,
      horizonLagMs: horizonLedger > 0 ? now - horizonLedger * 1000 : undefined,
      sorobanLagMs: sorobanLedger > 0 ? now - sorobanLedger * 1000 : undefined,
      detectedAt: new Date(now).toISOString(),
      delta,
      toleranceEpsilon,
    };
  }

  private calculateLedgerGap(horizonStates: StreamState[], sorobanStates: StreamState[]): number {
    const latest = (states: StreamState[]): number =>
      states.length === 0 ? 0 : Math.max(...states.map((state) => state.ledger));
    return Math.abs(latest(horizonStates) - latest(sorobanStates));
  }

  /**
   * Runs reconciliation until `stop()` is called. Prefer `ContinuousAuditor`
   * for the merkleized path; this loop is retained for the per-stream read.
   */
  async startContinuousReconciliation(
    horizonReader: ReaderLike,
    sorobanReader: ReaderLike,
    streamIds: string[],
    options: {
      initialDelayMs?: number;
      healthCheckIntervalMs?: number;
      onError?: (error: unknown) => void;
      maxCycles?: number;
      shouldStop?: () => boolean;
    } = {}
  ): Promise<void> {
    const {
      initialDelayMs = 0,
      healthCheckIntervalMs = 30_000,
      onError = (error) => console.error("Reconciliation error:", error),
      maxCycles,
      shouldStop = () => false,
    } = options;

    if (initialDelayMs > 0) await sleep(initialDelayMs);

    let cycles = 0;
    const healthCheckLoop = setInterval(() => {
      void (async () => {
        try {
          const [horizonHealth, sorobanHealth] = await Promise.all([
            horizonReader.healthCheck(),
            sorobanReader.healthCheck(),
          ]);
          if (!horizonHealth.healthy || !sorobanHealth.healthy) {
            this.alerting.log("WARN", "One or more readers unhealthy", {
              horizonHealthy: horizonHealth.healthy,
              sorobanHealthy: sorobanHealth.healthy,
              horizonError: horizonHealth.error,
              sorobanError: sorobanHealth.error,
            });
          }
        } catch (error) {
          this.alerting.log("ERROR", "Health check failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, healthCheckIntervalMs);

    try {
      while (!shouldStop() && (maxCycles === undefined || cycles < maxCycles)) {
        const loopStartedAt = Date.now();
        try {
          const [horizonStates, sorobanStates] = await Promise.all([
            horizonReader.pollStreams(streamIds),
            sorobanReader.pollStreams(streamIds),
          ]);
          await this.reconcile(horizonStates, sorobanStates);
        } catch (error) {
          onError(error);
          await sleep(1_000);
        }
        cycles += 1;
        const remaining = Math.max(0, this.config.consistencyWindowMs - (Date.now() - loopStartedAt));
        if (remaining > 0 && !shouldStop()) await sleep(remaining);
      }
    } finally {
      clearInterval(healthCheckLoop);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { StreamState, DivergenceRecord, ReconciliationResult } from "../types.js";
