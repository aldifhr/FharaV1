"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * False during SSR and the first hydration pass, true afterwards. Gate
 * client-only data (a Convex query that can already resolve on the first
 * client render) behind it so the hydration markup matches the server's.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
