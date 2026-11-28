"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { globalFrontendTracer } from "@/lib/telemetry";

export type RouteErrorSegment =
  | "stream"
  | "address"
  | "analytics"
  | "listings"
  | "simulator"
  | "governance";

export interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  segment: RouteErrorSegment;
}

export type RouteErrorBoundaryProps = Omit<RouteErrorProps, "segment">;

const SEGMENT_LABELS: Record<RouteErrorSegment, string> = {
  stream: "stream details",
  address: "address explorer",
  analytics: "analytics",
  listings: "stream listings",
  simulator: "accrual simulator",
  governance: "governance console",
};

export default function RouteError({ error, reset, segment }: RouteErrorProps) {
  const reportedError = useRef<Error | null>(null);

  useEffect(() => {
    if (reportedError.current === error) return;
    reportedError.current = error;

    const span = globalFrontendTracer.startSpan("frontend.route_error", {
      attributes: {
        "route.segment": segment,
        "error.name": error.name,
        "error.message": error.message,
      },
    });
    span.recordException(error);
    span.end();
  }, [error, segment]);

  return (
    <main className="wrap">
      <section className="card" role="alert" aria-labelledby="route-error-title">
        <h1 id="route-error-title">We couldn&apos;t load this page</h1>
        <p className="err">
          The {SEGMENT_LABELS[segment]} hit an unexpected error and could not
          finish loading.
        </p>
        <p className="muted">
          Try again to reload this section. If the problem continues, return to
          the StreamPay dashboard.
        </p>
        <div className="row">
          <button type="button" onClick={reset}>
            Try again
          </button>
          <Link href="/" className="page-btn">
            Back to StreamPay
          </Link>
        </div>
      </section>
    </main>
  );
}
