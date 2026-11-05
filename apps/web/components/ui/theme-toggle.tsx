"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("moagent-theme", next ? "dark" : "light");
    } catch {
      /* ignore storage failures */
    }
    setDark(next);
  }

  return (
    <button
      type="button"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggle}
      className="flex h-10 w-10 items-center justify-center rounded-xl text-white/65 transition hover:bg-white/15 hover:text-white"
    >
      {dark ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  );
}
