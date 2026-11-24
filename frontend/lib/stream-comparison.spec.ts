import { describe, expect, it } from "vitest";
import {
  simulateStreamAccrual,
  compareStreams,
  serializeComparisonToUrl,
  parseComparisonFromUrl,
  HypotheticalStreamParams,
} from "./stream-comparison";

describe("Stream Comparison & Benchmarking Workbench (#605)", () => {
  const streamA: HypotheticalStreamParams = {
    name: "Linear Salary",
    depositAmount: 1000,
    ratePerSecond: 1, // runs for 1000 seconds
    startTimeEpochSec: 1700000000,
    tokenSymbol: "USDC",
  };

  const streamB: HypotheticalStreamParams = {
    name: "Micro Vesting",
    depositAmount: 2000,
    ratePerSecond: 0.5, // runs for 4000 seconds
    startTimeEpochSec: 1700000000,
    tokenSymbol: "USDC",
  };

  describe("client-side accrual simulation", () => {
    it("computes accurate linear curve, exhaustion date, and fees without chain writes", () => {
      const metrics = simulateStreamAccrual(streamA, 5);

      expect(metrics.name).toBe("Linear Salary");
      expect(metrics.totalDurationSeconds).toBe(1000);
      expect(metrics.exhaustionDate.getTime()).toBe(1700001000 * 1000);
      expect(metrics.estimatedProtocolFee).toBe(2.5); // 0.25% of 1000
      expect(metrics.curve).toHaveLength(5);
      expect(metrics.curve[0].accruedAmount).toBe(0);
      expect(metrics.curve[0].percentAccrued).toBe(0);
      expect(metrics.curve[4].accruedAmount).toBe(1000);
      expect(metrics.curve[4].percentAccrued).toBe(100);
    });

    it("compares multiple streams side-by-side", () => {
      const results = compareStreams([streamA, streamB]);

      expect(results).toHaveLength(2);
      expect(results[0].depositAmount).toBe(1000);
      expect(results[1].depositAmount).toBe(2000);
      expect(results[1].totalDurationSeconds).toBe(4000);
    });
  });

  describe("shareable benchmark URL round-trip", () => {
    it("encodes and restores parameter sets deterministically", () => {
      const encoded = serializeComparisonToUrl([streamA, streamB]);
      expect(typeof encoded).toBe("string");
      expect(encoded.length).toBeGreaterThan(0);

      const restored = parseComparisonFromUrl(encoded);
      expect(restored).toHaveLength(2);
      expect(restored[0].name).toBe("Linear Salary");
      expect(restored[0].depositAmount).toBe(1000);
      expect(restored[0].ratePerSecond).toBe(1);
      expect(restored[1].name).toBe("Micro Vesting");
      expect(restored[1].depositAmount).toBe(2000);
      expect(restored[1].ratePerSecond).toBe(0.5);
    });

    it("handles corrupted or empty URL strings gracefully", () => {
      expect(parseComparisonFromUrl("invalid-base64")).toEqual([]);
      expect(parseComparisonFromUrl("")).toEqual([]);
    });
  });
});
