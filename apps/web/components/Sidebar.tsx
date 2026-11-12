"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Activity, FolderKanban, Inbox, Menu, MessageCircle, Users, X } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import AgentDetailPanel from "./AgentDetailPanel";
import CommandMenu from "./CommandMenu";
import { useNewProject } from "./NewProject";
import { useSettings } from "./Settings";
import { useToast } from "./Toasts";
import QueryBoundary from "./shell/QueryBoundary";
import NeedsYou from "./sidebar/NeedsYou";
import ProjectList from "./sidebar/ProjectList";
import TeamList, { type TeamAgent } from "./sidebar/TeamList";
import { CreateAgentModal } from "./sidebar/AgentForms";
import ActivityPopover from "./sidebar/ActivityPopover";
import { InboxNav, NavGroup, NavRow, RailItem } from "./sidebar/SidebarNav";
import { sidebarNavLinks } from "./sidebar/navLinks";
import { AccountRow, SearchBox, SidebarHeader, useShellChords } from "./sidebar/SidebarChrome";
import { agentName } from "@/lib/agentRoles";
import { useOptionalWorkspace } from "@/app/WorkspaceContext";
import { onFocusTeam } from "@/lib/shellEvents";
import { useUiPref } from "@/lib/uiPrefs";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/useMediaQuery";

type Sections = { needsYou: boolean; projects: boolean; team: boolean };

/**
 * The one app sidebar (dashboard restyle F2): logo and collapse, search (⌘K),
 * Inbox / Personal messages / Needs you, then WORK (projects,
 * team), BUILD, DEVELOPMENT and OBSERVE, with the account row at the bottom.
 * Collapses to an icon rail on desktop (remembered in uiPrefs); below 980px it
 * is a drawer.
 */
