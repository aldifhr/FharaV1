"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Moon, PanelLeftClose, PanelLeftOpen, Search, Settings, Share2, Sun } from "lucide-react";
import { formatChord, matchesChord, useKeybindings } from "@/lib/keybindings";
import { useTheme } from "../ui/use-theme";
import { ICON_STROKE, RailItem } from "./SidebarNav";

/**
 * App-wide chords that used to live on the icon rail: the command menu
 * (⌘K) and Settings. Both are rebindable in Settings → Keybindings.
 */
export function useShellChords(onCommand: () => void, onSettings: () => void): string {
  const bindings = useKeybindings();
  // "⌘K" on Mac, "Ctrl K" elsewhere; resolved after mount so SSR markup matches.
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
    setIsMac(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (matchesChord(event, bindings.commandMenu)) {
        event.preventDefault();
        onCommand();
      } else if (matchesChord(event, bindings.openSettings)) {
        event.preventDefault();
        onSettings();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bindings, onCommand, onSettings]);
  return formatChord(bindings.commandMenu, isMac);
}

const iconBtn =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-field text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30";

function Logo({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      onClick={onNavigate}
      aria-label="Fhara home"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-field bg-ink text-canvas outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
    >
      <Share2 size={15} strokeWidth={2} />
    </Link>
  );
}

/** Top of the sidebar: logo and name, then the collapse button (desktop only). */
export function SidebarHeader({
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        <Logo onNavigate={onNavigate} />
        {onToggleCollapsed && <RailItem icon={PanelLeftOpen} label="Expand sidebar" onClick={onToggleCollapsed} />}
      </div>
    );
  }
  return (
    <div className="flex h-9 items-center gap-2.5 px-1">
      <Logo onNavigate={onNavigate} />
      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-ink">Fhara</span>
      {onToggleCollapsed && (
        <button type="button" onClick={onToggleCollapsed} aria-label="Collapse sidebar" title="Collapse sidebar" className={`${iconBtn} max-[979px]:hidden`}>
          <PanelLeftClose size={16} strokeWidth={ICON_STROKE} />
        </button>
      )}
    </div>
  );
}

/** The search box: opens the command menu, with its chord as the hint. */
export function SearchBox({ chord, onOpen, rail = false }: { chord: string; onOpen: () => void; rail?: boolean }) {
  if (rail) return <RailItem icon={Search} label={`Search (${chord})`} onClick={onOpen} />;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Search projects, tasks and agents (${chord})`}
      className="flex h-9 w-full items-center gap-2 rounded-field border border-line bg-inset px-2.5 text-left text-[14px] text-ink-3 outline-none transition hover:border-line-strong hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      <Search size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">Search</span>
      <kbd className="rounded border border-line bg-panel px-1.5 py-px font-sans text-[10.5px] text-ink-3">{chord}</kbd>
    </button>
  );
}

/**
 * Bottom row: the local account (Fhara has no login; connected accounts live
 * in Settings → Account), theme and Settings.
 */
export function AccountRow({ rail, onSettings, onAccount }: { rail: boolean; onSettings: () => void; onAccount: () => void }) {
  const { theme, toggleTheme } = useTheme();
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const themeLabel = theme === "dark" ? "Light mode" : "Dark mode";
  if (rail) {
    return (
      <div className="flex flex-col items-center gap-1">
        <RailItem icon={ThemeIcon} label={themeLabel} onClick={toggleTheme} />
        <RailItem icon={Settings} label="Settings" onClick={onSettings} />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 rounded-card border border-line bg-panel p-1">
      <button
        type="button"
        onClick={onAccount}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-field px-1.5 py-1 text-left outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset text-[11px] font-semibold text-ink-2">
          F
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">Local workspace</span>
          <span className="block truncate text-[11.5px] text-ink-3">Accounts and sign-in</span>
        </span>
      </button>
      <button type="button" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel} className={iconBtn}>
        <ThemeIcon size={15} strokeWidth={ICON_STROKE} />
      </button>
      <button type="button" onClick={onSettings} aria-label="Settings" title="Settings" className={iconBtn}>
        <Settings size={15} strokeWidth={ICON_STROKE} />
      </button>
    </div>
  );
}
