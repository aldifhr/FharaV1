"use client";
import { FormEvent, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import InitialAvatar from "./InitialAvatar";
import Link from "next/link";
import Modal from "./Modal";
import { useRouter } from "next/navigation";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { useToast } from "./Toasts";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Check, Plus, Trash2, X, Dices, Pencil, ChevronDown, ArrowUp, Search, Hand, Mail } from "lucide-react";
import { useNewProject } from "./NewProject";
import AgentDetailPanel, { statusFromActive } from "./AgentDetailPanel";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { usePathname } from "next/navigation";
import { randomAvatartion, type AvatartionAvatar } from "./ui/avatartion";
import { AGENT_ROLES, roleLabel, ROLE_DEFAULT_PROMPTS } from "@/lib/agentRoles";
import { subscribeChatTyping } from "@/lib/chatTyping";
import { SkeletonBox } from "skullet/react";

// Touch / keyboard reachable row actions (were hover-only).
const ROW_ACTION_VISIBILITY =
  "hidden group-hover:inline-flex group-focus-within:inline-flex [@media(hover:none)]:inline-flex";

const PROJECT_COLORS = ["bg-sky-200 text-sky-900", "bg-emerald-200 text-emerald-900", "bg-violet-200 text-violet-900", "bg-amber-200 text-amber-900", "bg-rose-200 text-rose-900", "bg-teal-200 text-teal-900"];

