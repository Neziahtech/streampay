"use client";

import RouteError, { type RouteErrorBoundaryProps } from "@/components/RouteError";

export default function ListingsError(props: RouteErrorBoundaryProps) {
  return <RouteError {...props} segment="listings" />;
}
