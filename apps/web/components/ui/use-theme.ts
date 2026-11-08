"use client";

import { useTheme as useCtx } from "./theme-provider";

export type Theme = "light" | "dark";

export function useTheme() {
  const { theme, toggle, setTheme } = useCtx();
  const isDark = theme === "dark";
  return {
    theme: (isDark ? "dark" : "light") as Theme,
    setTheme,
    toggleTheme: toggle,
  };
}
