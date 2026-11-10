"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import {
  SlidersHorizontal,
  Palette,
  MessageSquare,
  GitPullRequest,
  Keyboard,
  Mic,
  Camera,
  Cpu,
  ListFilter,
  Globe,
  Laptop,
  CalendarClock,
  FolderGit2,
  GitBranch,
  GitMerge,
  Layers,
  ShieldCheck,
  Wrench,
  FlaskConical,
  Info,
  Archive,
  LogIn,
  Search,
  RotateCcw,
  X,
  ChevronDown,
  Check,
  Moon,
  Sun,
  Monitor,
} from "lucide-react";
import LlmSettingsSection from "./LlmSettings";
import { useFont, type FontChoice } from "@/components/ui/use-font";
import { useTheme } from "@/components/ui/use-theme";
import { BUDGET_STORAGE_KEY, readLocalBudget } from "@/lib/usageWeek";

const FONT_OPTIONS: { value: FontChoice; label: string; description: string; style: CSSProperties }[] = [
  { value: "geist", label: "Geist", description: "Modern default", style: { fontFamily: "var(--font-geist)" } },
  { value: "inter", label: "Inter", description: "Clean UI sans", style: { fontFamily: "var(--font-inter)" } },
  { value: "system", label: "System", description: "Native OS font", style: { fontFamily: "ui-sans-serif, system-ui, sans-serif" } },
  { value: "jetbrains", label: "JetBrains Mono", description: "Monospaced", style: { fontFamily: "var(--font-jetbrains)" } },
];

interface SettingsContextValue {
  openSettings: (projectId?: string) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used within SettingsProvider");
  return context;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const openSettings = useCallback((nextProjectId?: string) => {
    if (nextProjectId) setProjectId(nextProjectId);
    setOpen(true);
  }, []);

  return (
    <SettingsContext.Provider value={{ openSettings }}>
      {children}
      <SettingsModal open={open} projectId={projectId} onProjectChange={setProjectId} onClose={() => setOpen(false)} />
    </SettingsContext.Provider>
  );
}

function BudgetField() {
  const [value, setValue] = useState("");
  useEffect(() => setValue(String(readLocalBudget() ?? "")), []);
  const save = (next: string) => {
    setValue(next);
    const n = Math.floor(Number(next));
    try {
      if (Number.isFinite(n) && n > 0) localStorage.setItem(BUDGET_STORAGE_KEY, String(n));
      else localStorage.removeItem(BUDGET_STORAGE_KEY);
    } catch {
      /* storage denied */
    }
    window.dispatchEvent(new Event("fhara:budget-changed"));
  };

  return (
    <section className="rounded-xl border border-line bg-canvas p-3">
      <label htmlFor="settings-weekly-budget" className="block text-[13px] font-semibold">Weekly usage budget</label>
      <p id="settings-weekly-budget-help" className="mt-0.5 text-[11px] text-ink-3">
        Weekly token budget for the sidebar meter (resets Monday 09:00). Leave empty to use the server&apos;s
        MOAGENT_WEEKLY_TOKEN_BUDGET, or show raw tokens when neither is set.
      </p>
      <input
        type="number"
        min={0}
        step={100000}
        inputMode="numeric"
        value={value}
        onChange={(e) => save(e.target.value)}
        placeholder="e.g. 2000000"
        id="settings-weekly-budget"
        aria-describedby="settings-weekly-budget-help"
        className="mt-2 h-8 w-full max-w-xs rounded-lg border border-line bg-canvas px-3 text-xs text-ink outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/15"
      />
    </section>
  );
}

/**
 * Escape inside Settings closes an open menu, popover, listbox or nested
 * dialog first; only a bare Escape closes the whole modal.
 */
function hasOpenLayer(panel: HTMLElement | null, target: EventTarget | null): boolean {
  if (panel?.querySelector('[role="menu"], [role="listbox"], [aria-expanded="true"]')) return true;
  if (document.querySelector('[role="alertdialog"]')) return true;
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  if (dialogs.some((d) => d !== panel && !panel?.contains(d) && !d.contains(panel))) return true;
  return target instanceof HTMLSelectElement;
}

