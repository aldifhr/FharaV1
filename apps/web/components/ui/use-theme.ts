"use client";

import { useTheme as useCtx, type Theme, type ThemePreference } from "./theme-provider";

export function useTheme() {
  const { theme, preference, toggle, setTheme } = useCtx();
  return {
    /** The applied theme (System resolved to light or dark). */
    theme: (theme === "dark" ? "dark" : "light") as Theme,
    /** The user's pick, including "system". */
    preference: preference as ThemePreference,
    setTheme,
    toggleTheme: toggle,
  };
}
