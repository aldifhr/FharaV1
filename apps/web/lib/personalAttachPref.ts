"use client";

import { useEffect, useState } from "react";

const KEY = "fhara-personal-attach-enabled";
const EVENT = "fhara:personal-attach-changed";

/** Device-local switch for the personal chat's "Attach project" action (default on). */
export function usePersonalAttachEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    try {
      setEnabled(localStorage.getItem(KEY) !== "0");
    } catch {
      /* storage denied */
    }
    const onChange = () => {
      try {
        setEnabled(localStorage.getItem(KEY) !== "0");
      } catch {
        /* storage denied */
      }
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  const set = (next: boolean) => {
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* storage denied */
    }
    setEnabled(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [enabled, set];
}
