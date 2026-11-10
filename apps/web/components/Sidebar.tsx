"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Home, Inbox, Moon, PanelLeftClose, Search, Settings, Sun, X } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import AgentDetailPanel from "./AgentDetailPanel";
import { useNewProject } from "./NewProject";
import { useSettings } from "./Settings";
import { useToast } from "./Toasts";
import { useTheme } from "./ui/use-theme";
import QueryBoundary from "./shell/QueryBoundary";
import NeedsYou from "./sidebar/NeedsYou";
import ProjectList from "./sidebar/ProjectList";
import PersonalList from "./sidebar/PersonalList";
import TeamList, { type TeamAgent } from "./sidebar/TeamList";
import { CreateAgentModal } from "./sidebar/AgentForms";
import { roleLabel } from "@/lib/agentRoles";
import { onFocusTeam } from "@/lib/shellEvents";

type Sections = { needsYou: boolean; projects: boolean; personal: boolean; team: boolean };

export default function Sidebar({
  projectId,
  onSelectProject,
  drawerOpen = false,
  onCloseDrawer,
  onCollapse,
}: {
  projectId?: string;
  onSelectProject?: (id: string) => void;
  /** With `onCloseDrawer`, the sidebar is a slide-in drawer below 980px. */
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
  /** Desktop: hide the sidebar (the chat header offers to bring it back). */
  onCollapse?: () => void;
}) {
  const isDrawer = Boolean(onCloseDrawer);
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { openNewProject } = useNewProject();
  const { openSettings } = useSettings();
  const { theme, toggleTheme: toggle } = useTheme();
  const agents = useQuery(api.agents.list, {}) as (TeamAgent & Record<string, any>)[] | undefined;
  const removeProject = useMutation(api.projects.remove);
  const removeAgent = useMutation(api.agents.remove);

  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Sections>({ needsYou: true, projects: true, personal: true, team: true });
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const teamRef = useRef<HTMLElement>(null);
  const toggleSection = (key: keyof Sections) => setOpen((s) => ({ ...s, [key]: !s[key] }));

  // Drawer: Escape closes it.
  useEffect(() => {
    if (!isDrawer || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseDrawer?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isDrawer, drawerOpen, onCloseDrawer]);

  // Rail "Team" button: expand and reveal the team list.
  useEffect(
    () =>
      onFocusTeam(() => {
        setOpen((s) => ({ ...s, team: true }));
        requestAnimationFrame(() => teamRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }),
    [],
  );

  const runConfirmed = async (work: () => Promise<unknown>, success: [string, string?], failure: string) => {
    setConfirmPending(true);
    try {
      await work();
      toast("success", success[0], success[1]);
      setConfirmReq(null);
    } catch (err) {
      toast("error", failure, err instanceof Error ? err.message : "Please try again.");
    } finally {
      setConfirmPending(false);
    }
  };

  const askRemoveProject = (project: { _id: string; name: string }) =>
    setConfirmReq({
      title: `Delete project "${project.name}"?`,
      message: "This project and all of its tasks and history will be deleted permanently.",
      confirmLabel: "Delete project",
      onOk: () =>
        void runConfirmed(
          async () => {
            await removeProject({ projectId: project._id as never });
            if (projectId === project._id) router.push("/chats");
          },
          ["Project deleted", project.name],
          "Failed to delete project",
        ),
    });

  const askRemoveAgent = (agent: TeamAgent) => {
    const name = roleLabel(agent.role);
    setDetail(null);
    setConfirmReq({
      title: `Delete agent "${name}"?`,
      message: "This agent will also be removed from projects that use it.",
      confirmLabel: "Delete agent",
      onOk: () => void runConfirmed(() => removeAgent({ agentId: agent._id as never }), ["Agent deleted", name], "Failed to delete agent"),
    });
  };

  if (pathname === "/") return null;

  const base =
    "flex h-full w-[296px] shrink-0 flex-col border-r border-line bg-panel text-ink";
  const asideClass = isDrawer
    ? `${base} max-[979px]:fixed max-[979px]:inset-y-0 max-[979px]:left-0 max-[979px]:z-50 max-[979px]:w-[min(86vw,320px)] max-[979px]:shadow-2xl max-[979px]:pt-[env(safe-area-inset-top)] ${drawerOpen ? "" : "max-[979px]:hidden"}`
    : `${base} max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-r-0`;

  const mobileNav = [
    { icon: Home, label: "Home", href: "/" },
    { icon: Inbox, label: "Inbox", href: "/inbox" },
  ];

  return (
    <>
      {isDrawer && drawerOpen && (
        <div aria-hidden="true" onClick={onCloseDrawer} className="fixed inset-0 z-40 bg-black/40 min-[980px]:hidden" />
      )}
      <aside className={asideClass} aria-label="Projects and team" {...(isDrawer && drawerOpen ? { role: "dialog", "aria-modal": true } : {})}>
        <ConfirmDialog request={confirmReq} pending={confirmPending} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />

        {isDrawer && (
          // Phone: the rail is hidden, so the drawer carries the app nav.
          <div className="flex items-center gap-1 border-b border-line px-3 py-2 min-[980px]:hidden">
            {mobileNav.map(({ icon: Icon, label, href }) => (
              <Link key={href} href={href} onClick={onCloseDrawer} aria-label={label} className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
                <Icon size={18} />
              </Link>
            ))}
            <button type="button" onClick={() => openSettings()} aria-label="Settings" className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
              <Settings size={18} />
            </button>
            <button type="button" onClick={toggle} aria-label={theme === "dark" ? "Light mode" : "Dark mode"} className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button type="button" onClick={onCloseDrawer} aria-label="Close menu" className="ml-auto flex h-10 w-10 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink">
              <X size={18} />
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Hide sidebar"
              title="Hide sidebar"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 max-[979px]:hidden"
            >
              <PanelLeftClose size={17} strokeWidth={1.75} />
            </button>
          )}
          <label className="relative flex h-9 min-w-0 flex-1 items-center rounded-lg border border-line bg-panel transition focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/15">
            <Search size={15} className="pointer-events-none absolute left-2.5 text-ink-3" aria-hidden="true" />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              aria-label="Filter projects, messages and team"
              className="h-full w-full min-w-0 bg-transparent pl-8 pr-12 text-base text-ink outline-none placeholder:text-ink-3 sm:text-[14px]"
            />
            <kbd className="pointer-events-none absolute right-2 rounded border border-line px-1.5 py-px font-sans text-[10.5px] text-ink-3">⌘K</kbd>
          </label>
        </div>

        <div className="shell-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 pt-1">
          <QueryBoundary
            fallback={
              <Link href="/inbox" onClick={onCloseDrawer} className="flex h-7 items-center justify-between rounded-md px-2 text-[13px] text-ink-2 hover:text-ink">
                Needs you <span className="text-ink-3">Open inbox ›</span>
              </Link>
            }
          >
            <NeedsYou open={open.needsYou} onToggle={() => toggleSection("needsYou")} onNavigate={onCloseDrawer} />
          </QueryBoundary>
          <ProjectList
            filter={q}
            currentId={projectId}
            open={open.projects}
            onToggle={() => toggleSection("projects")}
            onAdd={openNewProject}
            onSelect={(id) => onSelectProject?.(id)}
            onRemove={askRemoveProject}
          />
          <QueryBoundary>
            <PersonalList filter={q} open={open.personal} onToggle={() => toggleSection("personal")} onNavigate={onCloseDrawer} />
          </QueryBoundary>
          <TeamList
            ref={teamRef}
            projectId={projectId}
            filter={q}
            open={open.team}
            onToggle={() => toggleSection("team")}
            onAdd={() => setCreateOpen(true)}
            onOpenAgent={(a) => setDetail(a)}
          />
        </div>

        {detail && (
          <AgentDetailPanel
            agent={(agents ?? []).find((a) => a._id === detail._id) ?? detail}
            onClose={() => setDetail(null)}
            onRemove={askRemoveAgent}
          />
        )}
      </aside>
    </>
  );
}
