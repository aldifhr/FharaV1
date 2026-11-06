"use client";

import { useTheme as useNextThemes } from "next-themes";

export type Theme = "light" | "dark";

export function useTheme() {
  const { theme, setTheme, resolvedTheme } = useNextThemes();
  return {
    theme: (theme ?? "light") as Theme,
    setTheme,
    toggleTheme: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
  };
}