export default function Sidebar({
  projectId,
  onSelectProject,
  drawerOpen: drawerOpenProp,
  onCloseDrawer: onCloseDrawerProp,
  mobile = "drawer",
}: {
  projectId?: string;
  onSelectProject?: (id: string) => void;
  /** With `onCloseDrawer`, the page owns the phone drawer (its header has the menu button). */
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
  /** Below 980px: a drawer behind a top bar (default), or the lists inline as the page (/chats). */
  mobile?: "drawer" | "inline";
}) {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { openNewProject } = useNewProject();
  const { openSettings } = useSettings();
  const isDesktop = useMediaQuery(DESKTOP_QUERY, true);
  const workspace = useOptionalWorkspace();
  const [collapsedPref, setCollapsedPref] = useUiPref("sidebarCollapsed");
  const rail = isDesktop && collapsedPref;
  const agents = useQuery(api.agents.list, {}) as (TeamAgent & Record<string, any>)[] | undefined;
  const removeProject = useMutation(api.projects.remove);
  const removeAgent = useMutation(api.agents.remove);

  const ownsDrawer = !onCloseDrawerProp;
  const [ownDrawerOpen, setOwnDrawerOpen] = useState(false);
  const drawerOpen = ownsDrawer ? ownDrawerOpen : Boolean(drawerOpenProp);
  const closeDrawer = useCallback(() => (ownsDrawer ? setOwnDrawerOpen(false) : onCloseDrawerProp?.()), [ownsDrawer, onCloseDrawerProp]);
  const isDrawer = mobile === "drawer";

  const [open, setOpen] = useState<Sections>({ needsYou: true, projects: true, team: true });
  const [commandOpen, setCommandOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const teamRef = useRef<HTMLElement>(null);
  const activityRef = useRef<HTMLButtonElement>(null);
  const toggleSection = (key: keyof Sections) => setOpen((s) => ({ ...s, [key]: !s[key] }));

  const openCommand = useCallback(() => setCommandOpen(true), []);
  const openShellSettings = useCallback(() => openSettings(projectId), [openSettings, projectId]);
  const chord = useShellChords(openCommand, openShellSettings);

  // A route change closes the phone drawer this sidebar owns.
  useEffect(() => setOwnDrawerOpen(false), [pathname]);

  // Drawer: Escape closes it.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeDrawer();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  // "Team" requests from elsewhere: expand and reveal the team list.
  useEffect(
    () =>
      onFocusTeam(() => {
        setCollapsedPref(false);
        setOpen((s) => ({ ...s, team: true }));
        requestAnimationFrame(() => teamRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }),
    [setCollapsedPref],
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
    const name = agentName(agent);
    setDetail(null);
    setConfirmReq({
      title: `Delete agent "${name}"?`,
      message: "This agent will also be removed from projects that use it.",
      confirmLabel: "Delete agent",
      onOk: () => void runConfirmed(() => removeAgent({ agentId: agent._id as never }), ["Agent deleted", name], "Failed to delete agent"),
    });
  };

  const expandTo = (section: keyof Sections) => () => {
    setCollapsedPref(false);
    setOpen((s) => ({ ...s, [section]: true }));
  };

  const { build, development, observe, teamHref } = sidebarNavLinks({ pathname, projectId });
  const inboxActive = pathname === "/inbox";
  const activity = projectId ? (
    rail ? (
      <RailItem icon={Activity} label="Activity" buttonRef={activityRef} expanded={activityOpen} onClick={() => setActivityOpen((v) => !v)} />
    ) : (
      <NavRow icon={Activity} label="Activity" buttonRef={activityRef} expanded={activityOpen} onClick={() => setActivityOpen((v) => !v)} />
    )
  ) : null;
  const inboxFallback = rail ? (
    <RailItem icon={Inbox} label="Inbox" href="/inbox" active={inboxActive} />
  ) : (
    <NavRow icon={Inbox} label="Inbox" href="/inbox" active={inboxActive} />
  );

  const width = rail ? "w-sidebar-rail" : "w-sidebar";
  const base = `flex h-full ${width} shrink-0 flex-col border-r border-line bg-panel text-ink`;
  const asideClass =
    mobile === "inline"
      ? `${base} max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-r-0`
      : `${base} max-[979px]:fixed max-[979px]:inset-y-0 max-[979px]:left-0 max-[979px]:z-50 max-[979px]:w-[min(86vw,320px)] max-[979px]:shadow-2xl max-[979px]:pt-[env(safe-area-inset-top)] ${drawerOpen ? "" : "max-[979px]:hidden"}`;

  return (
    <>
      <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} projectId={projectId} />
      {isDrawer && ownsDrawer && (
        // Phone: a slim top bar with the menu button; the sidebar opens as a drawer.
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 pt-[env(safe-area-inset-top)] min-[980px]:hidden">
          <button
            type="button"
            onClick={() => setOwnDrawerOpen(true)}
            aria-label="Open menu"
            className="flex h-10 w-10 items-center justify-center rounded-field text-ink-2 hover:bg-hover hover:text-ink"
          >
            <Menu size={18} strokeWidth={1.75} />
          </button>
          <span className="text-[15px] font-semibold tracking-tight">Fhara</span>
          <div className="ml-auto w-40">
            <SearchBox chord={chord} onOpen={openCommand} />
          </div>
        </div>
      )}
      {isDrawer && drawerOpen && <div aria-hidden="true" onClick={closeDrawer} className="fixed inset-0 z-40 bg-black/40 min-[980px]:hidden" />}
      <aside className={asideClass} aria-label="Navigation" {...(isDrawer && drawerOpen ? { role: "dialog", "aria-modal": true } : {})}>
        <ConfirmDialog request={confirmReq} pending={confirmPending} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />

        <div className={`flex flex-col gap-3 pb-2 pt-3 ${rail ? "items-center px-2" : "px-3"}`}>
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <SidebarHeader collapsed={rail} onToggleCollapsed={isDesktop ? () => setCollapsedPref(!collapsedPref) : undefined} onNavigate={closeDrawer} />
            </div>
            {isDrawer && drawerOpen && (
              <button type="button" onClick={closeDrawer} aria-label="Close menu" className="flex h-9 w-9 items-center justify-center rounded-field text-ink-2 hover:bg-hover hover:text-ink min-[980px]:hidden">
                <X size={18} />
              </button>
            )}
          </div>
          <SearchBox chord={chord} onOpen={openCommand} rail={rail} />
        </div>

        {rail ? (
          <nav aria-label="Workspace" className="shell-scroll flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 pb-3 pt-1">
            <QueryBoundary fallback={inboxFallback}>
              <InboxNav icon={Inbox} active={inboxActive} rail />
            </QueryBoundary>
            <RailItem
              icon={MessageCircle}
              label="Direct Messages"
              href="/messages"
              active={pathname.startsWith("/messages") || pathname.startsWith("/message")}
            />
            <span aria-hidden="true" className="my-1.5 h-px w-6 bg-line" />
            <RailItem icon={FolderKanban} label="Projects" onClick={expandTo("projects")} active={pathname.startsWith("/project/") || pathname.startsWith("/chats/")} />
            <RailItem icon={Users} label="Team" href={teamHref} active={pathname.startsWith("/team")} />
            <span aria-hidden="true" className="my-1.5 h-px w-6 bg-line" />
            {build.map((item) => (
              <RailItem key={item.label} {...item} />
            ))}
            <span aria-hidden="true" className="my-1.5 h-px w-6 bg-line" />
            {development.map((item) => (
              <RailItem key={item.label} {...item} />
            ))}
            <span aria-hidden="true" className="my-1.5 h-px w-6 bg-line" />
            {observe.map((item) => (
              <RailItem key={item.label} {...item} />
            ))}
            {activity}
          </nav>
        ) : (
          <nav aria-label="Workspace" className="shell-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4 pt-1">
            <div className="flex flex-col gap-3">
              <QueryBoundary
                fallback={<NavRow icon={Inbox} label="Inbox" href="/inbox" onClick={closeDrawer} />}
              >
                <InboxNav icon={Inbox} active={inboxActive} rail={false} onNavigate={closeDrawer} />
              </QueryBoundary>
              <NavRow
                icon={MessageCircle}
                label="Personal messages"
                href="/messages"
                active={pathname.startsWith("/messages") || pathname.startsWith("/message")}
                onClick={closeDrawer}
              />
              <QueryBoundary
                fallback={
                  <NavRow icon={Inbox} label="Needs you" href="/inbox" onClick={closeDrawer} />
                }
              >
                <NeedsYou open={open.needsYou} onToggle={() => toggleSection("needsYou")} onNavigate={closeDrawer} />
              </QueryBoundary>
            </div>
            <NavGroup label="Work">
              <ProjectList
                filter=""
                currentId={projectId}
                open={open.projects}
                onToggle={() => toggleSection("projects")}
                onAdd={openNewProject}
                onSelect={(id) => {
                  onSelectProject?.(id);
                  closeDrawer();
                  // Same project: the row is the project chat, so close the open thread.
                  if (workspace?.projectId === id) workspace.closeThread();
                }}
                onRemove={askRemoveProject}
              />
              <TeamList
                ref={teamRef}
                projectId={projectId}
                filter=""
                open={open.team}
                onToggle={() => toggleSection("team")}
                onAdd={() => setCreateOpen(true)}
                onOpenAgent={(a) => setDetail(a)}
              />
            </NavGroup>
            <NavGroup label="Build">
              {build.map((item) => (
                <NavRow key={item.label} {...item} onClick={item.onClick ?? closeDrawer} />
              ))}
            </NavGroup>
            <NavGroup label="Development">
              {development.map((item) => (
                <NavRow key={item.label} {...item} onClick={item.onClick ?? closeDrawer} />
              ))}
            </NavGroup>
            <NavGroup label="Observe">
              {observe.map((item) => (
                <NavRow key={item.label} {...item} onClick={closeDrawer} />
              ))}
              {activity}
            </NavGroup>
          </nav>
        )}

        <div className={`shrink-0 border-t border-line p-2 ${rail ? "flex justify-center" : ""}`}>
          <AccountRow rail={rail} onSettings={openShellSettings} onAccount={() => openSettings(projectId, "signin")} />
        </div>

        {activityOpen && projectId && <ActivityPopover anchor={activityRef.current} projectId={projectId} onClose={() => setActivityOpen(false)} />}
        {createOpen && <CreateAgentModal onClose={() => setCreateOpen(false)} />}
        {detail && (
          <AgentDetailPanel
            agent={(agents ?? []).find((a) => a._id === detail._id) ?? detail}
          projectId={projectId}
            onClose={() => setDetail(null)}
            onRemove={askRemoveAgent}
          />
        )}
      </aside>
    </>
  );
}
