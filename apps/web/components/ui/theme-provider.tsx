"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark" | "system";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const stored = (localStorage.getItem("theme") as Theme | null) ?? "light";
    setTheme(stored);
    const root = document.documentElement;
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const applied = stored === "system" ? (systemDark ? "dark" : "light") : stored;
    root.classList.toggle("dark", applied === "dark");
    root.setAttribute("data-theme", applied);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "light" ? "dark" : prev === "dark" ? "system" : "light";
      localStorage.setItem("theme", next);
      const root = document.documentElement;
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const applied = next === "system" ? (systemDark ? "dark" : "light") : next;
      root.classList.toggle("dark", applied === "dark");
      root.setAttribute("data-theme", applied);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

import { createContext, useContext } from "react";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({ theme: "light", toggle: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}