function ProjectMark({ name, active = false }: { name: string; active?: boolean }) {
  const initial = (name.trim().charAt(0) || "•").toUpperCase();
  const color = PROJECT_COLORS[[...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % PROJECT_COLORS.length];
  return (
    <span
      aria-hidden="true"
      className={`mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${active ? "bg-[#5147b4] text-white" : color}`}
    >
      {initial}
    </span>
  );
}

function SectionHeader({ title, count, open, onToggle, onManage }: { title: string; count?: number; open: boolean; onToggle: () => void; onManage?: () => void }) {
  return (
    <div className="flex items-center justify-between px-1 py-1">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex items-center gap-1 rounded-md text-[13px] font-semibold text-[#24232d] outline-none hover:text-[#5147b4] focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-100">
        <span aria-hidden="true" className={`inline-block text-[9px] text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        {title}
        {count !== undefined && <span className="font-medium text-gray-500 dark:text-gray-400">{count}</span>}
      </button>
      <span className="flex items-center gap-1">
        {onManage && (
          <button type="button" onClick={onManage} aria-label={`Add to ${title}`} title={`Add to ${title}`} className="rounded-md p-1 text-gray-500 outline-none hover:bg-[#eeecfb] hover:text-[#5147b4] focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-800">
            <Plus size={14} />
          </button>
        )}
      </span>
    </div>
  );
}

export default function Sidebar({
  projectId,
  onSelectProject,
  drawerOpen = false,
  onCloseDrawer,
}: {
  projectId?: string;
  onSelectProject?: (id: string) => void;
  /** With `onCloseDrawer`, the sidebar is a slide-in drawer below 980px. */
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
}) {
  const isDrawer = Boolean(onCloseDrawer);
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const projects = useQuery(api.projects.list, {});
  const currentProject = useQuery(api.projects.get, projectId ? { projectId: projectId as never } : "skip");
  const agents = useQuery(api.agents.list, {});
  const llmProviders = useQuery(api.llmProviders.list, {});
  const llmModels = useQuery(api.llmModels.list, {});
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
  const activeTaskProjects = useQuery(api.tasks.activeTaskProjectIds, {});
  const hasActiveTask = new Set((activeTaskProjects ?? []).map((id: string) => String(id)));
  const pending = useQuery(api.approvals.listPendingAll, {});
  const approve = useMutation(api.approvals.approve);
  const reject = useMutation(api.approvals.reject);
  const hold = useMutation(api.approvals.hold);
  const createAgent = useMutation(api.agents.create);
  const updateAgent = useMutation(api.agents.update);
  const removeAgent = useMutation(api.agents.remove);
  const [isCreateAgentOpen, setIsCreateAgentOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  // LLM assignment (Phase 2 resolver): "" = unassigned (pool decides).
  const [agentLlmProviderId, setAgentLlmProviderId] = useState("");
  const [agentLlmModelId, setAgentLlmModelId] = useState("");
  const [agentLlmFallbackProviderId, setAgentLlmFallbackProviderId] = useState("");
  const [agentLlmFallbackModelId, setAgentLlmFallbackModelId] = useState("");
  const [agentLlmPolicy, setAgentLlmPolicy] = useState("");
  // Execution runtime: "" = worker default, "api" | "opencode" override.
  const [agentRuntime, setAgentRuntime] = useState("");
  const [agentOpencodeModel, setAgentOpencodeModel] = useState("");
  const [agentError, setAgentError] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [avatarSeed, setAvatarSeed] = useState<AvatartionAvatar | null>(null);
  const [removingAgentId, setRemovingAgentId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState({ needsYou: true, projects: true, team: true });
  const [teamShowAll, setTeamShowAll] = useState(false);
  const [projectsShowAll, setProjectsShowAll] = useState(false);
  const { openNewProject } = useNewProject();
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [draftingAgentIds, setDraftingAgentIds] = useState<string[]>([]);

  // Chat replies do not create execution leases; ChatPanel signals the selected
  // agents currently drafting a reply via a window event.
  useEffect(
    () => subscribeChatTyping((detail) => setDraftingAgentIds(detail.active ? detail.agentIds : [])),
    []
  );

  const [detailAgent, setDetailAgent] = useState<any>(null);
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);

  // Drawer: Escape closes it.
  useEffect(() => {
    if (!isDrawer || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseDrawer?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isDrawer, drawerOpen, onCloseDrawer]);
  const removeProject = useMutation(api.projects.remove);
  const router = useRouter();
  const toast = useToast();
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);

  const filteredProjects = (projects ?? []).filter((p: any) => p.name.toLowerCase().includes(q.toLowerCase()));
  const visibleAgents = agents ?? [];

  const previewAvatar = avatarSeed ?? undefined;

  const handleRandomizeAvatar = () => {
    setAvatarSeed(randomAvatartion());
  };

  const handleSelectRole = (value: string | null) => {
    setAgentRole(value ?? "");
    // Prefill the role's default system prompt so the user sees and can
    // tweak it before creating; the backend applies the same default
    // when the field is empty.
    setAgentPrompt(value ? (ROLE_DEFAULT_PROMPTS[value] ?? "") : "");
    if (value) setAgentError("");
  };

  async function handleCreateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAgentError("");
    if (!agentRole.trim()) {
      setAgentError("Role is required — pick a role from the dropdown");
      return;
    }
    setSavingAgent(true);
    try {
      // Role-only: name is auto-generated from the role label plus a suffix
      // when another agent already uses that role (e.g. "Frontend", "Frontend 2").
      const sameRoleCount = (agents ?? []).filter((a: any) => a.role === agentRole).length;
      const baseName = roleLabel(agentRole);
      const generatedName = sameRoleCount === 0 ? baseName : `${baseName} ${sameRoleCount + 1}`;
      await createAgent({
        name: generatedName,
        role: agentRole,
        ...(agentPrompt.trim() ? { systemPrompt: agentPrompt } : {}),
        // Keep the avatar the user generated in the preview.
        ...(avatarSeed
          ? {
              avatarParams: {
                face: avatarSeed.face,
                hair: avatarSeed.hair,
                eyes: avatarSeed.eyes,
                mouth: avatarSeed.mouth,
                outfit: avatarSeed.outfit,
                accessory: avatarSeed.accessory,
                facialHair: avatarSeed.facialHair,
                bg: avatarSeed.bg,
              },
            }
          : {}),
      });
      setAgentRole("");
      setAgentPrompt("");
      setAvatarSeed(null);
      setIsCreateAgentOpen(false);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSavingAgent(false);
    }
  }

  function openAgentEditor(agent: any) {
      setAgentError("");
      setEditingAgentId(agent._id);
      setAgentName(agent.name);
      setAgentRole(agent.role);
      setAgentPrompt(agent.systemPrompt ?? "");
      setAgentLlmProviderId(agent.llmProviderId ?? "");
      setAgentLlmModelId(agent.llmModelId ?? "");
      setAgentLlmFallbackProviderId(agent.llmFallbackProviderId ?? "");
      setAgentLlmFallbackModelId(agent.llmFallbackModelId ?? "");
      setAgentLlmPolicy(agent.llmSelectionPolicy ?? "");
      setAgentRuntime(agent.executionRuntime ?? "");
      setAgentOpencodeModel(agent.opencodeModel ?? "");
      setAvatarSeed(null);
  }

  function closeAgentEditor() {
      setEditingAgentId(null);
      setAvatarSeed(null);
      setAgentError("");
  }

  async function handleUpdateAgent(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!editingAgentId) return;
      if (!agentName.trim()) {
        setAgentError("Name is required");
        return;
      }
      if (!agentRole.trim()) {
        setAgentError("Role is required — pick a role from the dropdown");
        return;
      }
      setAgentError("");
      setSavingAgent(true);
      try {
        await updateAgent({
          agentId: editingAgentId as never,
          name: agentName,
          role: agentRole,
          systemPrompt: agentPrompt,
          // LLM assignment: an id sets it, null clears it (backend contract).
          llmProviderId: (agentLlmProviderId || null) as never,
          llmModelId: (agentLlmModelId || null) as never,
          llmFallbackProviderId: (agentLlmFallbackProviderId || null) as never,
          llmFallbackModelId: (agentLlmFallbackModelId || null) as never,
          llmSelectionPolicy: (agentLlmPolicy || null) as never,
          // Runtime: a value sets it, null clears it (worker default).
          executionRuntime: (agentRuntime || null) as never,
          opencodeModel: agentOpencodeModel.trim() || null,
          ...(avatarSeed
            ? {
                avatarParams: {
                  face: avatarSeed.face,
                  hair: avatarSeed.hair,
                  eyes: avatarSeed.eyes,
                  mouth: avatarSeed.mouth,
                  outfit: avatarSeed.outfit,
                  accessory: avatarSeed.accessory,
                  facialHair: avatarSeed.facialHair,
                  bg: avatarSeed.bg,
                },
              }
            : {}),
        });
        closeAgentEditor();
      } catch (err) {
        setAgentError(err instanceof Error ? err.message : "Failed to update agent");
      } finally {
        setSavingAgent(false);
      }
  }

  function toggleSection(key: keyof typeof openSections) {
    setOpenSections((s) => ({ ...s, [key]: !s[key] }));
  }

  const pendingByProject = new Map<string, number>();
  for (const a of pending ?? []) pendingByProject.set(a.projectId as string, (pendingByProject.get(a.projectId as string) ?? 0) + 1);

  async function confirmRemoveAgent(agentId: string, agentName: string) {
    setRemovingAgentId(agentId);
    try {
      await removeAgent({ agentId: agentId as never });
      toast("success", "Agent deleted", agentName);
      setConfirmReq(null);
    } catch (err) {
      toast("error", "Failed to delete agent", err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setRemovingAgentId(null);
    }
  }

  function handleRemoveAgent(agentId: string, agentName: string) {
    setConfirmReq({
      title: `Delete agent "${agentName}"?`,
      message: "This agent will also be removed from projects that use it.",
      onOk: () => { void confirmRemoveAgent(agentId, agentName); },
    });
  }

  async function confirmRemoveProject(projectToRemove: { _id: string; name: string }) {
    try {
      await removeProject({ projectId: projectToRemove._id as never });
      if (projectId === projectToRemove._id) router.push("/chats");
      toast("success", "Project deleted", projectToRemove.name);
      setConfirmReq(null);
    } catch (err) {
      toast("error", "Failed to delete project", err instanceof Error ? err.message : "Failed to delete project");
    }
  }

  function handleRemoveProject(projectToRemove: { _id: string; name: string }) {
    setConfirmReq({
      title: `Delete project "${projectToRemove.name}"?`,
      message: "This project and all of its tasks and history will be deleted permanently.",
      onOk: () => { void confirmRemoveProject(projectToRemove); },
    });
  }

  async function runApproval(approvalId: string, action: "approve" | "hold" | "reject") {
    setActingApprovalId(approvalId);
    setConfirmRejectId(null);
    try {
      if (action === "approve") await approve({ approvalId: approvalId as never });
      else if (action === "hold") {
        await hold({ approvalId: approvalId as never });
        toast("info", "Held", "The approval stays pending.");
      } else await reject({ approvalId: approvalId as never });
    } catch (err) {
      toast("error", `Couldn't ${action}`, err instanceof Error ? err.message : "Please try again.");
    } finally {
      setActingApprovalId(null);
    }
  }

  // Roles offered in the create/edit menus. A legacy role on an existing
  // agent stays selectable so editing it does not silently blank the field.
  const roleOptions: string[] =
    agentRole && !(AGENT_ROLES as readonly string[]).includes(agentRole) ? [...AGENT_ROLES, agentRole] : [...AGENT_ROLES];

  if (pathname === "/") return null;

  const asideClass = isDrawer
    ? // Phone: off-canvas drawer opened from the chat header's menu button.
      `flex h-full w-[270px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-[#e7e5ef] bg-white/70 px-3.5 py-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/70 max-[979px]:fixed max-[979px]:inset-y-0 max-[979px]:left-0 max-[979px]:z-50 max-[979px]:w-[min(86vw,320px)] max-[979px]:bg-white max-[979px]:pb-[max(1rem,env(safe-area-inset-bottom))] max-[979px]:pt-[max(1rem,env(safe-area-inset-top))] max-[979px]:shadow-2xl max-[979px]:dark:bg-gray-950 ${drawerOpen ? "" : "max-[979px]:hidden"}`
    : "flex h-full w-[270px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-[#e7e5ef] bg-white/70 px-3.5 py-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/70 max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-r-0";

  return (
    <>
    {isDrawer && drawerOpen && (
      <div aria-hidden="true" onClick={onCloseDrawer} className="fixed inset-0 z-40 bg-black/40 min-[980px]:hidden" />
    )}
    <aside className={asideClass} aria-label="Projects and team" {...(isDrawer && drawerOpen ? { role: "dialog", "aria-modal": true } : {})}>
      {isDrawer && (
        <div className="flex items-center justify-between min-[980px]:hidden">
          <span className="text-sm font-semibold">Workspace</span>
          <button type="button" onClick={onCloseDrawer} aria-label="Close menu" className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-300 dark:hover:bg-gray-800">
            <X size={18} />
          </button>
        </div>
      )}
      <ConfirmDialog request={confirmReq} pending={removingAgentId !== null} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <div className="relative shrink-0">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects"
          aria-label="Search projects"
          className="h-9 w-full rounded-xl border-[#e5e3eb] bg-white pl-8 pr-12 text-base sm:text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-400 dark:border-gray-700 dark:bg-gray-800">
          ⌘K
        </kbd>
      </div>

      <div>
        <SectionHeader title="Needs you" count={pending?.length ?? 0} open={openSections.needsYou} onToggle={() => toggleSection("needsYou")} />
        <AnimatePresence initial={false}>
        {openSections.needsYou && (pending ?? []).slice(0, 3).map((a: any) => {
          const agentRoleLabel = roleLabel((agents ?? []).find((ag: any) => ag._id === a.requestedByAgentId)?.role);
          const time = a._creationTime
            ? new Date(a._creationTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : "";
          const isEmailOrReply = a.kind === "support_reply" || a.summary?.toLowerCase().includes("email") || a.summary?.toLowerCase().includes("reply");
          return (
          <motion.div key={a._id} initial={{ opacity: 0, height: 0, y: -6 }} animate={{ opacity: 1, height: "auto", y: 0 }} exit={{ opacity: 0, height: 0, y: -6 }} className="overflow-hidden">
          <Card className="mt-2 border-[#ebe9f0] shadow-[0_1px_2px_rgba(30,25,60,.03)] dark:border-gray-800 dark:bg-gray-900">
            <CardContent className="p-3">
            <div className="flex items-start gap-2.5">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${isEmailOrReply ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400" : "bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400"}`}>
                {isEmailOrReply ? <Mail size={14} /> : <ArrowUp size={14} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug dark:text-white">{a.summary}</p>
                <p className="mt-0.5 text-xs text-gray-500">{agentRoleLabel ?? a.kind}{time ? ` · ${time}` : ""}</p>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2 pl-[38px]">
              <Button type="button" size="sm" disabled={actingApprovalId !== null} onClick={() => void runApproval(a._id, "approve")} className="bg-emerald-600 text-white hover:bg-emerald-700">
                <Check /> {actingApprovalId === a._id ? "Working…" : a.kind === "git_push" ? "Approve push" : isEmailOrReply ? "Approve reply" : "Approve"}
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={actingApprovalId !== null} onClick={() => void runApproval(a._id, "hold")}>
                <Hand size={13} /> Hold
              </Button>
              {confirmRejectId === a._id ? (
                <>
                  <Button type="button" size="sm" disabled={actingApprovalId !== null} onClick={() => void runApproval(a._id, "reject")} className="bg-red-600 text-white hover:bg-red-700">
                    Confirm reject
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRejectId(null)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button type="button" size="sm" variant="secondary" disabled={actingApprovalId !== null} onClick={() => setConfirmRejectId(a._id)}>
                  <X /> Reject
                </Button>
              )}
            </div>
            </CardContent>
          </Card>
          </motion.div>
          );
        })}
        </AnimatePresence>
        {openSections.needsYou && (pending?.length ?? 0) > 3 && (
          <Link href="/inbox" className="mt-2 block rounded-md px-1 text-xs font-medium text-[#5147b4] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-indigo-300">
            View all {pending?.length} in Inbox
          </Link>
        )}
        {openSections.needsYou && pending?.length === 0 && <p className="px-1 pt-2 text-xs text-gray-500 dark:text-gray-400">Nothing is waiting for approval.</p>}
      </div>

      <div>
        <SectionHeader title="Projects" open={openSections.projects} onToggle={() => toggleSection("projects")} onManage={openNewProject} />
        {openSections.projects && projects === undefined && (
          <div aria-hidden className="mt-2 space-y-2 px-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <SkeletonBox height={20} width={20} radius={6} />
                <SkeletonBox height={14} width={i === 1 ? "60%" : "45%"} />
              </div>
            ))}
          </div>
        )}
        {openSections.projects && projects !== undefined && filteredProjects.length === 0 && <p className="px-1 pt-2 text-xs text-gray-500 dark:text-gray-400">{q ? "No projects match." : "No projects yet."}</p>}
        <AnimatePresence initial={false}>
        {openSections.projects && (projectsShowAll ? filteredProjects : filteredProjects.slice(0, 7)).map((p: any) => {
          const isSelected = projectId === p._id;
          const pendingCount = pendingByProject.get(p._id);
          const isActive = hasActiveTask.has(String(p._id));
          const badgeText = pendingCount
            ? `${pendingCount} pending`
            : isSelected
              ? "current"
              : isActive
                ? "in progress"
                : "";
          return (
          <motion.div
            key={p._id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            className={`group mt-1 flex items-center justify-between rounded-lg px-2.5 py-2 text-sm transition hover:bg-[#f0eff7] dark:hover:bg-gray-800 dark:text-white ${isSelected ? "bg-[#eeecfb] font-semibold text-[#4c42a3] dark:bg-gray-800 dark:text-indigo-300" : "text-gray-600 dark:text-gray-300"}`}
          >
            <ProjectMark name={p.name} active={isSelected} />
            <Link
              href={`/chats/${p._id}`}
              onClick={() => onSelectProject?.(p._id)}
              aria-current={isSelected ? "page" : undefined}
              className="min-w-0 flex-1 truncate rounded outline-none focus-visible:ring-2 focus-visible:ring-[#635bff]/40"
            >
              {p.name}
            </Link>
            <span className="ml-2 flex shrink-0 items-center gap-1.5">
              {badgeText && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                isSelected
                  ? "bg-white/80 text-[#5147b4] shadow-xs dark:bg-gray-700 dark:text-indigo-200"
                  : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
              }`}>
                {badgeText}
              </span>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleRemoveProject(p)}
                      className={`${ROW_ACTION_VISIBILITY} text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-950/50`}
                      aria-label={`Delete ${p.name}`}
                    />
                  }
                >
                  <Trash2 />
                </TooltipTrigger>
                <TooltipContent>Delete project</TooltipContent>
              </Tooltip>
            </span>
          </motion.div>
          );
        })}
        </AnimatePresence>
        {openSections.projects && !projectsShowAll && filteredProjects.length > 7 && (
          <button type="button" onClick={() => setProjectsShowAll(true)} className="mt-1.5 flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-[#5147b4]">
            <span className="text-[9px]">▶</span> {filteredProjects.length - 7} more
          </button>
        )}
        {openSections.projects && projectsShowAll && filteredProjects.length > 7 && (
          <button type="button" onClick={() => setProjectsShowAll(false)} className="mt-1.5 flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-[#5147b4]">
            <span className="inline-block rotate-90 text-[9px]">▶</span> Show less
          </button>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between px-1">
          <button type="button" onClick={() => toggleSection("team")} aria-expanded={openSections.team} className="flex items-center gap-1 rounded-md text-[13px] font-semibold text-[#24232d] outline-none hover:text-[#5147b4] focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-100">
            <span aria-hidden="true" className={`inline-block text-[9px] text-gray-400 transition-transform ${openSections.team ? "rotate-90" : ""}`}>▶</span>
            Team
            <span className="font-medium text-gray-500 dark:text-gray-400">{visibleAgents.length}</span>
          </button>
          <span className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setIsCreateAgentOpen(true)}
                  className="text-gray-400 hover:bg-[#eeecfb] hover:text-[#5147b4]"
                  aria-label="Create agent"
                />
              }
            >
              <Plus />
            </TooltipTrigger>
            <TooltipContent>Create agent</TooltipContent>
          </Tooltip>
          </span>
        </div>
        {openSections.team && agents === undefined && (
          <div aria-hidden className="mt-2 space-y-2 px-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <SkeletonBox height={28} width={28} radius={999} />
                <div className="flex-1">
                  <SkeletonBox height={13} width={i === 1 ? "55%" : "70%"} />
                  <SkeletonBox height={11} width="35%" className="mt-1.5" />
                </div>
              </div>
            ))}
          </div>
        )}
        {(() => {
          const shown = teamShowAll ? visibleAgents : visibleAgents.slice(0, 7);
          const remaining = visibleAgents.length - shown.length;
          return (
          <>
          <AnimatePresence initial={false}>
            {openSections.team && shown.map((a: any) => {
          const active = (activeByAgent as any)?.[a._id as string] as { taskId: string; taskTitle: string; subtaskKey?: string; status: string } | undefined;
          // Status is derived from the backend execution lease, not the
          // persisted `agents.status` (which lumps idle agents as "working").
          // A chat reply has no execution lease; surface it as drafting so
          // the row stops showing idle mid-reply.
          const draftingReply = !active && draftingAgentIds.includes(a._id as string);
          const status = draftingReply
            ? { label: "Drafting reply", avatar: "working" as const }
            : statusFromActive(active);
          const isDisabled = a.isEnabled === false;
          const expanded = expandedAgentId === a._id;
          const projectCount = (projects ?? []).filter((p: any) => p.agentIds?.includes(a._id)).length;
          const statusText = isDisabled
            ? "disabled"
            : status.avatar === "needs_you"
              ? "needs you"
              : status.label.toLowerCase();
          const statusColor = isDisabled
            ? "text-gray-400"
            : status.avatar === "needs_you"
              ? "font-medium text-orange-500"
              : status.label === "Reviewing"
                ? "font-medium text-blue-500"
                : status.label === "Thinking"
                  ? "font-medium text-purple-500"
                  : status.avatar === "working"
                    ? "font-medium text-emerald-600 dark:text-emerald-400"
                    : "text-gray-400";
          return (
          <motion.div key={a._id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} className="mt-1 rounded-xl hover:bg-[#f0eff7] dark:hover:bg-gray-800">
            <div role="button" tabIndex={0} onClick={() => setDetailAgent(a)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setDetailAgent(a); }} aria-label={`${roleLabel(a.role)} details`} className="group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-white">
              <AgentAvatar name={roleLabel(a.role)} size={26} status={isDisabled ? undefined : status.avatar} avatarParams={a.avatarParams} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{roleLabel(a.role)}</span>
                <span className="block truncate text-[11px] capitalize text-gray-500 dark:text-gray-400">
                  {active ? (
                    <>
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        {status.label}
                      </span>
                      {" · "}
                      {active.taskTitle}
                      {active.subtaskKey ? ` · ${active.subtaskKey}` : ""}
                    </>
                  ) : isDisabled ? (
                    "Disabled"
                  ) : null}
                </span>
              </span>
              <span className={`w-[70px] shrink-0 text-right text-[11px] ${statusColor}`}>
                {statusText}
              </span>
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); setExpandedAgentId(expanded ? null : a._id); }}
                className="rounded p-1 text-gray-500 outline-none hover:bg-[#eeecfb] hover:text-[#5147b4] focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-700"
                title={expanded ? `Collapse ${roleLabel(a.role)}` : `Expand ${roleLabel(a.role)}`}
                aria-label={expanded ? `Collapse ${roleLabel(a.role)}` : `Expand ${roleLabel(a.role)}`}
                aria-expanded={expanded}
              >
                <ChevronDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); openAgentEditor(a); }}
                className={`${ROW_ACTION_VISIBILITY} rounded p-1 text-gray-500 outline-none hover:bg-[#eeecfb] hover:text-[#5147b4] focus-visible:ring-2 focus-visible:ring-[#635bff]/40 dark:text-gray-400 dark:hover:bg-gray-700`}
                title={`Edit ${roleLabel(a.role)}`}
                aria-label={`Edit ${roleLabel(a.role)}`}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleRemoveAgent(a._id, roleLabel(a.role));
                }}
                disabled={removingAgentId === a._id}
                className={`${ROW_ACTION_VISIBILITY} rounded p-1 text-gray-500 outline-none hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-400/50 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-red-950/50`}
                title={`Remove ${roleLabel(a.role)}`}
                aria-label={`Remove ${roleLabel(a.role)}`}
              >
                <X size={13} />
              </button>
            </div>
            {expanded && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <button type="button" onClick={() => setDetailAgent(a)} className="block w-full px-2 pb-2 pl-12 text-left text-[11px] text-gray-500 hover:text-[#5147b4] dark:text-gray-400">
                  <span className="block">{roleLabel(a.role)} · {status.label}</span>
                  {active && <span className="block truncate">On: {active.taskTitle}{active.subtaskKey ? ` · ${active.subtaskKey}` : ""}</span>}
                </button>
              </motion.div>
            )}
          </motion.div>
          );
        })}
        </AnimatePresence>
        {openSections.team && remaining > 0 && (
          <button type="button" onClick={() => setTeamShowAll(true)} className="mt-1.5 flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-[#5147b4]">
            <span className="text-[9px]">▶</span> {remaining} more
          </button>
        )}
        {openSections.team && teamShowAll && visibleAgents.length > 7 && (
          <button type="button" onClick={() => setTeamShowAll(false)} className="mt-1.5 flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-[#5147b4]">
            <span className="inline-block rotate-90 text-[9px]">▶</span> Show less
          </button>
        )}
          </>
          );
        })()}
        {openSections.team && (agents ?? []).length === 0 && agents !== undefined && (
          <p className="px-1 pt-2 text-xs text-gray-500 dark:text-gray-400">No agents yet.</p>
        )}
      </div>

      {detailAgent && (
        <AgentDetailPanel
          agent={detailAgent}
          onClose={() => setDetailAgent(null)}
          onEdit={(a: any) => { setDetailAgent(null); openAgentEditor(a); }}
        />
      )}

      {isCreateAgentOpen && (
        <Modal title="Create agent" onClose={() => setIsCreateAgentOpen(false)} maxWidth="max-w-lg">
          <form onSubmit={handleCreateAgent} className="mt-4 grid gap-3">
            <div className="grid gap-3">
              <div className="grid gap-1 text-sm">
                <span>Role</span>
                <Select value={agentRole} onValueChange={handleSelectRole}>
                  <SelectTrigger className="w-full rounded-lg border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <SelectValue placeholder="Select a role…" />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((role) => (
                      <SelectItem key={role} value={role}>
                        {roleLabel(role)}
                        {!(AGENT_ROLES as readonly string[]).includes(role) ? " (retired)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {agentRole && (
                  <p className="text-xs text-gray-500">
                    Agent name will be auto-generated:{" "}
                    {(() => {
                      const sameRoleCount = (agents ?? []).filter((a: any) => a.role === agentRole).length;
                      const baseName = roleLabel(agentRole);
                      return sameRoleCount === 0 ? baseName : `${baseName} ${sameRoleCount + 1}`;
                    })()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-700">
                <AgentAvatar name={agentRole ? roleLabel(agentRole) : "Agent"} size={48} avatar={avatarSeed ?? undefined} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-500">Preview uses the selected role. Use Generate to shuffle the SVGs.</p>
                </div>
                <button
                  type="button"
                  onClick={handleRandomizeAvatar}
                  title="Generate a new avatar"
                  aria-label="Generate a new avatar"
                  className="flex items-center gap-1.5 rounded-lg bg-[#6252d8] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5147b4]"
                >
                  <Dices size={14} />
                  Generate
                </button>
              </div>
              <label className="grid gap-1 text-sm">System prompt
                <textarea
                  value={agentPrompt}
                  onChange={(event) => setAgentPrompt(event.target.value)}
                  rows={5}
                  placeholder="Persona for this agent — prefilled from the selected role, editable before create. Leave empty to use the role default."
                  className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
                />
              </label>
              {agentError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{agentError}</p>}
              <button type="submit" disabled={savingAgent} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-gray-900">
                {savingAgent ? "Creating…" : "Create agent"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editingAgentId && (
        <Modal title={`Edit agent${agentName ? ` · ${agentName}` : ""}`} onClose={closeAgentEditor} fullScreen>
          <form onSubmit={handleUpdateAgent} className="mt-4 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">Name
                <input value={agentName} onChange={(event) => setAgentName(event.target.value)} required className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
              </label>
              <div className="grid gap-1 text-sm">
                <span>Role</span>
                <Select value={agentRole} onValueChange={handleSelectRole}>
                  <SelectTrigger className="w-full rounded-lg border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <SelectValue placeholder="Select a role…" />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((role) => (
                      <SelectItem key={role} value={role}>
                        {roleLabel(role)}
                        {!(AGENT_ROLES as readonly string[]).includes(role) ? " (retired)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label className="grid gap-1 text-sm">System prompt <span className="text-gray-400">(optional)</span>
              <textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} rows={4} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
            </label>
            <fieldset className="grid gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <legend className="px-1 text-xs font-semibold text-gray-500">LLM assignment <span className="font-normal text-gray-400">(optional — empty = pool default)</span></legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">Provider
                  <select value={agentLlmProviderId} onChange={(event) => { setAgentLlmProviderId(event.target.value); setAgentLlmModelId(""); }} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Pool (priority/weight)</option>
                    {(llmProviders ?? []).map((p: any) => (
                      <option key={p._id} value={p._id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">Model
                  <select value={agentLlmModelId} onChange={(event) => setAgentLlmModelId(event.target.value)} disabled={!agentLlmProviderId} className="rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">First available model</option>
                    {(llmModels ?? []).filter((m: any) => m.providerId === agentLlmProviderId).map((m: any) => (
                      <option key={m._id} value={m._id}>{m.displayName || m.modelId}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">Fallback provider
                  <select value={agentLlmFallbackProviderId} onChange={(event) => { setAgentLlmFallbackProviderId(event.target.value); setAgentLlmFallbackModelId(""); }} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">None (fall back to pool)</option>
                    {(llmProviders ?? []).map((p: any) => (
                      <option key={p._id} value={p._id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">Fallback model
                  <select value={agentLlmFallbackModelId} onChange={(event) => setAgentLlmFallbackModelId(event.target.value)} disabled={!agentLlmFallbackProviderId} className="rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">First available model</option>
                    {(llmModels ?? []).filter((m: any) => m.providerId === agentLlmFallbackProviderId).map((m: any) => (
                      <option key={m._id} value={m._id}>{m.displayName || m.modelId}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm sm:col-span-2">Selection policy
                  <select value={agentLlmPolicy} onChange={(event) => setAgentLlmPolicy(event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Default (weighted among equal priority)</option>
                    <option value="weighted">Weighted — weighted random among equal priority</option>
                    <option value="priority">Priority — always lowest priority, ignore weight</option>
                    <option value="fixed">Fixed — assigned model only, no pool fallback</option>
                  </select>
                </label>
              </div>
              <p className="text-xs text-gray-400">
                The resolver tries this assignment first, then its fallback, then the model pool. Connections with an open circuit (3x transient failures, 60s cooldown) are skipped automatically.
              </p>
            </fieldset>
            <fieldset className="grid gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <legend className="px-1 text-xs font-semibold text-gray-500">Runtime <span className="font-normal text-gray-400">(optional — empty = worker default)</span></legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">Execution runtime
                  <select value={agentRuntime} onChange={(event) => setAgentRuntime(event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Default (worker setting)</option>
                    <option value="api">API — MOAgent host tools</option>
                    <option value="opencode">OpenCode — native CLI in the task worktree</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">OpenCode model <span className="text-gray-400">(optional)</span>
                  <input value={agentOpencodeModel} onChange={(event) => setAgentOpencodeModel(event.target.value)} disabled={agentRuntime !== "opencode"} placeholder="provider/model" className="rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800" />
                </label>
              </div>
              <p className="text-xs text-gray-400">
                OpenCode runs its own tools inside the task worktree; changes still go through the staging gate and approval. Without a model it uses the same LLM as the rest of MOAgent. QA and review always run on the API runtime.
              </p>
            </fieldset>
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-700">
              <AgentAvatar name={agentName || "Agent"} size={48} avatar={avatarSeed ?? undefined} />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-500">Preview uses your current name. Use Generate to shuffle the SVGs.</p>
              </div>
              <button
                type="button"
                onClick={handleRandomizeAvatar}
                title="Generate a new avatar"
                aria-label="Generate a new avatar"
                className="flex items-center gap-1.5 rounded-lg bg-[#6252d8] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5147b4]"
              >
                <Dices size={14} />
                Generate
              </button>
            </div>
            {agentError && <p className="text-sm text-red-600">{agentError}</p>}
            <button type="submit" disabled={savingAgent} className="rounded-lg bg-[#6252d8] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {savingAgent ? "Saving…" : "Save changes"}
            </button>
          </form>
        </Modal>
      )}

    </aside>
    </>
  );
}
