"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useQuery } from "convex/react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Building2,
  Brain,
  Cpu,
  GitBranch,
  Home,
  Inbox,
  KanbanSquare,
  Lightbulb,
  MessagesSquare,
  Moon,
  Network,
  Siren,
  TestTubes,
  Plug,
  Plus,
  ScrollText,
  Search,
  Settings,
  Share2,
  Scale,
  Sparkles,
  Sun,
  Users,
  FlaskConical,
  FolderTree,
  Globe,
  Workflow,
} from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useNewProject } from "./NewProject";
import { useSettings } from "./Settings";
import { useLlmSettings } from "./LlmSettings";
import { useTheme } from "./ui/use-theme";
import CommandMenu from "./CommandMenu";
import QueryBoundary from "./shell/QueryBoundary";
import { clockTime } from "@/lib/format";

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

const railBtn =
  "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40";

/** Rail button with a hover/focus tooltip rendered in a portal (the rail scrolls). */
function RailButton({
  icon: Icon,
  label,
  href,
  onClick,
  active = false,
  dot = false,
  buttonRef,
  expanded,
}: {
  icon: IconType;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  dot?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({ x: r.right + 10, y: r.top + r.height / 2 });
  };
  const common = {
    "aria-label": label,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget),
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget),
    onBlur: () => setTip(null),
    className: `${railBtn} ${active ? "bg-brand-soft text-brand-ink hover:bg-brand-soft hover:text-brand-ink" : ""}`,
  };
  const inner = (
    <>
      <Icon size={19} strokeWidth={1.75} />
      {dot && <span aria-hidden="true" className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500 ring-2 ring-panel" />}
    </>
  );
  return (
    <>
      {href ? (
        <Link href={href} aria-current={active ? "page" : undefined} onClick={onClick} {...common}>
          {inner}
        </Link>
      ) : (
        <button type="button" ref={buttonRef} onClick={onClick} aria-expanded={expanded} {...common}>
          {inner}
        </button>
      )}
      {tip &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            role="tooltip"
            className="pointer-events-none fixed z-[80] -translate-y-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
            style={{ left: tip.x, top: tip.y }}
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}

/** Inbox dot: anything needing the user across projects. */
function InboxButton({ active }: { active: boolean }) {
  const needs = useQuery(api.shell.needsYou, {});
  return <RailButton icon={Inbox} label="Inbox" href="/inbox" active={active} dot={(needs?.total ?? 0) > 0} />;
}

/** Floating panel anchored to the right of a rail button. */
function RailPanel({
  anchor,
  onClose,
  children,
  width = 300,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.min(r.right + 10, window.innerWidth - width - 8);
    setPos(r.top > window.innerHeight / 2 ? { left, bottom: window.innerHeight - r.bottom } : { left, top: r.top });
  }, [anchor, width]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);
  if (!pos || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[70] overflow-hidden rounded-xl border border-line bg-panel text-sm text-ink shadow-[0_16px_40px_-12px_rgba(20,20,40,0.3)]"
      style={{ ...pos, width }}
    >
      {children}
    </div>,
    document.body,
  );
}

const EVENT_LABEL: Record<string, string> = {
  "task.stage": "Stage",
  "task.check": "Check",
  "task.error": "Error",
  "task.steered": "You steered",
  "task.input_answered": "You answered",
  "approval.held": "Approval held",
};

function eventSummary(e: { type: string; payload?: any }): string {
  const p = e.payload ?? {};
  const detail = p.label ?? p.stage ?? p.message ?? p.instruction ?? p.answer ?? p.status ?? "";
  const label = EVENT_LABEL[e.type] ?? e.type.replace(/^task\./, "").replace(/[._]/g, " ");
  return detail ? `${label} · ${String(detail).slice(0, 80)}` : label;
}

function ActivityFeed({ projectId }: { projectId: string }) {
  const events = useQuery(api.taskEvents.listByProject, { projectId: projectId as never, limit: 20 });
  const tasks = useQuery(api.tasks.listByProject, { projectId: projectId as never });
  const title = (id: string) => (tasks ?? []).find((t: any) => t._id === id)?.title;
  return (
    <div>
      <p className="border-b border-line px-3.5 py-2.5 text-[13px] font-semibold">Activity</p>
      <ul className="shell-scroll max-h-[360px] overflow-y-auto py-1">
        {events === undefined && <li className="px-3.5 py-3 text-ink-3">Loading…</li>}
        {events?.length === 0 && <li className="px-3.5 py-3 text-ink-3">No activity yet in this project.</li>}
        {(events ?? []).map((e: any) => (
          <li key={e._id} className="px-3.5 py-2">
            <p className={`truncate text-[13px] ${e.level === "error" ? "text-red-600 dark:text-red-400" : "text-ink"}`}>{eventSummary(e)}</p>
            <p className="mt-0.5 truncate text-xs text-ink-3">
              {title(e.taskId) ?? "Task"} · {clockTime(e._creationTime)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function IconRail({
  projectId,
  mobile = "bar",
}: {
  projectId?: string;
  /** Below 980px: a top bar (standalone pages) or hidden (workspace, which has its own drawer). */
  mobile?: "bar" | "hidden";
}) {
  const pathname = usePathname();
  const { openNewProject } = useNewProject();
  const { openSettings } = useSettings();
  const { openLlmSettings } = useLlmSettings();
  const { theme, toggleTheme: toggle } = useTheme();
  const [commandOpen, setCommandOpen] = useState(false);
  const [panel, setPanel] = useState<"activity" | "insights" | "user" | null>(null);
  const activityRef = useRef<HTMLButtonElement>(null);
  const insightsRef = useRef<HTMLButtonElement>(null);
  const userRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const inChat = pathname.startsWith("/chats");
  const chatHref = projectId ? `/chats/${projectId}` : "/chats";

  return (
    <nav
      aria-label="Workspace"
      className={`shell-scroll flex h-full w-[60px] shrink-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden border-r border-line bg-panel py-3 ${
        mobile === "hidden"
          ? "max-[979px]:hidden"
          : "max-[979px]:h-14 max-[979px]:w-full max-[979px]:flex-row max-[979px]:overflow-x-auto max-[979px]:overflow-y-hidden max-[979px]:border-b max-[979px]:border-r-0 max-[979px]:px-3 max-[979px]:py-2"
      }`}
    >
      <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} />
      <Link
        href="/"
        aria-label="Fhara home"
        className="mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <Share2 size={18} strokeWidth={2} />
      </Link>
      <button
        type="button"
        onClick={openNewProject}
        aria-label="New project"
        title="New project"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <Plus size={18} strokeWidth={1.75} />
      </button>
      <span aria-hidden="true" className="my-2 h-px w-6 bg-line max-[979px]:hidden" />
      <RailButton icon={Home} label="Home" href="/" active={pathname === "/"} />
      <QueryBoundary fallback={<RailButton icon={Inbox} label="Inbox" href="/inbox" active={pathname === "/inbox"} />}>
        <InboxButton active={pathname === "/inbox"} />
      </QueryBoundary>
      <RailButton icon={Search} label="Search (⌘K)" onClick={() => setCommandOpen(true)} />
      <span aria-hidden="true" className="my-2 h-px w-6 bg-line max-[979px]:hidden" />
      <RailButton icon={MessagesSquare} label="Chats" href={chatHref} active={inChat} />
      <RailButton icon={Users} label="Team" href={projectId ? `/team?project=${projectId}` : "/team"} active={pathname === "/team"} />
      <RailButton icon={Building2} label="Office" href={projectId ? `/office?project=${projectId}` : "/office"} active={pathname === "/office"} />
      <RailButton icon={BookOpen} label="Library" href="/library" active={pathname === "/library"} />
      <RailButton icon={Brain} label="Memory" href={projectId ? `/memory?scope=project&project=${projectId}` : "/memory"} active={pathname === "/memory"} />
      <RailButton icon={GitBranch} label="Runs" href={projectId ? `/runs?project=${projectId}` : "/runs"} active={pathname.startsWith("/runs")} />
      <RailButton icon={FlaskConical} label="Playground" href="/playground" active={pathname === "/playground"} />
      <RailButton icon={Workflow} label="Workflow Studio" href="/workflows" active={pathname.startsWith("/workflows")} />
      <RailButton icon={Network} label="Knowledge Graph" href="/knowledge" active={pathname === "/knowledge"} />
      <RailButton icon={Siren} label="Incident Room" href={projectId ? `/incidents?project=${projectId}` : "/incidents"} active={pathname === "/incidents"} />
      <RailButton icon={TestTubes} label="Agent Sandbox" href="/sandbox" active={pathname === "/sandbox"} />
      <RailButton icon={FolderTree} label="Project Intelligence" href="/intelligence" active={pathname === "/intelligence"} />
      <RailButton icon={Globe} label="Browser Lab" href="/browser-lab" active={pathname === "/browser-lab"} />
      {projectId && (
        <>
          <RailButton icon={KanbanSquare} label="Board" href={`/chats/${projectId}?tab=tasks`} />
          <RailButton
            icon={Activity}
            label="Activity"
            buttonRef={activityRef}
            expanded={panel === "activity"}
            onClick={() => setPanel((p) => (p === "activity" ? null : "activity"))}
          />
        </>
      )}
      {/* Evaluations + Audit log share one rail slot to keep the rail short. */}
      <RailButton
        icon={BarChart3}
        label="Insights"
        buttonRef={insightsRef}
        expanded={panel === "insights"}
        active={pathname === "/evals" || pathname === "/audit" || pathname.startsWith("/incidents") || pathname === "/improve" || pathname === "/calibration"}
        onClick={() => setPanel((p) => (p === "insights" ? null : "insights"))}
      />
      <div className="mt-auto flex flex-col items-center gap-1 pt-3 max-[979px]:ml-auto max-[979px]:mt-0 max-[979px]:flex-row max-[979px]:pt-0">
        <RailButton icon={theme === "dark" ? Sun : Moon} label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggle} />
        <RailButton icon={Settings} label="Settings" onClick={openSettings} />
        <button
          ref={userRef}
          type="button"
          onClick={() => setPanel((p) => (p === "user" ? null : "user"))}
          aria-haspopup="menu"
          aria-expanded={panel === "user"}
          aria-label="Account"
          className="mt-1 flex h-9 w-9 shrink-0 max-[979px]:hidden items-center justify-center rounded-full bg-hover text-[12px] font-semibold text-ink-2 outline-none ring-1 ring-line transition hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          OA
        </button>
      </div>
      {panel === "activity" && projectId && (
        <RailPanel anchor={activityRef.current} onClose={() => setPanel(null)}>
          <ActivityFeed projectId={projectId} />
        </RailPanel>
      )}
      {panel === "insights" && (
        <RailPanel anchor={insightsRef.current} onClose={() => setPanel(null)} width={220}>
          <div role="menu" aria-label="Insights" className="p-1.5">
            {[
              { icon: BarChart3, label: "Evaluations", href: projectId ? `/evals?project=${projectId}` : "/evals", path: "/evals" },
              { icon: ScrollText, label: "Audit log", href: projectId ? `/audit?project=${projectId}` : "/audit", path: "/audit" },
              { icon: AlertTriangle, label: "Incidents", href: projectId ? `/incidents?project=${projectId}` : "/incidents", path: "/incidents" },
              { icon: Sparkles, label: "Improve", href: projectId ? `/improve?project=${projectId}` : "/improve", path: "/improve" },
              { icon: Scale, label: "Calibration", href: projectId ? `/calibration?project=${projectId}` : "/calibration", path: "/calibration" },
            ].map(({ icon: Icon, label, href, path }) => (
              <Link
                key={label}
                href={href}
                role="menuitem"
                aria-current={pathname === path ? "page" : undefined}
                onClick={() => setPanel(null)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-hover ${pathname === path ? "bg-hover" : ""}`}
              >
                <Icon size={15} className="text-ink-3" /> {label}
              </Link>
            ))}
          </div>
        </RailPanel>
      )}
      {panel === "user" && (
        <RailPanel anchor={userRef.current} onClose={() => setPanel(null)} width={232}>
          <div role="menu" aria-label="Account" className="p-1.5">
            <div className="px-2 py-2">
              <p className="text-[13px] font-semibold">Local user</p>
              <p className="text-xs text-ink-3">Single-user workspace</p>
            </div>
            <div className="my-1 h-px bg-line" />
            {[
              { icon: Settings, label: "Settings", run: openSettings },
              { icon: Cpu, label: "LLM settings", run: () => openLlmSettings(projectId) },
            ].map(({ icon: Icon, label, run }) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setPanel(null);
                  run();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-hover"
              >
                <Icon size={15} className="text-ink-3" /> {label}
              </button>
            ))}
            {[
              { icon: Lightbulb, label: "Ideas", href: "/ideas" },
              { icon: Plug, label: "Integrations", href: projectId ? `/integrations?project=${projectId}` : "/integrations" },
            ].map(({ icon: Icon, label, href }) => (
              <Link
                key={label}
                href={href}
                role="menuitem"
                onClick={() => setPanel(null)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-hover"
              >
                <Icon size={15} className="text-ink-3" /> {label}
              </Link>
            ))}
          </div>
        </RailPanel>
      )}
    </nav>
  );
}
