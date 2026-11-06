"use client";
import { FormEvent, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import Link from "next/link";
import Modal from "./Modal";
import { useRouter } from "next/navigation";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { useToast } from "./Toasts";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Check, Plus, Settings2, Trash2, X, Dices } from "lucide-react";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { usePathname } from "next/navigation";
import { randomAvatartion, type AvatartionAvatar } from "./ui/avatartion";
import { SkeletonBox } from "skullet/react";

const AGENT_ROLES = [
  "frontend",
  "backend",
  "qa",
  "architect",
  "security",
  "researcher",
  "general",
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
  const [teamError, setTeamError] = useState("");
  const [savingTeam, setSavingTeam] = useState(false);
  const [removingAgentId, setRemovingAgentId] = useState<string | null>(null);
  const [isTeamOpen, setIsTeamOpen] = useState(false);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [teamProjectId, setTeamProjectId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState({ needsYou: true, projects: true, team: true });
  const updateTeam = useMutation(api.projects.updateTeam);
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
    if (!agentName.trim()) {
      setAgentError("Name is required");
      return;
    }
    if (!agentRole.trim()) {
      setAgentError("Role is required — pick a role from the dropdown");
      return;
    }
    setSavingAgent(true);
    try {
      const newAgentId = await createAgent({
        name: agentName,
        role: agentRole,
        ...(agentPrompt.trim() ? { systemPrompt: agentPrompt } : {}),
      });
      setAgentName("");
      setAgentRole("");
      setAgentPrompt("");
      setAvatarSeed(null);
      setIsCreateAgentOpen(false);
      if (projectId) {
        setSelectedTeamIds((current) => [...new Set([...(current ?? []), newAgentId as string])]);
        setTeamProjectId(projectId);
        setIsTeamOpen(true);
      }
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

  function openTeamSettings(targetId?: string, preselectedAgentIds?: string[]) {
    const pid = targetId ?? projectId ?? null;
    setTeamProjectId(pid);
    const targetAgents = pid
      ? (projects ?? []).find((p: any) => p._id === pid)?.agentIds as string[] | undefined
      : undefined;
    setSelectedTeamIds(preselectedAgentIds ?? targetAgents ?? (agents ?? []).map((agent: any) => agent._id));
    setIsTeamOpen(true);
  }

  async function saveTeam() {
    const pid = teamProjectId;
    if (!pid) return;
    setTeamError("");
    setSavingTeam(true);
    try {
      await updateTeam({ projectId: pid as never, agentIds: selectedTeamIds as never[] });
      setIsTeamOpen(false);
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : "Failed to save team");
    } finally {
      setSavingTeam(false);
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
    <div className="flex items-center justify-between px-1">
      <button type="button" onClick={() => toggleSection(key_)} className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-[#5147b4]">
        <span className={`inline-block text-[8px] transition-transform ${openSections[key_] ? "rotate-90" : ""}`}>▶</span>
        {title}
      </button>
      <span className="flex items-center gap-1">
        {count !== undefined && <Badge variant="destructive" className="h-5 px-2 text-[11px]">{count}</Badge>}
        {onManage && (
          <button type="button" onClick={onManage} className="rounded px-1.5 text-xs text-gray-400 hover:bg-[#eeecfb] hover:text-[#5147b4]">Manage</button>
        )}
      </span>
    </div>
  );

  if (pathname === "/") return null;

  const ProjectMark = ({ name, active = false }: { name: string; active?: boolean }) => {
    const initial = (name.trim().charAt(0) || "•").toUpperCase();
    return (
      <span
        aria-hidden="true"
        className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          active
            ? "bg-[#5147b4] text-white"
            : "bg-[#eceaf3] text-[#5147b4] dark:bg-gray-800 dark:text-indigo-300"
        }`}
      >
        {initial}
      </span>
    );
  };

  return (
    <aside className="flex h-full w-[250px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-[#e7e5ef] bg-white/70 p-3.5 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-950/70 max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-r-0">
      <ConfirmDialog request={confirmReq} pending={removingAgentId !== null} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search  ⌘K"
        className="h-9 w-full shrink-0 rounded-xl border-[#e5e3eb] bg-white dark:border-gray-700 dark:bg-gray-900 dark:text-white"
      />

      <div>
        <SectionHeader key_="needsYou" title="Needs you" count={pending?.length ?? 0} />
        <AnimatePresence initial={false}>
        {openSections.needsYou && (pending ?? []).slice(0, 3).map((a: any) => (
          <motion.div key={a._id} initial={{ opacity: 0, height: 0, y: -6 }} animate={{ opacity: 1, height: "auto", y: 0 }} exit={{ opacity: 0, height: 0, y: -6 }} className="overflow-hidden">
          <Card className="mt-2 border-[#ebe9f0] shadow-[0_1px_2px_rgba(30,25,60,.03)] dark:border-gray-800 dark:bg-gray-900">
            <CardContent className="p-3">
            <p className="text-sm font-medium dark:text-white">{a.summary}</p>
            <p className="text-xs text-gray-500">{a.kind}</p>
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" onClick={() => approve({ approvalId: a._id })} className="bg-emerald-600 text-white hover:bg-emerald-700">
                <Check /> Approve
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => reject({ approvalId: a._id })}>
                <X /> Reject
              </Button>
            </div>
            </CardContent>
          </Card>
          </motion.div>
        ))}
        </AnimatePresence>
        {openSections.needsYou && pending?.length === 0 && <p className="px-1 pt-2 text-xs text-gray-400">Nothing is waiting for approval.</p>}
      </div>

      <div>
        <SectionHeader key_="projects" title="Projects" />
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
        {openSections.projects && filteredProjects.map((p: any) => (
          <motion.div
            key={p._id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            className={`group mt-1 flex items-center justify-between rounded-lg px-2.5 py-2 text-sm transition hover:bg-[#f0eff7] dark:hover:bg-gray-800 dark:text-white ${projectId === p._id ? "bg-[#eeecfb] font-semibold text-[#4c42a3] dark:bg-gray-800 dark:text-indigo-300" : "text-gray-600 dark:text-gray-300"}`}
          >
            <ProjectMark name={p.name} active={projectId === p._id} />
            <Link
              href={`/chats/${p._id}`}
              onClick={() => onSelectProject?.(p._id)}
              className="min-w-0 flex-1 truncate"
            >
              {p.name}
            </Link>
            <span className="ml-2 flex shrink-0 items-center gap-1">
              {pendingByProject.get(p._id) ? (
                <Badge variant="destructive" className="h-5 px-2 text-[11px]">{pendingByProject.get(p._id)}</Badge>
              ) : (
                <span className="rounded-full bg-[#eceaf3] px-2 py-0.5 text-xs text-gray-500">•</span>
              )}
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
        ))}
        </AnimatePresence>
      </div>

      <div>
        <div className="flex items-center justify-between px-1">
          <button type="button" onClick={() => toggleSection("team")} className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-[#5147b4]">
            <span className={`inline-block text-[8px] transition-transform ${openSections.team ? "rotate-90" : ""}`}>▶</span>
            Team
          </button>
          <span className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openTeamSettings()}
            disabled={!projectId && (projects?.length ?? 0) === 0}
            className="text-xs text-gray-400 hover:bg-[#eeecfb] hover:text-[#5147b4]"
          >
            <Settings2 /> Manage
          </Button>
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
        <AnimatePresence initial={false}>
        {openSections.team && visibleAgents.map((a: any) => {
          const active = (activeByAgent as any)?.[a._id as string] as { taskId: string; taskTitle: string; subtaskKey?: string; status: string } | undefined;
          const isWorking = Boolean(active);
          return (
          <motion.div key={a._id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} role="button" tabIndex={0} onClick={() => openAgentEditor(a)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openAgentEditor(a); }} className="group mt-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 dark:text-white hover:bg-[#f0eff7]">
            <AgentAvatar name={a.name} size={28} status={isWorking ? "working" : a.status} avatarParams={a.avatarParams} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{a.name}</span>
              <span className="block truncate text-[11px] capitalize text-gray-400">
                {isWorking ? (
                  <>
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">
                      {active!.status === "running" ? "working" : active!.status === "waiting_approval" ? "waiting approval" : "queued"}
                    </span>
                    {" · "}
                    {active!.taskTitle}
                    {active!.subtaskKey ? ` · ${active!.subtaskKey}` : ""}
                  </>
                ) : (
                  a.role
                )}
              </span>
            </span>
            <span className={`text-xs ${isWorking ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-gray-400"}`}>{isWorking ? "busy" : a.status}</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleRemoveAgent(a._id, a.name);
              }}
              disabled={removingAgentId === a._id}
              className="hidden rounded px-1 text-xs text-gray-400 hover:bg-red-50 hover:text-red-600 group-hover:block disabled:opacity-50"
              title={`Remove ${a.name}`}
              aria-label={`Remove ${a.name}`}
            >
              ×
            </button>
          </motion.div>
          );
        })}
        </AnimatePresence>
      </div>

      {isCreateAgentOpen && (
        <Modal title="Create agent" onClose={() => setIsCreateAgentOpen(false)} maxWidth="max-w-lg">
          <form onSubmit={handleCreateAgent} className="mt-4 grid gap-3">
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm">
                Name
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
                        {role}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
                        {role}
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
              <legend className="px-1 text-xs font-semibold text-gray-500">LLM assignment <span className="font-normal text-gray-400">(optional — kosong = ikut pool)</span></legend>
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
                    <option value="">Model pertama yang tersedia</option>
                    {(llmModels ?? []).filter((m: any) => m.providerId === agentLlmProviderId).map((m: any) => (
                      <option key={m._id} value={m._id}>{m.displayName || m.modelId}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">Fallback provider
                  <select value={agentLlmFallbackProviderId} onChange={(event) => { setAgentLlmFallbackProviderId(event.target.value); setAgentLlmFallbackModelId(""); }} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Tidak ada (lanjut ke pool)</option>
                    {(llmProviders ?? []).map((p: any) => (
                      <option key={p._id} value={p._id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">Fallback model
                  <select value={agentLlmFallbackModelId} onChange={(event) => setAgentLlmFallbackModelId(event.target.value)} disabled={!agentLlmFallbackProviderId} className="rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Model pertama yang tersedia</option>
                    {(llmModels ?? []).filter((m: any) => m.providerId === agentLlmFallbackProviderId).map((m: any) => (
                      <option key={m._id} value={m._id}>{m.displayName || m.modelId}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm sm:col-span-2">Selection policy
                  <select value={agentLlmPolicy} onChange={(event) => setAgentLlmPolicy(event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                    <option value="">Default (weighted di antara priority setara)</option>
                    <option value="weighted">Weighted — weighted random di antara priority setara</option>
                    <option value="priority">Priority — selalu priority terendah, abaikan weight</option>
                    <option value="fixed">Fixed — hanya penugasan di atas, tanpa kandidat pool</option>
                  </select>
                </label>
              </div>
              <p className="text-xs text-gray-400">
                Resolver mencoba penugasan ini dulu, lalu fallback-nya, lalu pool. Koneksi yang circuit-nya
                terbuka (3× gagal transien, cooldown 60 detik) dilewati otomatis.
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
      {isTeamOpen && (
        <Modal title={`Team for project${teamProjectId ? `: ${(projects ?? []).find((p: any) => p._id === teamProjectId)?.name ?? ""}` : ""}`} onClose={() => setIsTeamOpen(false)}>
            {!projectId && (
              <label className="mt-4 grid gap-1 text-sm">
                Project
                <select
                  value={teamProjectId ?? ""}
                  onChange={(event) => openTeamSettings(event.target.value)}
                  required
                  className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
                >
                  <option value="">Select a project…</option>
                  {(projects ?? []).map((p: any) => (
                    <option key={p._id} value={p._id}>{p.name}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
              {(agents ?? []).map((agent: any) => (
                <label key={agent._id} className="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2 text-sm dark:border-gray-800">
                  <input
                    type="checkbox"
                    checked={selectedTeamIds.includes(agent._id)}
                    onChange={(event) => setSelectedTeamIds((current) => event.target.checked ? [...current, agent._id] : current.filter((id) => id !== agent._id))}
                  />
                  <AgentAvatar name={agent.name} size={24} status={agent.status} avatarParams={agent.avatarParams} />
                  <span>{agent.name}</span>
                  <span className="ml-auto text-xs text-gray-400">{agent.role}</span>
                </label>
              ))}
            </div>
            {teamError && <p className="mt-3 text-sm text-red-600">{teamError}</p>}
            <button type="button" disabled={savingTeam || !teamProjectId} onClick={() => void saveTeam()} className="mt-4 w-full rounded-lg bg-[#6252d8] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{savingTeam ? "Saving…" : "Save team"}</button>
        </Modal>
      )}
    </aside>
  );
}
