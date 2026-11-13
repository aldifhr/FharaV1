"use client";

import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
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
  Check,
  Moon,
  Sun,
  Monitor,
  Plug,
  Sparkles,
} from "lucide-react";
import LlmSettingsSection from "./LlmSettings";
import { IntegrationsPanel } from "./integrations/IntegrationsPanel";
import {
  AboutTab,
  ArchiveTab,
  BrowserTab,
  DevicesTab,
  DiffsTab,
  EnvironmentsTab,
  KeybindingsTab,
  LabsTab,
  MaintenanceTab,
  ProjectsTab,
  ProvidersTab,
  ScheduledTab,
  SharingTab,
  SignInTab,
  SnapshotsTab,
  SourceControlTab,
  ThreadsTab,
  VoiceTab,
  WorkspaceTab,
  WorktreesTab,
} from "./settings/tabs";
import { TimeZoneField } from "./settings/TimeZoneField";
import { resetUiPrefs } from "@/lib/uiPrefs";
import { defaultKeybindings, writeKeybindings } from "@/lib/keybindings";
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
  /** `section` opens one tab, such as "models" for LLM & Models. */
  openSettings: (projectId?: string, section?: string) => void;
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
  const [section, setSection] = useState<{ id: string } | null>(null);
  const openSettings = useCallback((nextProjectId?: string, nextSection?: string) => {
    if (nextProjectId) setProjectId(nextProjectId);
    if (nextSection) setSection({ id: nextSection });
    setOpen(true);
  }, []);

  return (
    <SettingsContext.Provider value={{ openSettings }}>
      {children}
      <SettingsModal open={open} section={section} projectId={projectId} onProjectChange={setProjectId} onClose={() => setOpen(false)} />
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
        className="mt-2 h-8 w-full max-w-xs rounded-lg border border-line bg-canvas px-3 text-xs text-ink outline-none focus:border-ink/30 focus:ring-2 focus:ring-ink/10"
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

export const NAV_ITEMS: { id: string; label: string; icon: typeof SlidersHorizontal; group?: string }[] = [
  // Top group
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "diffs", label: "Diffs & pull requests", icon: GitPullRequest },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "snapshots", label: "SnapShots", icon: Camera },
  // Agents group
  { id: "providers", label: "Providers", icon: Cpu, group: "Agents" },
  { id: "models", label: "LLM & Models", icon: Sparkles, group: "Agents" },
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
  { id: "integrations", label: "Integrations", icon: Plug, group: "Connections" },
  { id: "environments", label: "Environments", icon: Layers, group: "Connections" },
  { id: "sharing", label: "Sharing & access", icon: ShieldCheck, group: "Connections" },
  // Bottom items
  { id: "workspace", label: "Workspace", icon: Wrench },
  { id: "maintenance", label: "Maintenance", icon: Wrench },
  { id: "labs", label: "Labs", icon: FlaskConical },
  { id: "about", label: "About", icon: Info },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "signin", label: "Account", icon: LogIn },
];

/** The tabs that live in settings/tabs.tsx. */
function ActiveTab({ id, projectId }: { id: string; projectId?: string }) {
  switch (id) {
    case "diffs":
      return <DiffsTab />;
    case "keybindings":
      return <KeybindingsTab />;
    case "voice":
      return <VoiceTab />;
    case "snapshots":
      return <SnapshotsTab />;
    case "threads":
      return <ThreadsTab />;
    case "browser":
      return <BrowserTab />;
    case "devices":
      return <DevicesTab />;
    case "scheduled":
      return <ScheduledTab />;
    case "projects":
      return <ProjectsTab />;
    case "source-control":
      return <SourceControlTab />;
    case "worktrees":
      return <WorktreesTab />;
    case "integrations":
      return (
        <Suspense fallback={<p className="text-[13px] text-ink-3" role="status">Loading integrations…</p>}>
          <IntegrationsPanel embedded />
        </Suspense>
      );
    case "environments":
      return <EnvironmentsTab />;
    case "sharing":
      return <SharingTab />;
    case "workspace":
      return <WorkspaceTab projectId={projectId} />;
    case "maintenance":
      return <MaintenanceTab />;
    case "labs":
      return <LabsTab />;
    case "about":
      return <AboutTab />;
    case "archive":
      return <ArchiveTab />;
    case "signin":
      return <SignInTab />;
    default:
      return null;
  }
}

