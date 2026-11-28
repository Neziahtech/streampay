"use client";

import RouteError, { type RouteErrorBoundaryProps } from "@/components/RouteError";

export default function StreamError(props: RouteErrorBoundaryProps) {
  return <RouteError {...props} segment="stream" />;
}