const NAV_ITEMS: { id: string; label: string; icon: typeof SlidersHorizontal; group?: string }[] = [
  // Top group
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "diffs", label: "Diffs & pull requests", icon: GitPullRequest },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "snapshots", label: "SnapShots", icon: Camera },
  // Agents group
  { id: "providers", label: "Providers", icon: Cpu, group: "Agents" },
  { id: "threads", label: "Threads", icon: ListFilter, group: "Agents" },
  { id: "chat", label: "Chat", icon: MessageSquare, group: "Agents" },
  { id: "browser", label: "Browser", icon: Globe, group: "Agents" },
  { id: "devices", label: "Devices", icon: Laptop, group: "Agents" },
  { id: "scheduled", label: "Scheduled tasks", icon: CalendarClock, group: "Agents" },
  // Code group
  { id: "projects", label: "Projects", icon: FolderGit2, group: "Code" },
  { id: "source-control", label: "Source control", icon: GitBranch, group: "Code" },
  { id: "worktrees", label: "Worktrees", icon: GitMerge, group: "Code" },
  // Connections group
  { id: "environments", label: "Environments", icon: Layers, group: "Connections" },
  { id: "sharing", label: "Sharing & access", icon: ShieldCheck, group: "Connections" },
  // Bottom items
  { id: "workspace", label: "Workspace", icon: Wrench },
  { id: "maintenance", label: "Maintenance", icon: Wrench },
  { id: "labs", label: "Labs", icon: FlaskConical },
  { id: "about", label: "About", icon: Info },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "signin", label: "Sign in to Fhara", icon: LogIn },
];

/** Real surfaces that already exist as pages; the modal links to them. */
const WORKSPACE_LINKS = [
  { id: "integrations", label: "Integrations", description: "GitHub connection, MCP servers.", href: "/integrations" },
  { id: "library", label: "Library", description: "Agent skills and templates.", href: "/library" },
  { id: "memory", label: "Memory", description: "Saved facts and context.", href: "/memory" },
  { id: "team", label: "Team", description: "Agents, roles and performance.", href: "/team" },
  { id: "sandbox", label: "Agent sandbox", description: "Try tools without a task.", href: "/sandbox" },
  { id: "audit", label: "Audit log", description: "Every action the app took.", href: "/audit" },
];

