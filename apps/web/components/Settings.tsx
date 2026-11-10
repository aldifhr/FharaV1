"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
  ChevronDown,
  RotateCw,
  Check,
  Moon,
  Sun,
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
      <SettingsModal
        open={open}
        projectId={projectId}
        onProjectChange={setProjectId}
        onClose={() => setOpen(false)}
      />
    </SettingsContext.Provider>
  );
}

// Nav items matching screenshot structure
interface NavItemDef {
  id: string;
  label: string;
  icon: typeof SlidersHorizontal;
  group?: string;
}

const NAV_ITEMS: NavItemDef[] = [
  // Top group
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "diffs", label: "Diffs & pull requests", icon: GitPullRequest },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "snapshots", label: "SnapShots", icon: Camera },
  // Agents group
  { id: "providers", label: "Providers", icon: Cpu, group: "Agents" },
  { id: "threads", label: "Threads", icon: ListFilter, group: "Agents" },
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
  { id: "maintenance", label: "Maintenance", icon: Wrench },
  { id: "labs", label: "Labs", icon: FlaskConical },
  { id: "about", label: "About", icon: Info },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "signin", label: "Sign in to Fhara", icon: LogIn },
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
  const [active, setActive] = useState("general");
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);

  // Settings states matching screenshot defaults
  const [threadNotifs, setThreadNotifs] = useState("Off");
  const [inAppNotifs, setInAppNotifs] = useState(false);
  const [projectGrouping, setProjectGrouping] = useState(true);
  const [projectOrder, setProjectOrder] = useState("Last user message");
  const [workingSection, setWorkingSection] = useState(false);
  const [unpinConfirmation, setUnpinConfirmation] = useState(false);
  const [archiveConfirmation, setArchiveConfirmation] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(true);
  const [quitShortcut, setQuitShortcut] = useState("Hold");

  const { theme, setTheme } = useTheme();
  const { font, setFont } = useFont();

  const handleRestoreDefaults = () => {
    setThreadNotifs("Off");
    setInAppNotifs(false);
    setProjectGrouping(true);
    setProjectOrder("Last user message");
    setWorkingSection(false);
    setUnpinConfirmation(false);
    setArchiveConfirmation(false);
    setDeleteConfirmation(true);
    setQuitShortcut("Hold");
    setTheme("dark");
    setFont("geist");
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "/" && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const filteredItems = useMemo(() => {
    if (!search.trim()) return NAV_ITEMS;
    const q = search.toLowerCase();
    return NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(q));
  }, [search]);

  const activeItem = NAV_ITEMS.find((n) => n.id === active) || NAV_ITEMS[0];

  if (!mounted || !open) return null;

  return createPortal(
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/70 backdrop-blur-[2px]">
        {/* Backdrop click */}
        <div className="absolute inset-0" onClick={onClose} />

        {/* Modal Window Container */}
        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="relative z-10 flex h-[720px] max-h-[92vh] w-full max-w-[1040px] overflow-hidden rounded-2xl border border-[#27272a] bg-[#0c0c0e] text-[#f4f4f5] shadow-2xl shadow-black/90 font-sans"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Left Sidebar */}
          <aside className="flex w-[240px] shrink-0 flex-col border-r border-[#222226] bg-[#0f0f12]">
            {/* Search Input */}
            <div className="p-3 pb-2">
              <div className="relative flex items-center rounded-lg bg-[#18181b] border border-[#27272a] px-2.5 py-1.5 gap-2 text-neutral-400 focus-within:border-neutral-500 focus-within:text-neutral-200">
                <Search size={13} className="shrink-0 text-neutral-400" />
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search"
                  className="w-full bg-transparent text-[12.5px] text-neutral-200 placeholder:text-neutral-500 focus:outline-none"
                />
                <kbd className="rounded border border-neutral-700/60 bg-neutral-800 px-1 py-0.5 text-[10px] font-medium text-neutral-400 leading-none">
                  /
                </kbd>
              </div>
            </div>

            {/* Navigation Sections */}
            <nav className="flex-1 overflow-y-auto px-2 py-1 scrollbar-thin scrollbar-thumb-neutral-800">
              {/* If searching, show flat list */}
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
                        <Icon size={15} className={isSelected ? "text-white" : "text-neutral-400"} />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <>
                  {/* Top unlabelled group */}
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
                              ? "bg-[#27272a] text-white font-medium"
                              : "text-neutral-400 hover:text-neutral-200 hover:bg-[#1c1c20]"
                          }`}
                        >
                          <Icon size={15} className={isSelected ? "text-white" : "text-neutral-400"} />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Agents group */}
                  <div className="pt-2 pb-2">
                    <p className="px-2.5 pb-1.5 text-[11px] font-medium text-neutral-500">Agents</p>
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
                                ? "bg-[#27272a] text-white font-medium"
                                : "text-neutral-400 hover:text-neutral-200 hover:bg-[#1c1c20]"
                            }`}
                          >
                            <Icon size={15} className={isSelected ? "text-white" : "text-neutral-400"} />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Code group */}
                  <div className="pt-2 pb-2">
                    <p className="px-2.5 pb-1.5 text-[11px] font-medium text-neutral-500">Code</p>
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
                                ? "bg-[#27272a] text-white font-medium"
                                : "text-neutral-400 hover:text-neutral-200 hover:bg-[#1c1c20]"
                            }`}
                          >
                            <Icon size={15} className={isSelected ? "text-white" : "text-neutral-400"} />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Connections group */}
                  <div className="pt-2 pb-2">
                    <p className="px-2.5 pb-1.5 text-[11px] font-medium text-neutral-500">Connections</p>
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
                                ? "bg-[#27272a] text-white font-medium"
                                : "text-neutral-400 hover:text-neutral-200 hover:bg-[#1c1c20]"
                            }`}
                          >
                            <Icon size={15} className={isSelected ? "text-white" : "text-neutral-400"} />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Bottom items */}
                  <div className="pt-2 pb-4 space-y-0.5">
                    {NAV_ITEMS.filter((i) => !i.group && NAV_ITEMS.indexOf(i) >= 17).map((item) => {
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
                          <Icon size={15} className={isSelected ? "text-white" : "text-neutral-400"} />
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
          <main className="flex flex-1 flex-col overflow-hidden bg-[#0c0c0e]">
            {/* Top Bar / Header */}
            <header className="flex h-13 shrink-0 items-center justify-between border-b border-[#1f1f23] px-8">
              {/* Breadcrumb */}
              <div className="flex items-center gap-1.5 text-[13px]">
                <span className="text-neutral-400">Settings</span>
                <span className="text-neutral-600">/</span>
                <span className="font-semibold text-white">{activeItem.label}</span>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleRestoreDefaults}
                  className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 transition-colors py-1 px-2 rounded-md hover:bg-neutral-800/50"
                >
                  <RotateCcw size={12} />
                  <span>Restore device defaults</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-800/60 rounded-md transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            {/* Scrollable Settings Panel */}
            <div className="flex-1 overflow-y-auto px-8 py-6 space-y-7 scrollbar-thin scrollbar-thumb-neutral-800">
              {active === "providers" ? (
                <div className="space-y-6">
                  <LlmSettingsSection projectId={projectId} onProjectChange={onProjectChange} />
                </div>
              ) : active === "general" ? (
                <>
                  {/* Notifications */}
                  <section>
                    <h3 className="text-[14px] font-semibold text-white mb-2.5">Notifications</h3>
                    <div className="rounded-xl border border-[#27272a] bg-[#141416]/70 divide-y divide-[#27272a]/70 overflow-hidden">
                      {/* Thread notifications */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Thread notifications</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while Fhara is open.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomSelect
                            value={threadNotifs}
                            onChange={setThreadNotifs}
                            options={["Off", "All threads", "Only mentions & approvals", "Only failures"]}
                          />
                        </div>
                      </div>

                      {/* In-app notifications */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">In-app notifications</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomToggle checked={inAppNotifs} onChange={setInAppNotifs} label="In-app notifications" />
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Sidebar */}
                  <section>
                    <h3 className="text-[14px] font-semibold text-white mb-2.5">Sidebar</h3>
                    <div className="rounded-xl border border-[#27272a] bg-[#141416]/70 divide-y divide-[#27272a]/70 overflow-hidden">
                      {/* Project grouping */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Project grouping</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Combine matching repositories across environments.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomToggle checked={projectGrouping} onChange={setProjectGrouping} label="Project grouping" />
                        </div>
                      </div>

                      {/* Project order */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Project order</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Order of projects in the sidebar project picker and command palette.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomSelect
                            value={projectOrder}
                            onChange={setProjectOrder}
                            options={["Last user message", "Alphabetical", "Recently opened", "Manual"]}
                          />
                        </div>
                      </div>

                      {/* Working section */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] font-medium text-neutral-100">Working section</span>
                            <RotateCw size={11} className="text-neutral-500" />
                          </div>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you. The boring sidebar in Labs has no Working section.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomToggle checked={workingSection} onChange={setWorkingSection} label="Working section" />
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Confirmations */}
                  <section>
                    <h3 className="text-[14px] font-semibold text-white mb-2.5">Confirmations</h3>
                    <div className="rounded-xl border border-[#27272a] bg-[#141416]/70 divide-y divide-[#27272a]/70 overflow-hidden">
                      {/* Unpin confirmation */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Unpin confirmation</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Ask before unpinning a thread from the pinned section.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomToggle checked={unpinConfirmation} onChange={setUnpinConfirmation} label="Unpin confirmation" />
                        </div>
                      </div>

                      {/* Archive confirmation */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Archive confirmation</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Require a second click on the inline archive action before a thread is archived.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomToggle checked={archiveConfirmation} onChange={setArchiveConfirmation} label="Archive confirmation" />
                        </div>
                      </div>

                      {/* Delete confirmation */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Delete confirmation</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Ask before deleting a thread and its chat history.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomToggle checked={deleteConfirmation} onChange={setDeleteConfirmation} label="Delete confirmation" />
                        </div>
                      </div>

                      {/* Quit shortcut */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Quit shortcut</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Hold mode also quits on two quick presses.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomSelect
                            value={quitShortcut}
                            onChange={setQuitShortcut}
                            options={["Hold", "Double press", "Single press", "Disabled"]}
                          />
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Display */}
                  <section>
                    <h3 className="text-[14px] font-semibold text-white mb-2.5">Display</h3>
                    <div className="rounded-xl border border-[#27272a] bg-[#141416]/70 divide-y divide-[#27272a]/70 overflow-hidden">
                      {/* Theme */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Theme mode</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Choose dark, light, or follow device appearance.
                          </p>
                        </div>
                        <div className="shrink-0 flex items-center gap-1.5 bg-[#18181b] p-1 rounded-lg border border-[#27272a]">
                          <button
                            type="button"
                            onClick={() => setTheme("dark")}
                            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition ${
                              theme === "dark" ? "bg-[#2563eb] text-white font-medium" : "text-neutral-400 hover:text-neutral-200"
                            }`}
                          >
                            <Moon size={12} />
                            Dark
                          </button>
                          <button
                            type="button"
                            onClick={() => setTheme("light")}
                            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition ${
                              theme === "light" ? "bg-[#2563eb] text-white font-medium" : "text-neutral-400 hover:text-neutral-200"
                            }`}
                          >
                            <Sun size={12} />
                            Light
                          </button>
                        </div>
                      </div>

                      {/* Font */}
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-neutral-100">Interface font</p>
                          <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
                            Workspace typography saved on this device.
                          </p>
                        </div>
                        <div className="shrink-0">
                          <CustomSelect
                            value={font}
                            onChange={(f) => setFont(f as FontChoice)}
                            options={["geist", "inter", "system", "jetbrains"]}
                          />
                        </div>
                      </div>

                      {/* Budget */}
                      <div className="px-4 py-3.5">
                        <BudgetFieldInline />
                      </div>
                    </div>
                  </section>
                </>
              ) : active === "appearance" ? (
                <div className="space-y-6">
                  <section>
                    <h3 className="text-[14px] font-semibold text-white mb-2.5">Theme & Typography</h3>
                    <div className="rounded-xl border border-[#27272a] bg-[#141416]/70 divide-y divide-[#27272a]/70 overflow-hidden">
                      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                        <div>
                          <p className="text-[13px] font-medium text-neutral-100">Theme mode</p>
                          <p className="text-[11.5px] text-neutral-400 mt-0.5">Select your preferred color theme.</p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setTheme("dark")}
                            className={`px-3 py-1.5 text-xs rounded-lg border flex items-center gap-1.5 ${
                              theme === "dark" ? "border-blue-500 bg-blue-600/20 text-white" : "border-[#27272a] text-neutral-400"
                            }`}
                          >
                            <Moon size={13} /> Dark
                          </button>
                          <button
                            onClick={() => setTheme("light")}
                            className={`px-3 py-1.5 text-xs rounded-lg border flex items-center gap-1.5 ${
                              theme === "light" ? "border-blue-500 bg-blue-600/20 text-white" : "border-[#27272a] text-neutral-400"
                            }`}
                          >
                            <Sun size={13} /> Light
                          </button>
                        </div>
                      </div>
                      <div className="p-4">
                        <p className="text-[13px] font-medium text-neutral-100 mb-2">Available Fonts</p>
                        <div className="grid grid-cols-2 gap-2">
                          {FONT_OPTIONS.map((f) => (
                            <button
                              key={f.value}
                              onClick={() => setFont(f.value)}
                              className={`p-2.5 text-left rounded-lg border transition ${
                                font === f.value ? "border-blue-500 bg-blue-600/10 text-white" : "border-[#27272a] text-neutral-400 hover:border-neutral-600"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-xs text-neutral-200">{f.label}</span>
                                {font === f.value && <Check size={12} className="text-blue-500" />}
                              </div>
                              <span className="text-[11px] text-neutral-500 block mt-0.5">{f.description}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              ) : active === "keybindings" ? (
                <div className="space-y-4">
                  <h3 className="text-[14px] font-semibold text-white">Keyboard Shortcuts</h3>
                  <div className="rounded-xl border border-[#27272a] bg-[#141416]/70 divide-y divide-[#27272a]/70 overflow-hidden text-xs">
                    {[
                      { action: "Open Command Palette", key: "Ctrl + K / ⌘K" },
                      { action: "Focus Settings Search", key: "/" },
                      { action: "Toggle Sidebar", key: "Ctrl + B / ⌘B" },
                      { action: "Close Dialog / Cancel", key: "Escape" },
                      { action: "Send Message", key: "Enter / ⌘Enter" },
                      { action: "New Task / Thread", key: "Ctrl + N / ⌘N" },
                    ].map((s) => (
                      <div key={s.action} className="flex items-center justify-between px-4 py-3">
                        <span className="text-neutral-300">{s.action}</span>
                        <kbd className="px-2 py-1 rounded bg-[#27272a] text-neutral-200 border border-neutral-700/60 font-mono text-[11px]">
                          {s.key}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center text-neutral-400">
                  <activeItem.icon size={36} className="text-neutral-600 mb-3" />
                  <h4 className="text-sm font-medium text-neutral-200">{activeItem.label}</h4>
                  <p className="text-xs text-neutral-500 mt-1 max-w-sm">
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

// Custom Switch matching the exact blue and dark styling in the screenshot
function CustomToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none ${
        checked ? "bg-[#2563eb]" : "bg-[#27272a]"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

// Custom Dropdown select matching the subtle dark pill styling
function CustomSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between gap-2.5 rounded-lg border border-[#27272a] bg-[#18181b] px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-600 transition-colors focus:outline-none"
      >
        <span>{value}</span>
        <ChevronDown size={13} className="text-neutral-500" />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 min-w-[150px] rounded-lg border border-[#27272a] bg-[#18181b] p-1 shadow-xl">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                opt === value
                  ? "bg-[#27272a] text-white font-medium"
                  : "text-neutral-300 hover:bg-[#222226] hover:text-white"
              }`}
            >
              <span>{opt}</span>
              {opt === value && <Check size={12} className="text-blue-500" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Usage budget inline editor */
function BudgetFieldInline() {
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
    <div>
      <p className="text-[13px] font-medium text-neutral-100">Weekly usage budget</p>
      <p className="text-[11.5px] leading-relaxed text-neutral-400 mt-0.5">
        Weekly token budget for the sidebar usage meter. Leave empty for server default.
      </p>
      <input
        type="number"
        min={0}
        step={100000}
        inputMode="numeric"
        value={value}
        onChange={(e) => save(e.target.value)}
        placeholder="e.g. 2000000"
        className="mt-2 h-8 w-full max-w-xs rounded-lg border border-[#27272a] bg-[#18181b] px-3 text-xs text-neutral-200 placeholder:text-neutral-500 outline-none focus:border-neutral-500"
      />
    </div>
  );
}
