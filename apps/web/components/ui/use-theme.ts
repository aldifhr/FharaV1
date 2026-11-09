"use client";

import { useTheme as useCtx, type Theme } from "./theme-provider";

export function useTheme() {
  const { theme, toggle, setTheme } = useCtx();
  const isDark = theme === "dark";
  return {
    theme: (isDark ? "dark" : "light") as Theme,
    setTheme,
    toggleTheme: toggle,
  };
}