export function SettingsModal({
  open,
  projectId,
  onProjectChange,
  onClose,
}: {
  open: boolean;
  projectId?: string;
  onProjectChange: (projectId?: string) => void;
  onClose: () => void;
}) {
  const { preference, setTheme } = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);
  const { font, setFont } = useFont();
  const [active, setActive] = useState("general");
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);

  const filteredItems = useMemo(() => {
    if (!search.trim()) return NAV_ITEMS;
    const q = search.toLowerCase();
    return NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(q));
  }, [search]);

  const activeItem = NAV_ITEMS.find((n) => n.id === active) || NAV_ITEMS[0];

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented || hasOpenLayer(panelRef.current, e.target)) return;
        onClose();
      } else if (e.key === "/" && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/70 backdrop-blur-[2px]">
        <div className="absolute inset-0" onClick={onClose} />

        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          className="relative z-10 flex h-[720px] max-h-[92vh] w-full max-w-[1040px] overflow-hidden rounded-2xl border border-line bg-panel text-ink shadow-2xl shadow-black/90 font-sans"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Left Sidebar */}
          <aside className="flex w-[240px] shrink-0 flex-col border-r border-line bg-canvas">
            <div className="p-3 pb-2">
              <div className="relative flex items-center rounded-lg border border-line bg-canvas px-2.5 py-1.5 gap-2 text-ink-3 focus-within:border-brand focus-within:text-ink">
                <Search size={13} className="shrink-0 text-ink-3" />
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search"
                  aria-label="Search settings"
                  className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-3 focus:outline-none"
                />
                <kbd className="rounded border border-line bg-hover px-1 py-0.5 text-[10px] font-medium text-ink-3 leading-none">
                  /
                </kbd>
              </div>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 py-1 shell-scroll">
              {search.trim() ? (
                <div className="space-y-0.5">
                  {filteredItems.map((item) => {
                    const Icon = item.icon;
                    const isSelected = active === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setActive(item.id)}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-normal transition-colors text-left ${
                          isSelected
                            ? "bg-[#27272a] text-white font-medium"
                            : "text-neutral-400 hover:text-neutral-200 hover:bg-[#1c1c20]"
                        }`}
                      >
                        <Icon size={15} className={isSelected ? "text-ink" : "text-ink-3"} />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <>
                  <div className="space-y-0.5 pb-2">
                    {NAV_ITEMS.filter((i) => !i.group && NAV_ITEMS.indexOf(i) < 7).map((item) => {
                      const Icon = item.icon;
                      const isSelected = active === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setActive(item.id)}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-normal transition-colors text-left ${
                            isSelected
                              ? "bg-hover text-ink font-medium"
                              : "text-ink-2 hover:text-ink hover:bg-hover"
                          }`}
                        >
                          <Icon size={15} className={isSelected ? "text-ink" : "text-ink-3"} />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="pt-2 pb-2">
                    <p className="px-2.5 pb-1.5 text-[11px] font-medium text-ink-3">Agents</p>
                    <div className="space-y-0.5">
                      {NAV_ITEMS.filter((i) => i.group === "Agents").map((item) => {
                        const Icon = item.icon;
                        const isSelected = active === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setActive(item.id)}
                            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-normal transition-colors text-left ${
                              isSelected
                                ? "bg-hover text-ink font-medium"
                                : "text-ink-2 hover:text-ink hover:bg-hover"
                            }`}
                          >
                            <Icon size={15} className={isSelected ? "text-ink" : "text-ink-3"} />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="pt-2 pb-2">
                    <p className="px-2.5 pb-1.5 text-[11px] font-medium text-ink-3">Code</p>
                    <div className="space-y-0.5">
                      {NAV_ITEMS.filter((i) => i.group === "Code").map((item) => {
                        const Icon = item.icon;
                        const isSelected = active === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setActive(item.id)}
                            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-normal transition-colors text-left ${
                              isSelected
                                ? "bg-hover text-ink font-medium"
                                : "text-ink-2 hover:text-ink hover:bg-hover"
                            }`}
                          >
                            <Icon size={15} className={isSelected ? "text-ink" : "text-ink-3"} />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="pt-2 pb-2">
                    <p className="px-2.5 pb-1.5 text-[11px] font-medium text-ink-3">Connections</p>
                    <div className="space-y-0.5">
                      {NAV_ITEMS.filter((i) => i.group === "Connections").map((item) => {
                        const Icon = item.icon;
                        const isSelected = active === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setActive(item.id)}
                            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-normal transition-colors text-left ${
                              isSelected
                                ? "bg-hover text-ink font-medium"
                                : "text-ink-2 hover:text-ink hover:bg-hover"
                            }`}
                          >
                            <Icon size={15} className={isSelected ? "text-ink" : "text-ink-3"} />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="pt-2 pb-4 space-y-0.5">
                    {NAV_ITEMS.filter((i) => !i.group && NAV_ITEMS.indexOf(i) >= 18).map((item) => {
                      const Icon = item.icon;
                      const isSelected = active === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setActive(item.id)}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-normal transition-colors text-left ${
                            isSelected
                              ? "bg-hover text-ink font-medium"
                              : "text-ink-2 hover:text-ink hover:bg-hover"
                          }`}
                        >
                          <Icon size={15} className={isSelected ? "text-ink" : "text-ink-3"} />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </nav>
          </aside>

          {/* Right Main Content */}
          <main className="flex flex-1 flex-col overflow-hidden bg-panel">
            <header className="flex h-13 shrink-0 items-center justify-between border-b border-line px-8">
              <div className="flex items-center gap-1.5 text-[13px]">
                <span className="text-ink-3">Settings</span>
                <span className="text-ink-3">/</span>
                <span id="settings-title" className="font-semibold text-ink">{activeItem.label}</span>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setTheme("system");
                    setFont("geist");
                  }}
                  className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink transition-colors py-1 px-2 rounded-md hover:bg-hover"
                >
                  <RotateCcw size={12} />
                  <span>Restore device defaults</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="p-1 text-ink-3 hover:text-ink hover:bg-hover rounded-md transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            {/* Scrollable Settings Panel */}
            <div className="flex-1 overflow-y-auto px-8 py-6 space-y-7 shell-scroll">
              {active === "providers" ? (
                <div className="space-y-6">
                  <LlmSettingsSection projectId={projectId} onProjectChange={onProjectChange} />
                </div>
              ) : active === "appearance" ? (
                <>
                  <section className="rounded-xl border border-line bg-canvas p-3">
                    <h2 className="text-[13px] font-semibold">Theme mode</h2>
                    <p className="mt-0.5 text-[11px] text-ink-3">Choose dark, light, or follow device appearance.</p>
                    <div className="mt-2 grid grid-cols-3 gap-1.5">
                      {(
                        [
                          { value: "light", label: "Light", icon: Sun },
                          { value: "dark", label: "Dark", icon: Moon },
                          { value: "system", label: "System", icon: Monitor },
                        ] as const
                      ).map(({ value, label, icon: Icon }) => {
                        const active = preference === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setTheme(value)}
                            aria-pressed={active}
                            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[13px] font-medium transition ${
                              active ? "border-brand bg-brand-soft text-brand-ink" : "border-line hover:bg-hover"
                            }`}
                          >
                            <Icon size={14} />
                            {label}
                            {active && <Check size={12} className="ml-auto" />}
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="rounded-xl border border-line bg-canvas p-3">
                    <h2 className="text-[13px] font-semibold">Interface font</h2>
                    <p className="mt-0.5 text-[11px] text-ink-3">Workspace typography saved on this device.</p>
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {FONT_OPTIONS.map((option) => {
                        const active = font === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setFont(option.value)}
                            aria-pressed={active}
                            className={`rounded-lg border px-2 py-1.5 text-left transition ${
                              active ? "border-brand bg-brand-soft" : "border-line hover:bg-hover"
                            }`}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate text-[13px] font-semibold">{option.label}</span>
                              {active && <Check size={12} className="shrink-0 text-brand-ink" />}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-ink-3">{option.description}</span>
                            <span className="mt-0.5 block truncate text-[11px]" style={option.style}>
                              The quick brown fox 0123
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </>
              ) : active === "general" ? (
                <>
                  <BudgetField />
                </>
              ) : active === "chat" ? (
                <section>
                  <h3 className="text-[14px] font-semibold text-ink mb-2.5">Chat</h3>
                  <div className="rounded-xl border border-line bg-canvas divide-y divide-line overflow-hidden">
                    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">Grounded chat</span>
                        <span className="block text-[11.5px] leading-relaxed text-ink-3 mt-0.5">
                          Agents can read the repo to answer with facts, not guesses. Requires an online worker.
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-ink-3">Always on when a worker is online</span>
                    </div>
                    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">Reply style</span>
                        <span className="block text-[11.5px] leading-relaxed text-ink-3 mt-0.5">
                          How chat replies are rendered: markdown, code blocks, and streaming.
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-ink-3">Markdown</span>
                    </div>
                    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">Mentions</span>
                        <span className="block text-[11.5px] leading-relaxed text-ink-3 mt-0.5">
                          @mention a teammate to route the reply to that role.
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-ink-3">Role-based</span>
                    </div>
                  </div>
                </section>
              ) : active === "workspace" ? (
                <section>
                  <h3 className="text-[14px] font-semibold text-ink mb-2.5">Workspace</h3>
                  <div className="rounded-xl border border-line bg-canvas divide-y divide-line overflow-hidden">
                    {WORKSPACE_LINKS.map((link) => (
                      <Link
                        key={link.id}
                        href={projectId ? `${link.href}?project=${projectId}` : link.href}
                        className="flex items-center justify-between gap-6 px-4 py-3.5 transition-colors hover:bg-hover"
                      >
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-ink">{link.label}</span>
                          <span className="block text-[11.5px] leading-relaxed text-ink-3 mt-0.5">
                            {link.description}
                          </span>
                        </span>
                        <ChevronDown size={13} className="shrink-0 -rotate-90 text-ink-3" />
                      </Link>
                    ))}
                  </div>
                </section>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center text-ink-3">
                  <activeItem.icon size={36} className="text-neutral-600 mb-3" />
                  <h4 className="text-sm font-medium text-ink">{activeItem.label}</h4>
                  <p className="text-xs text-ink-3 mt-1 max-w-sm">
                    Configure your {activeItem.label.toLowerCase()} preferences and workspace integrations here.
                  </p>
                </div>
              )}
            </div>
          </main>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body
  );
}
