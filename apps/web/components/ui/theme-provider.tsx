"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/** The theme actually applied to the page. */
export type Theme = "light" | "dark";
/** What the user picked: a fixed theme, or follow the device (prefers-color-scheme). */
export type ThemePreference = Theme | "system";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
  } catch {
    /* storage denied */
  }
  // Nothing saved: follow the device, as the inline script in app/layout.tsx does.
  return "system";
}

function applyToDocument(theme: Theme) {
  const root = document.documentElement;
  root.style.colorScheme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.setAttribute("data-theme", theme);
}

type ThemeContextValue = {
  theme: Theme;
  preference: ThemePreference;
  toggle: () => void;
  setTheme: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  preference: "system",
  toggle: () => {},
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [theme, setThemeState] = useState<Theme>("light");

  // Mirror what the inline script already applied on first paint.
  useEffect(() => {
    const pref = readPreference();
    const resolved = pref === "system" ? systemTheme() : pref;
    setPreference(pref);
    setThemeState(resolved);
    applyToDocument(resolved);
  }, []);

  // "System" follows the device live: re-resolve when the OS setting flips.
  useEffect(() => {
    if (preference !== "system" || !window.matchMedia) return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      const next: Theme = mql.matches ? "dark" : "light";
      setThemeState(next);
      applyToDocument(next);
    };
    onChange();
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [preference]);

  const setTheme = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage denied — theme still applies for this session */
    }
    const resolved = next === "system" ? systemTheme() : next;
    setPreference(next);
    setThemeState(resolved);
    applyToDocument(resolved);
  }, []);

  // The quick toggle flips the visible theme and pins it (leaves "System").
  const toggle = useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [setTheme, theme]);

  return <ThemeContext.Provider value={{ theme, preference, toggle, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
