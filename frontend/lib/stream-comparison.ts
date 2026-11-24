/**
 * Stream Comparison & Benchmarking Workbench (#605).
 *
 * Provides client-side simulation, side-by-side accrual comparison,
 * exhaustion forecasting, and deterministic shareable benchmark URLs
 * without requiring chain transactions.
 */

export interface HypotheticalStreamParams {
  id?: string;
  name: string;
  depositAmount: number;
  ratePerSecond: number;
  startTimeEpochSec: number;
  durationSeconds?: number;
  tokenSymbol?: string;
}

export interface AccrualDataPoint {
  timeSec: number;
  accruedAmount: number;
  remainingAmount: number;
  percentAccrued: number;
}

export interface StreamComparisonMetrics {
  id: string;
  name: string;
  depositAmount: number;
  ratePerSecond: number;
  startTimeEpochSec: number;
  endTimeEpochSec: number;
  totalDurationSeconds: number;
  tokenSymbol: string;
  curve: AccrualDataPoint[];
  exhaustionDate: Date;
  estimatedProtocolFee: number;
  estimatedNetworkFeeStroops: number;
}

export const PROTOCOL_FEE_BPS = 25; // 0.25% protocol fee
export const STELLAR_BASE_FEE_STROOPS = 100;

/**
 * Simulates a stream's linear or segmented accrual curve entirely client-side.
 */
export function simulateStreamAccrual(
  params: HypotheticalStreamParams,
  pointsCount = 10
): StreamComparisonMetrics {
  const deposit = Number(params.depositAmount) || 0;
  const rate = Number(params.ratePerSecond) || 0;
  const start = Number(params.startTimeEpochSec) || Math.floor(Date.now() / 1000);

  const duration =
    params.durationSeconds && params.durationSeconds > 0
      ? params.durationSeconds
      : rate > 0
      ? Math.ceil(deposit / rate)
      : 86400;

  const end = start + duration;
  const token = params.tokenSymbol || "XLM";

  const curve: AccrualDataPoint[] = [];
  const step = Math.max(1, Math.floor(duration / (pointsCount - 1)));

  for (let i = 0; i < pointsCount; i++) {
    const elapsed = Math.min(i * step, duration);
    const timeSec = start + elapsed;
    const accrued = rate > 0 ? Math.min(deposit, elapsed * rate) : 0;
    const remaining = Math.max(0, deposit - accrued);
    const percent = deposit > 0 ? (accrued / deposit) * 100 : 0;

    curve.push({
      timeSec,
      accruedAmount: Number(accrued.toFixed(7)),
      remainingAmount: Number(remaining.toFixed(7)),
      percentAccrued: Number(percent.toFixed(2)),
    });
  }

  const protocolFee = (deposit * PROTOCOL_FEE_BPS) / 10000;

  return {
    id: params.id || `stream-${Math.random().toString(36).substring(2, 9)}`,
    name: params.name || "Hypothetical Stream",
    depositAmount: deposit,
    ratePerSecond: rate,
    startTimeEpochSec: start,
    endTimeEpochSec: end,
    totalDurationSeconds: duration,
    tokenSymbol: token,
    curve,
    exhaustionDate: new Date(end * 1000),
    estimatedProtocolFee: Number(protocolFee.toFixed(7)),
    estimatedNetworkFeeStroops: STELLAR_BASE_FEE_STROOPS,
  };
}

/**
 * Compares multiple hypothetical or existing streams side-by-side.
 */
export function compareStreams(
  streams: HypotheticalStreamParams[]
): StreamComparisonMetrics[] {
  return streams.map((s) => simulateStreamAccrual(s));
}

/**
 * Serializes comparison parameter sets into a shareable URL parameter string.
 */
export function serializeComparisonToUrl(streams: HypotheticalStreamParams[]): string {
  const payload = streams.map((s) => ({
    n: s.name,
    d: s.depositAmount,
    r: s.ratePerSecond,
    t: s.startTimeEpochSec,
    s: s.durationSeconds,
    k: s.tokenSymbol,
  }));
  const json = JSON.stringify(payload);
  const utf8Base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(json, "utf-8").toString("base64")
      : btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));
  return encodeURIComponent(utf8Base64);
}

/**
 * Deserializes comparison parameter sets from a shareable URL parameter string.
 */
export function parseComparisonFromUrl(encoded: string): HypotheticalStreamParams[] {
  try {
    const raw = decodeURIComponent(encoded);
    const json =
      typeof Buffer !== "undefined"
        ? Buffer.from(raw, "base64").toString("utf-8")
        : decodeURIComponent(
            Array.prototype.map
              .call(atob(raw), (c: string) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
              .join("")
          );
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return (parsed as Record<string, unknown>[]).map((item) => ({
      name: String(item.n || "Benchmark"),
      depositAmount: Number(item.d) || 0,
      ratePerSecond: Number(item.r) || 0,
      startTimeEpochSec: Number(item.t) || Math.floor(Date.now() / 1000),
      durationSeconds: item.s ? Number(item.s) : undefined,
      tokenSymbol: item.k ? String(item.k) : "XLM",
    }));
  } catch {
    return [];
  }
}
