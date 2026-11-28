"use client";

import RouteError from "@/components/RouteError";

export default function GovernanceError({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  return <RouteError error={error} reset={reset} segment="governance" />;
}
