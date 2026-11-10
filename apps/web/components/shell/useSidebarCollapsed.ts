"use client";

import { useEffect, useState } from "react";

const KEY = "fhara-sidebar-collapsed";

/** Desktop sidebar hidden/shown, remembered on this device. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(KEY) === "1");
    } catch {
      /* storage denied */
    }
  }, []);
  const toggle = () =>
    setCollapsed((current) => {
      try {
        localStorage.setItem(KEY, current ? "0" : "1");
      } catch {
        /* storage denied */
      }
      return !current;
    });
  return [collapsed, toggle];
}
