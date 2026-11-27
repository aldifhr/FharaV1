
import { usePathname, useRouter } from "@/lib/spaRouter";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@fhara/runtime/react";
import { Activity, BookOpen, Brain, FlaskConical, Home, Inbox, Menu, Plug, Plus, ScrollText, Sparkles, X } from "lucide-react";
import { api } from "@fhara/runtime/api";
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
import { InboxNav, NavRow, RailItem } from "./sidebar/SidebarNav";
import { sidebarNavLinks } from "./sidebar/navLinks";
import { Logo, SearchBox, SidebarHeader, useShellChords } from "./sidebar/SidebarChrome";
import { agentName } from "@/lib/agentRoles";
import { useOptionalWorkspace } from "@/app/WorkspaceContext";
import { useUiPref } from "@/lib/uiPrefs";
import { DESKTOP_QUERY, useMediaQuery } from "@/lib/useMediaQuery";

type Sections = { needsYou: boolean; projects: boolean; team: boolean };

/**
 * The one app navigation (plan 067, mockup parity): a persistent icon rail —
 * logo, new project, inbox, activity, settings + account at the bottom — beside
 * the expandable sidebar with the search (⌘K), Inbox / Needs you, WORK
 * (projects, team), and DEVELOPMENT.
 * Build, development, and observe destinations live on the rail. The sidebar
 * folds on desktop (remembered in uiPrefs); below 980px it is a drawer and the
 * rail hides.
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
  /** Below 980px: a drawer behind a top bar (default), or the lists inline as the page. */
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
            if (projectId === project._id) router.push("/");
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

  const { development } = sidebarNavLinks({ pathname, projectId });
  const inboxActive = pathname === "/inbox";
  const activity = (
    <NavRow icon={Activity} label="Activity" buttonRef={activityRef} expanded={activityOpen} onClick={() => setActivityOpen((v) => !v)} />
  );

  // The content pane folds on desktop; the rail's PanelLeft button expands it.
  const contentHidden = isDesktop && collapsedPref;
  const base = "flex h-full w-sidebar shrink-0 flex-col border-r border-line bg-panel text-ink";
  const asideClass =
    mobile === "inline"
      ? `${base} ${contentHidden ? "max-[979px]:flex hidden" : "flex"} max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-r-0`
      : `${base} ${contentHidden ? "max-[979px]:flex hidden" : "flex"} max-[979px]:fixed max-[979px]:inset-y-0 max-[979px]:left-0 max-[979px]:z-50 max-[979px]:w-[min(86vw,320px)] max-[979px]:shadow-2xl max-[979px]:pt-[env(safe-area-inset-top)] ${drawerOpen ? "" : "max-[979px]:hidden"}`;

  return (
    <>
      <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} projectId={projectId} />

      {/* Plan 067: the persistent app rail (logo, new project, inbox, DMs,
          activity; settings + account at the bottom). It always shows on
          desktop — the sidebar folds beside it instead of replacing it. */}
      <aside aria-label="App rail" className="shell-scroll flex h-full w-sidebar-rail shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-line bg-panel py-4 max-[979px]:hidden">
        <Logo onNavigate={closeDrawer} />
        <RailItem icon={Plus} label="New project" onClick={() => { setCollapsedPref(false); openNewProject(); }} />
        <span aria-hidden="true" className="my-1 h-px w-6 bg-line" />
        <RailItem icon={Home} label="Home" href="/" active={pathname === "/"} />
        <QueryBoundary fallback={<RailItem icon={Inbox} label="Inbox" href="/inbox" active={inboxActive} />}>
          <InboxNav icon={Inbox} active={inboxActive} rail />
        </QueryBoundary>
        <SearchBox rail chord={chord} onOpen={openCommand} collapsed={collapsedPref} onToggleCollapsed={() => setCollapsedPref(false)} />
        {development.map((item) => (
          <RailItem key={item.label} {...item} />
        ))}
        <RailItem icon={BookOpen} label="Library" href={projectId ? `/library?project=${projectId}` : "/library"} active={pathname === "/library"} />
        <RailItem icon={Brain} label="Memory" href={projectId ? `/memory?scope=project&project=${projectId}` : "/memory"} active={pathname.startsWith("/memory")} />
        <RailItem icon={FlaskConical} label="Sandbox" href={projectId ? `/sandbox?project=${projectId}` : "/sandbox"} active={pathname === "/sandbox"} />
        <RailItem icon={ScrollText} label="Audit log" href={projectId ? `/audit?project=${projectId}` : "/audit"} active={pathname === "/audit"} />
        {projectId ? (
          <RailItem icon={Activity} label="Activity" buttonRef={activityRef} expanded={activityOpen} onClick={() => setActivityOpen((v) => !v)} />
        ) : null}
        <RailItem icon={Sparkles} label="Improve" href={projectId ? `/improve?project=${projectId}` : "/improve"} active={pathname.startsWith("/improve")} />
        <RailItem icon={Plug} label="Integrations" href="/integrations" active={pathname.startsWith("/integrations")} />
        <div className="mt-auto flex flex-col items-center gap-1">
          <RailItem icon={SettingsIcon} label="Settings" onClick={openShellSettings} />
        </div>
        {activityOpen && projectId && <ActivityPopover anchor={activityRef.current} projectId={projectId} onClose={() => setActivityOpen(false)} />}
      </aside>

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

        <div className="flex flex-col gap-3 pb-2 pt-3 px-3">
          <div className="flex items-start gap-1">
            {!isDesktop && <div className="min-w-0 flex-1"><SidebarHeader collapsed={false} onNavigate={closeDrawer} /></div>}
            {isDrawer && drawerOpen && (
              <button type="button" onClick={closeDrawer} aria-label="Close menu" className="flex h-9 w-9 items-center justify-center rounded-field text-ink-2 hover:bg-hover hover:text-ink min-[980px]:hidden">
                <X size={18} />
              </button>
            )}
          </div>
          <SearchBox chord={chord} onOpen={openCommand} {...(isDesktop ? { onToggleCollapsed: () => setCollapsedPref(true) } : {})} />
        </div>

        <nav aria-label="Workspace" className="shell-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4 pt-1">
          <div className="flex flex-col gap-3">
            <QueryBoundary
              fallback={
                <NavRow icon={Inbox} label="Needs you" href="/inbox" onClick={closeDrawer} />
              }
            >
              <NeedsYou open={open.needsYou} onToggle={() => toggleSection("needsYou")} onNavigate={closeDrawer} />
            </QueryBoundary>
          </div>
          <div className="flex flex-col gap-4">
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
              projectId={projectId}
              filter=""
              open={open.team}
              onToggle={() => toggleSection("team")}
              onAdd={() => setCreateOpen(true)}
              onOpenAgent={(a) => setDetail(a)}
            />
          </div>
        </nav>

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

/** Settings icon re-exported for the rail (kept local to avoid a broad import). */
import { Settings as SettingsIcon } from "lucide-react";
