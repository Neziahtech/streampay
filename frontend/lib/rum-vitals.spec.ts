import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateVitalsBudget,
  RumCollector,
  DEFAULT_ROUTE_BUDGETS,
} from "./rum-vitals";
import * as storage from "./storage";

describe("RUM and Core Web Vitals telemetry (#604)", () => {
  let collector: RumCollector;
  let consentValue = true;

  beforeEach(() => {
    consentValue = true;
    vi.spyOn(storage, "loadTelemetryConsent").mockImplementation(() => consentValue);
    collector = new RumCollector("/api/telemetry/rum", 1.0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("consent gating", () => {
    it("drops all measurements when telemetry consent is false (default-off)", () => {
      consentValue = false;
      const recorded = collector.recordRouteVitals("/streams", {
        lcpMs: 1200,
        inpMs: 80,
        clsScore: 0.02,
      });

      expect(recorded).toBe(false);
      expect(collector.getQueueLength()).toBe(0);
    });

    it("accepts measurements when telemetry consent is true", () => {
      consentValue = true;
      const recorded = collector.recordRouteVitals("/streams", {
        lcpMs: 1400,
        inpMs: 90,
        clsScore: 0.01,
      });

      expect(recorded).toBe(true);
      expect(collector.getQueueLength()).toBe(1);
    });
  });

  describe("privacy and route sanitization", () => {
    it("sanitizes Stellar addresses, contract IDs, and query parameters from route paths", () => {
      const dirtyRoute =
        "/streams/GDXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF?token=secret123";
      const sanitized = collector.sanitizeRoute(dirtyRoute);

      expect(sanitized).toBe("/streams/:address");
      expect(sanitized).not.toContain("GDXYZ");
      expect(sanitized).not.toContain("secret123");
    });
  });

  describe("kill switch and sampling", () => {
    it("stops collection and purges queue when kill-switch is activated", () => {
      collector.recordRouteVitals("/streams", { lcpMs: 1000 });
      expect(collector.getQueueLength()).toBe(1);

      collector.setKillSwitch(true);
      expect(collector.isKillSwitchActive()).toBe(true);
      expect(collector.getQueueLength()).toBe(0);

      const recorded = collector.recordRouteVitals("/streams", { lcpMs: 1000 });
      expect(recorded).toBe(false);
      expect(collector.getQueueLength()).toBe(0);
    });
  });

  describe("CI performance budgets", () => {
    it("passes when measurements are within budget", () => {
      const evaluation = evaluateVitalsBudget("/", {
        lcpMs: 2000, // budget is 2500
        inpMs: 150, // budget is 200
        clsScore: 0.05, // budget is 0.1
      });

      expect(evaluation.passed).toBe(true);
      expect(evaluation.violations).toHaveLength(0);
    });

    it("fails and details violations when metrics exceed thresholds", () => {
      const evaluation = evaluateVitalsBudget("/", {
        lcpMs: 3200, // exceeds 2500
        inpMs: 300, // exceeds 200
        clsScore: 0.25, // exceeds 0.1
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations).toHaveLength(3);
      expect(evaluation.violations[0]).toContain("LCP 3200ms exceeds budget");
      expect(evaluation.violations[1]).toContain("INP 300ms exceeds budget");
      expect(evaluation.violations[2]).toContain("CLS 0.25 exceeds budget");
    });
  });
});
