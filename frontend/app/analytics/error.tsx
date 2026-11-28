"use client";

import RouteError, { type RouteErrorBoundaryProps } from "@/components/RouteError";

export default function AnalyticsError(props: RouteErrorBoundaryProps) {
  return <RouteError {...props} segment="analytics" />;
}
