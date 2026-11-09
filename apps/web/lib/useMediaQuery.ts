"use client";

import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query. `serverValue` is used during SSR and the
 * first hydration pass, so pick the value that matches the most common
 * layout (desktop) to avoid a visible jump there.
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue,
  );
}

/** The workspace switches to its stacked phone layout below 980px. */
export const DESKTOP_QUERY = "(min-width: 980px)";
