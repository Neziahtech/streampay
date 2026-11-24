/**
 * Consent-Gated Real-User Monitoring (RUM) and Core Web Vitals (#604).
 *
 * Collects route-level Core Web Vitals (LCP, INP, CLS) from actual browser sessions
 * and beacons them to an ingest endpoint only after explicit telemetry consent.
 *
 * Privacy Invariants:
 * - Default off: strictly disabled until user opts in via consent settings.
 * - Zero PII: no Stellar addresses, secret keys, transaction amounts, or user IDs.
 * - Kill-switch: remote kill-switch can disable collection globally.
 * - Route-level performance budgets: evaluate field measurements against lab thresholds.
 */

import { loadRumConsent } from "./storage.ts";
import { sanitizeAttributes } from "./privacy.ts";

export interface CoreWebVitals {
  lcpMs?: number; // Largest Contentful Paint (ms)
  inpMs?: number; // Interaction to Next Paint (ms)
  clsScore?: number; // Cumulative Layout Shift (score)
  ttfbMs?: number; // Time to First Byte (ms)
  fcpMs?: number; // First Contentful Paint (ms)
}

export interface RoutePerformancePayload {
  route: string;
  timestamp: number;
  vitals: CoreWebVitals;
  deviceClass: "desktop" | "mobile" | "tablet";
  connectionType?: string;
  sampleRate: number;
}

export interface RouteBudget {
  maxLcpMs: number;
  maxInpMs: number;
  maxClsScore: number;
}

/** Standard Core Web Vitals thresholds (Good / Needs Improvement / Poor). */
export const DEFAULT_ROUTE_BUDGETS: Record<string, RouteBudget> = {
  "/": { maxLcpMs: 2500, maxInpMs: 200, maxClsScore: 0.1 },
  "/streams": { maxLcpMs: 2500, maxInpMs: 200, maxClsScore: 0.1 },
  "/streams/[id]": { maxLcpMs: 3000, maxInpMs: 200, maxClsScore: 0.1 },
  "/workbench": { maxLcpMs: 3000, maxInpMs: 250, maxClsScore: 0.15 },
};

export class RumCollector {
  private killSwitchActive = false;
  private sampleRate = 1.0;
  private beaconUrl: string;
  private queue: RoutePerformancePayload[] = [];
  private maxQueueSize = 50;

  constructor(beaconUrl = "/api/telemetry/rum", sampleRate = 1.0) {
    this.beaconUrl = beaconUrl;
    this.sampleRate = Math.max(0, Math.min(1, sampleRate));
  }

  public setKillSwitch(active: boolean): void {
    this.killSwitchActive = active;
    if (active) this.queue = [];
  }

  public isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  public shouldSample(): boolean {
    return Math.random() < this.sampleRate;
  }

  /**
   * Sanitizes route path and ensures no sensitive data or blockchain keys are included.
   */
  public sanitizeRoute(rawRoute: string): string {
    // Redact G..., C..., or B... addresses and hashes from route path
    return rawRoute
      .split("?")[0]
      .replace(/[GCB][A-Za-z0-9]{30,}/g, ":address")
      .replace(/[a-f0-9]{32,64}/gi, ":hash");
  }

  /**
   * Records a route performance measurement if telemetry consent is granted.
   */
  public recordRouteVitals(
    route: string,
    vitals: CoreWebVitals,
    deviceClass: "desktop" | "mobile" | "tablet" = "desktop"
  ): boolean {
    // 1. Consent Gate: strictly default-off
    if (!loadRumConsent()) {
      return false;
    }

    // 2. Kill switch check
    if (this.killSwitchActive) {
      return false;
    }

    // 3. Sampling check
    if (!this.shouldSample()) {
      return false;
    }

    const sanitizedRoute = this.sanitizeRoute(route);
    const sanitizedVitals: CoreWebVitals = {
      lcpMs: vitals.lcpMs !== undefined ? Math.round(vitals.lcpMs) : undefined,
      inpMs: vitals.inpMs !== undefined ? Math.round(vitals.inpMs) : undefined,
      clsScore: vitals.clsScore !== undefined ? Number(vitals.clsScore.toFixed(3)) : undefined,
      ttfbMs: vitals.ttfbMs !== undefined ? Math.round(vitals.ttfbMs) : undefined,
      fcpMs: vitals.fcpMs !== undefined ? Math.round(vitals.fcpMs) : undefined,
    };

    const payload: RoutePerformancePayload = {
      route: sanitizedRoute,
      timestamp: Date.now(),
      vitals: sanitizedVitals,
      deviceClass,
      sampleRate: this.sampleRate,
    };

    this.queue.push(payload);
    if (this.queue.length > this.maxQueueSize) {
      this.queue.shift();
    }

    return true;
  }

  /**
   * Beacons queued RUM metrics to ingest endpoint.
   */
  public async flush(): Promise<boolean> {
    if (this.queue.length === 0 || !loadRumConsent() || this.killSwitchActive) {
      return false;
    }

    const batch = this.queue.map((item) => ({
      ...item,
      attributes: sanitizeAttributes({
        route: item.route,
        deviceClass: item.deviceClass,
        timestamp: item.timestamp,
        sampleRate: item.sampleRate,
        ...item.vitals,
      }),
    }));
    this.queue = [];

    if (typeof fetch === "undefined") {
      return false;
    }

    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const blob = new Blob([JSON.stringify({ batch })], { type: "application/json" });
        return navigator.sendBeacon(this.beaconUrl, blob);
      } else {
        const res = await fetch(this.beaconUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch }),
          keepalive: true,
        });
        return res.ok;
      }
    } catch {
      return false;
    }
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}

/**
 * Validates measured Core Web Vitals against route budgets.
 * Used in CI performance gates to fail on regression.
 */
export function evaluateVitalsBudget(
  route: string,
  vitals: CoreWebVitals,
  customBudgets?: Record<string, RouteBudget>
): { passed: boolean; violations: string[] } {
  const budgets = { ...DEFAULT_ROUTE_BUDGETS, ...customBudgets };
  const budget = budgets[route] ?? DEFAULT_ROUTE_BUDGETS["/"];
  const violations: string[] = [];

  if (vitals.lcpMs !== undefined && vitals.lcpMs > budget.maxLcpMs) {
    violations.push(`LCP ${vitals.lcpMs}ms exceeds budget ${budget.maxLcpMs}ms for route ${route}`);
  }
  if (vitals.inpMs !== undefined && vitals.inpMs > budget.maxInpMs) {
    violations.push(`INP ${vitals.inpMs}ms exceeds budget ${budget.maxInpMs}ms for route ${route}`);
  }
  if (vitals.clsScore !== undefined && vitals.clsScore > budget.maxClsScore) {
    violations.push(`CLS ${vitals.clsScore} exceeds budget ${budget.maxClsScore} for route ${route}`);
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

export const globalRumCollector = new RumCollector();
