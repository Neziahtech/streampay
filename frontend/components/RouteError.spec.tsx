// @vitest-environment jsdom

import { act, Component, type ComponentPropsWithoutRef, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AddressError from "@/app/address/[addr]/error";
import AnalyticsError from "@/app/analytics/error";
import ListingsError from "@/app/listings/error";
import SimulatorError from "@/app/simulator/error";
import StreamError from "@/app/stream/[id]/error";
import GovernanceError from "@/app/governance/error";
import type { RouteErrorBoundaryProps, RouteErrorSegment } from "./RouteError";

const telemetry = vi.hoisted(() => ({
  startSpan: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@/lib/telemetry", () => ({
  globalFrontendTracer: { startSpan: telemetry.startSpan },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: ComponentPropsWithoutRef<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ThrowingChild(): never {
  throw new Error("route render failed");
}

function makeHarness(Fallback: ComponentType<RouteErrorBoundaryProps>) {
  let shouldThrow = true;
  const reset = vi.fn(() => {
    shouldThrow = false;
  });

  class RecoveryBoundary extends Component<Record<string, never>, { error: Error | null }> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: unknown) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    resetBoundary = () => {
      reset();
      this.setState({ error: null });
    };

    render() {
      if (this.state.error) {
        return <Fallback error={this.state.error} reset={this.resetBoundary} />;
      }
      return shouldThrow ? <ThrowingChild /> : <span>Page recovered</span>;
    }
  }

  return { RecoveryBoundary, reset };
}

const boundaries: Array<{
  segment: RouteErrorSegment;
  label: string;
  Fallback: ComponentType<RouteErrorBoundaryProps>;
}> = [
  { segment: "stream", label: "stream details", Fallback: StreamError },
  { segment: "address", label: "address explorer", Fallback: AddressError },
  { segment: "analytics", label: "analytics", Fallback: AnalyticsError },
  { segment: "listings", label: "stream listings", Fallback: ListingsError },
  { segment: "simulator", label: "accrual simulator", Fallback: SimulatorError },
  { segment: "governance", label: "governance console", Fallback: GovernanceError },
];

describe("route error boundaries", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    telemetry.startSpan.mockReset();
    telemetry.recordException.mockReset();
    telemetry.end.mockReset();
    telemetry.startSpan.mockReturnValue({
      recordException: telemetry.recordException,
      end: telemetry.end,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    container.remove();
    vi.restoreAllMocks();
  });

  it.each(boundaries)(
    "$segment boundary renders recovery UI and re-renders after reset",
    async ({ segment, label, Fallback }) => {
      const { RecoveryBoundary, reset } = makeHarness(Fallback);

      await act(async () => {
        root?.render(<RecoveryBoundary />);
      });

      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.textContent).toContain("We couldn't load this page");
      expect(container.textContent).toContain(label);
      expect(container.querySelector('a[href="/"]')?.textContent).toContain(
        "Back to StreamPay",
      );
      expect(telemetry.startSpan).toHaveBeenCalledTimes(1);
      expect(telemetry.startSpan.mock.calls[0]?.[1].attributes).toMatchObject({
        "route.segment": segment,
        "error.name": "Error",
        "error.message": "route render failed",
      });
      expect(telemetry.recordException).toHaveBeenCalledWith(expect.any(Error));
      expect(telemetry.end).toHaveBeenCalledTimes(1);

      const retry = container.querySelector("button");
      expect(retry?.textContent).toContain("Try again");
      await act(async () => retry?.click());

      expect(reset).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Page recovered");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );
});
