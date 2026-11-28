"use client";

import RouteError, { type RouteErrorBoundaryProps } from "@/components/RouteError";

export default function SimulatorError(props: RouteErrorBoundaryProps) {
  return <RouteError {...props} segment="simulator" />;
}