type NavItem = (typeof NAV_ITEMS)[number];

/** Nav sections: the ungrouped items before the first group, each group, then the rest. */
const NAV_SECTIONS: { key: string; title?: string; items: NavItem[] }[] = (() => {
  const firstGrouped = NAV_ITEMS.findIndex((i) => i.group);
  const sections: { key: string; title?: string; items: NavItem[] }[] = [
    { key: "top", items: NAV_ITEMS.filter((i, index) => !i.group && index < firstGrouped) },
  ];
  for (const item of NAV_ITEMS) {
    if (!item.group) continue;
    let section = sections.find((s) => s.key === item.group);
    if (!section) {
      section = { key: item.group, title: item.group, items: [] };
      sections.push(section);
    }
    section.items.push(item);
  }
  sections.push({ key: "bottom", items: NAV_ITEMS.filter((i, index) => !i.group && index > firstGrouped) });
  return sections;
})();

function NavButton({ item, selected, onSelect }: { item: NavItem; selected: boolean; onSelect: (id: string) => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={selected ? "page" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-normal transition-colors ${
        selected ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
      }`}
    >
      <Icon size={15} className={selected ? "text-ink" : "text-ink-3"} />
      <span>{item.label}</span>
    </button>
  );
}

function SettingsModal({
  open,
  section,
  projectId,
  onProjectChange,
  onClose,
}: {
  open: boolean;
  /** A tab to open on (a new object each request, so asking twice reopens it). */
  section?: { id: string } | null;
  projectId?: string;
  onProjectChange: (projectId?: string) => void;
  onClose: () => void;
}) {
  const { preference, setTheme } = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);
  const { font, setFont } = useFont();
  const [active, setActive] = useState("general");
  useEffect(() => {
    if (section && NAV_ITEMS.some((item) => item.id === section.id)) setActive(section.id);
  }, [section]);
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
              <div className="relative flex items-center rounded-lg border border-line bg-canvas px-2.5 py-1.5 gap-2 text-ink-3 focus-within:border-ink focus-within:text-ink">
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
                  {filteredItems.map((item) => (
                    <NavButton key={item.id} item={item} selected={active === item.id} onSelect={setActive} />
                  ))}
                  {filteredItems.length === 0 && <p className="px-2.5 py-1.5 text-[12.5px] text-ink-3">No matching settings</p>}
                </div>
              ) : (
                NAV_SECTIONS.map((section) => (
                  <div key={section.key} className={section.key === "top" ? "space-y-0.5 pb-2" : "pt-2 pb-2"}>
                    {section.title && <p className="px-2.5 pb-1.5 text-[11px] font-medium text-ink-3">{section.title}</p>}
                    <div className="space-y-0.5">
                      {section.items.map((item) => (
                        <NavButton key={item.id} item={item} selected={active === item.id} onSelect={setActive} />
                      ))}
                    </div>
                  </div>
                ))
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
                    resetUiPrefs();
                    writeKeybindings(defaultKeybindings());
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
              {active === "models" ? (
                <div className="space-y-6">
                  <LlmSettingsSection projectId={projectId} onProjectChange={onProjectChange} />
                </div>
              ) : active === "providers" ? (
                <ProvidersTab onOpenModels={() => setActive("models")} />
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
                              active ? "border-ink bg-hover text-ink" : "border-line hover:bg-hover"
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
                              active ? "border-ink bg-hover" : "border-line hover:bg-hover"
                            }`}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate text-[13px] font-semibold">{option.label}</span>
                              {active && <Check size={12} className="shrink-0 text-ink" />}
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
                  <TimeZoneField />
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
              ) : (
                <ActiveTab id={active} projectId={projectId} />
              )}
            </div>
          </main>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body
  );
}