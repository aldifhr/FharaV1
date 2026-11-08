"use client";
import { FormEvent, useState } from "react";
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
import { roleLabel } from "@/lib/agentRoles";
import { SkeletonBox } from "skullet/react";

const AGENT_ROLES = [
  "lead",
  "cto",
  "designer",
  "frontend",
  "backend",
  "qa",
  "growth",
  "support",
  "reviewer",
  "devops",
  "researcher",
  "product-analyst",
  "ui-ux",
] as const;

export default function Sidebar({ projectId, onSelectProject }: { projectId?: string; onSelectProject?: (id: string) => void }) {
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const projects = useQuery(api.projects.list, {});
  const currentProject = useQuery(api.projects.get, projectId ? { projectId: projectId as never } : "skip");
  const agents = useQuery(api.agents.list, {});
  const llmProviders = useQuery(api.llmProviders.list, {});
  const llmModels = useQuery(api.llmModels.list, {});
  const activeByAgent = useQuery(api.executionView.activeByAgent, {});
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
  const [agentError, setAgentError] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [avatarSeed, setAvatarSeed] = useState<AvatartionAvatar | null>(null);
  const [removingAgentId, setRemovingAgentId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState({ needsYou: true, projects: true, team: true });
  const [teamShowAll, setTeamShowAll] = useState(false);
  const { openNewProject } = useNewProject();
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [detailAgent, setDetailAgent] = useState<any>(null);
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

  const SectionHeader = ({ key_, title, count, onManage }: { key_: keyof typeof openSections; title: string; count?: number; onManage?: () => void }) => (
    <div className="flex items-center justify-between px-1 py-1">
      <button type="button" onClick={() => toggleSection(key_)} className="flex items-center gap-1 text-[13px] font-semibold text-[#24232d] hover:text-[#5147b4] dark:text-gray-100">
        <span className={`inline-block text-[9px] text-gray-400 transition-transform ${openSections[key_] ? "rotate-90" : ""}`}>▶</span>
        {title}
        {count !== undefined && <span className="font-medium text-gray-400 dark:text-gray-500">{count}</span>}
      </button>
      <span className="flex items-center gap-1">
        {onManage && (
          <button type="button" onClick={onManage} aria-label={`Manage ${title}`} title={`Manage ${title}`} className="rounded-md p-1 text-gray-400 hover:bg-[#eeecfb] hover:text-[#5147b4]">
            <Plus size={14} />
          </button>
        )}
      </span>
    </div>
  );

  if (pathname === "/") return null;

  const PROJECT_COLORS = ["bg-sky-200 text-sky-900", "bg-emerald-200 text-emerald-900", "bg-violet-200 text-violet-900", "bg-amber-200 text-amber-900", "bg-rose-200 text-rose-900", "bg-teal-200 text-teal-900"];
  const ProjectMark = ({ name, active = false }: { name: string; active?: boolean }) => {
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
  };

  return (
    <aside className="flex h-full w-[270px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-[#e7e5ef] bg-white/70 px-3.5 py-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/70 max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-r-0">
      <ConfirmDialog request={confirmReq} pending={removingAgentId !== null} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <div className="relative shrink-0">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="h-9 w-full rounded-xl border-[#e5e3eb] bg-white pl-8 pr-12 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-400 dark:border-gray-700 dark:bg-gray-800">
          ⌘K
        </kbd>
      </div>

      <div>
        <SectionHeader key_="needsYou" title="Needs you" count={pending?.length ?? 0} />
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
              <Button type="button" size="sm" onClick={() => approve({ approvalId: a._id })} className="bg-emerald-600 text-white hover:bg-emerald-700">
                <Check /> {a.kind === "git_push" ? "Approve push" : isEmailOrReply ? "Approve reply" : "Approve"}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => hold({ approvalId: a._id })}>
                <Hand size={13} /> Hold
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => reject({ approvalId: a._id })}>
                <X /> Reject
              </Button>
            </div>
            </CardContent>
          </Card>
          </motion.div>
          );
        })}
        </AnimatePresence>
        {openSections.needsYou && pending?.length === 0 && <p className="px-1 pt-2 text-xs text-gray-400">Nothing is waiting for approval.</p>}
      </div>

      <div>
        <SectionHeader key_="projects" title="Projects" onManage={openNewProject} />
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
        {openSections.projects && projects !== undefined && filteredProjects.length === 0 && <p className="px-1 pt-2 text-xs text-gray-400">No projects yet.</p>}
        <AnimatePresence initial={false}>
        {openSections.projects && filteredProjects.map((p: any) => {
          const isSelected = projectId === p._id;
          const pendingCount = pendingByProject.get(p._id);
          const badgeText = pendingCount ? `${pendingCount} pending` : isSelected ? "+3 files" : p.status === "done" ? "shipped" : "in progress";
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
              className="min-w-0 flex-1 truncate"
            >
              {p.name}
            </Link>
            <span className="ml-2 flex shrink-0 items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                isSelected
                  ? "bg-white/80 text-[#5147b4] shadow-xs dark:bg-gray-700 dark:text-indigo-200"
                  : badgeText === "shipped"
                    ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
                    : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
              }`}>
                {badgeText}
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleRemoveProject(p)}
                      className="hidden text-gray-400 hover:bg-red-50 hover:text-red-600 group-hover:inline-flex"
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
      </div>

      <div>
        <div className="flex items-center justify-between px-1">
          <button type="button" onClick={() => toggleSection("team")} className="flex items-center gap-1 text-[13px] font-semibold text-[#24232d] hover:text-[#5147b4] dark:text-gray-100">
            <span className={`inline-block text-[9px] text-gray-400 transition-transform ${openSections.team ? "rotate-90" : ""}`}>▶</span>
            Team
            <span className="font-medium text-gray-400 dark:text-gray-500">{visibleAgents.length}</span>
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
          const shown = teamShowAll ? visibleAgents : visibleAgents.slice(0, 10);
          const remaining = visibleAgents.length - shown.length;
          return (
          <>
          <AnimatePresence initial={false}>
            {openSections.team && shown.map((a: any) => {
          const active = (activeByAgent as any)?.[a._id as string] as { taskId: string; taskTitle: string; subtaskKey?: string; status: string } | undefined;
          // Status is derived from the backend execution lease, not the
          // persisted `agents.status` (which lumps idle agents as "working").
          const status = statusFromActive(active);
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
            <div role="button" tabIndex={0} onClick={() => setDetailAgent(a)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setDetailAgent(a); }} className="group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 dark:text-white">
              <AgentAvatar name={roleLabel(a.role)} size={26} status={isDisabled ? undefined : status.avatar} avatarParams={a.avatarParams} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{roleLabel(a.role)}</span>
                <span className="block truncate text-[11px] capitalize text-gray-400">
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
                className="rounded px-1 text-gray-400 hover:bg-[#eeecfb] hover:text-[#5147b4]"
                title={expanded ? `Collapse ${roleLabel(a.role)}` : `Expand ${roleLabel(a.role)}`}
                aria-label={expanded ? `Collapse ${roleLabel(a.role)}` : `Expand ${roleLabel(a.role)}`}
                aria-expanded={expanded}
              >
                <ChevronDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); openAgentEditor(a); }}
                className="hidden rounded px-1 text-gray-400 hover:bg-[#eeecfb] hover:text-[#5147b4] group-hover:block"
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
                className="hidden rounded px-1 text-xs text-gray-400 hover:bg-red-50 hover:text-red-600 group-hover:block disabled:opacity-50"
                title={`Remove ${roleLabel(a.role)}`}
                aria-label={`Remove ${roleLabel(a.role)}`}
              >
                ×
              </button>
            </div>
            {expanded && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <button type="button" onClick={() => setDetailAgent(a)} className="block w-full px-2 pb-2 pl-12 text-left text-[11px] text-gray-500 hover:text-[#5147b4] dark:text-gray-400">
                  <span className="block">{roleLabel(a.role)} · {status.label}</span>
                  {active && <span className="block truncate">On: {active.taskTitle}{active.subtaskKey ? ` · ${active.subtaskKey}` : ""}</span>}
                  <span className="block">
                    {projectCount} project{projectCount === 1 ? "" : "s"} · {(a.supportedTools ?? a.capabilities ?? []).length} tool/capability entries · click for full detail
                  </span>
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
        {openSections.team && teamShowAll && visibleAgents.length > 10 && (
          <button type="button" onClick={() => setTeamShowAll(false)} className="mt-1.5 flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-400 hover:text-[#5147b4]">
            <span className="inline-block rotate-90 text-[9px]">▶</span> Show less
          </button>
        )}
          </>
          );
        })()}
        {openSections.team && (agents ?? []).length === 0 && agents !== undefined && (
          <p className="px-1 pt-2 text-xs text-gray-400">No agents yet.</p>
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
                    {AGENT_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {roleLabel(role)}
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
              <button type="submit" disabled={savingAgent} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
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
                    {AGENT_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {roleLabel(role)}
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

      <div className="mt-auto shrink-0 rounded-2xl border border-[#ebe9f0] bg-white/90 p-3 shadow-xs dark:border-gray-800 dark:bg-gray-900/90">
        <div className="flex items-center justify-between text-xs font-semibold text-gray-700 dark:text-gray-200">
          <span>Weekly Claude quota</span>
          <span className="font-mono text-[11px] text-gray-400">10%</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
          <div className="h-full rounded-full bg-[#3d3852] dark:bg-indigo-400" style={{ width: "10%" }} />
        </div>
        <p className="mt-1.5 text-[11px] text-gray-400">
          10% used · resets in 3d
        </p>
      </div>
    </aside>
  );
}
