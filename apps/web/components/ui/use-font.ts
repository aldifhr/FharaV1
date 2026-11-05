"use client";

import { useEffect, useState } from "react";

export type FontChoice = "geist" | "inter" | "system" | "jetbrains";

const STORAGE_KEY = "moagent-font";
const DEFAULT_FONT: FontChoice = "geist";

function applyFont(choice: FontChoice) {
  document.documentElement.setAttribute("data-font", choice);
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* ignore storage failures */
  }
}

export function useFont() {
  const [font, setFontState] = useState<FontChoice>(DEFAULT_FONT);

  useEffect(() => {
    const saved = document.documentElement.getAttribute("data-font") as FontChoice | null;
    setFontState(saved ?? DEFAULT_FONT);
  }, []);

  function setFont(next: FontChoice) {
    applyFont(next);
    setFontState(next);
  }

  return { font, setFont };
}
