"use client";

import RouteError, { type RouteErrorBoundaryProps } from "@/components/RouteError";

export default function AddressError(props: RouteErrorBoundaryProps) {
  return <RouteError {...props} segment="address" />;
}
