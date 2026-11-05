"use client";
import { FormEvent, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import Link from "next/link";
import Modal from "./Modal";

export default function Sidebar({ projectId, onSelectProject }: { projectId?: string; onSelectProject?: (id: string) => void }) {
  const [q, setQ] = useState("");
  const projects = useQuery(api.projects.list, {});
  const currentProject = useQuery(api.projects.get, projectId ? { projectId: projectId as never } : "skip");
  const agents = useQuery(api.agents.list, {});
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
  const [agentProvider, setAgentProvider] = useState("anthropic");
  const [agentModel, setAgentModel] = useState("");
  const [agentBaseUrl, setAgentBaseUrl] = useState("");
  const [agentApiKey, setAgentApiKey] = useState("");
  const [agentError, setAgentError] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [teamError, setTeamError] = useState("");
  const [savingTeam, setSavingTeam] = useState(false);
  const [removingAgentId, setRemovingAgentId] = useState<string | null>(null);
  const [isTeamOpen, setIsTeamOpen] = useState(false);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const updateTeam = useMutation(api.projects.updateTeam);

  const filteredProjects = (projects ?? []).filter((p: any) => p.name.toLowerCase().includes(q.toLowerCase()));
  const allowedAgentIds = (currentProject as any)?.agentIds as string[] | undefined;
  const visibleAgents = allowedAgentIds
    ? (agents ?? []).filter((agent: any) => allowedAgentIds.includes(agent._id))
    : agents ?? [];

  async function handleCreateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAgentError("");
    setSavingAgent(true);
    try {
      await createAgent({
        name: agentName,
        role: agentRole,
        ...(agentPrompt.trim() ? { systemPrompt: agentPrompt } : {}),
      });
      setAgentName("");
      setAgentRole("");
      setAgentPrompt("");
      setIsCreateAgentOpen(false);
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Agent gagal dibuat");
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
      setAgentProvider(agent.llmProvider ?? "anthropic");
      setAgentModel(agent.llmModel ?? "");
      setAgentBaseUrl(agent.llmBaseUrl ?? "");
      setAgentApiKey("");
  }

  function closeAgentEditor() {
      setEditingAgentId(null);
      setAgentError("");
  }

  async function handleUpdateAgent(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!editingAgentId) return;
      setAgentError("");
      setSavingAgent(true);
      try {
        await updateAgent({
          agentId: editingAgentId as never,
          name: agentName,
          role: agentRole,
          systemPrompt: agentPrompt,
          llmProvider: agentProvider,
          llmModel: agentModel,
          llmBaseUrl: agentBaseUrl,
          llmApiKey: agentApiKey,
        });
        closeAgentEditor();
      } catch (err) {
        setAgentError(err instanceof Error ? err.message : "Agent gagal diperbarui");
      } finally {
        setSavingAgent(false);
      }
  }

  function openTeamSettings() {
    setSelectedTeamIds(allowedAgentIds ?? (agents ?? []).map((agent: any) => agent._id));
    setIsTeamOpen(true);
  }

  async function saveTeam() {
    if (!projectId) return;
    setTeamError("");
    setSavingTeam(true);
    try {
      await updateTeam({ projectId: projectId as never, agentIds: selectedTeamIds as never[] });
      setIsTeamOpen(false);
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : "Team gagal disimpan");
    } finally {
      setSavingTeam(false);
    }
  }

  async function handleRemoveAgent(agentId: string, agentName: string) {
    if (!window.confirm(`Hapus agent "${agentName}"? Agent ini juga akan dikeluarkan dari project yang menggunakannya.`)) return;
    setRemovingAgentId(agentId);
    try {
      await removeAgent({ agentId: agentId as never });
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Agent gagal dihapus");
    } finally {
      setRemovingAgentId(null);
    }
  }

  return (
    <aside className="flex h-full w-[250px] shrink-0 flex-col gap-5 border-r border-[#e7e5ef] bg-[#fbfbfd] p-3.5 max-[979px]:h-auto max-[979px]:w-full max-[979px]:border-r-0">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search  ⌘K"
        className="w-full rounded-xl border border-[#e5e3eb] bg-white px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-[#a29ae8] focus:ring-2 focus:ring-[#e5e1ff] dark:border-gray-700 dark:bg-gray-900 dark:text-white"
      />

      <div>
        <div className="flex items-center justify-between px-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Needs you</h3>
          <span className="rounded-full bg-[#fff0f1] px-2 py-0.5 text-[11px] font-semibold text-[#d85b68]">
            {pending?.length ?? 0}
          </span>
        </div>
        {(pending ?? []).slice(0, 3).map((a: any) => (
          <div key={a._id} className="mt-2 rounded-xl border border-[#ebe9f0] bg-white p-3 shadow-[0_1px_2px_rgba(30,25,60,.03)]">
            <p className="text-sm font-medium dark:text-white">{a.summary}</p>
            <p className="text-xs text-gray-500">{a.kind}</p>
            <div className="mt-2 flex gap-2">
              <button onClick={() => approve({ approvalId: a._id })} className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-700">Approve</button>
              <button onClick={() => reject({ approvalId: a._id })} className="rounded-lg bg-gray-200 px-2 py-1 text-xs font-semibold dark:bg-gray-700 dark:text-white">Reject</button>
            </div>
          </div>
        ))}
        {pending?.length === 0 && <p className="px-1 pt-2 text-xs text-gray-400">Tidak ada yang menunggu approval.</p>}
      </div>

      <div>
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Projects</h3>
        {filteredProjects.length === 0 && <p className="px-1 pt-2 text-xs text-gray-400">Belum ada project.</p>}
        {filteredProjects.map((p: any) => (
          <Link
            key={p._id}
            href={`/workspace/${p._id}`}
            onClick={() => onSelectProject?.(p._id)}
            className={`mt-1 flex items-center justify-between rounded-lg px-2.5 py-2 text-sm transition hover:bg-[#f0eff7] dark:hover:bg-gray-800 dark:text-white ${projectId === p._id ? "bg-[#eeecfb] font-semibold text-[#4c42a3]" : "text-gray-600"}`}
          >
            <span className="truncate">{p.name}</span>
            <span className="ml-2 rounded-full bg-[#eceaf3] px-2 py-0.5 text-xs text-gray-500">•</span>
          </Link>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between px-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Team</h3>
          {projectId && <button
            type="button"
            onClick={openTeamSettings}
            className="rounded px-1.5 text-xs text-gray-400 hover:bg-[#eeecfb] hover:text-[#5147b4]"
            title="Pilih team project"
          >
            Manage
          </button>}
          <button
            type="button"
            onClick={() => setIsCreateAgentOpen(true)}
            className="rounded px-1.5 text-lg leading-none text-gray-400 hover:bg-[#eeecfb] hover:text-[#5147b4]"
            title="Create agent"
            aria-label="Create agent"
          >
            +
          </button>
        </div>
        {visibleAgents.map((a: any) => (
          <div key={a._id} role="button" tabIndex={0} onClick={() => openAgentEditor(a)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openAgentEditor(a); }} className="group mt-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 dark:text-white hover:bg-[#f0eff7]">
            <AgentAvatar name={a.name} size={28} status={a.status} avatarParams={a.avatarParams} />
            <span className="text-sm">{a.name}</span>
            <span className="ml-auto text-xs text-gray-400">{a.status}</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void handleRemoveAgent(a._id, a.name);
              }}
              disabled={removingAgentId === a._id}
              className="hidden rounded px-1 text-xs text-gray-400 hover:bg-red-50 hover:text-red-600 group-hover:block disabled:opacity-50"
              title={`Remove ${a.name}`}
              aria-label={`Remove ${a.name}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {isCreateAgentOpen && (
        <Modal title="Create agent" onClose={() => setIsCreateAgentOpen(false)} maxWidth="max-w-lg">
          <form onSubmit={handleCreateAgent} className="mt-4 grid gap-3">
            <div className="grid gap-3">
              <label className="grid gap-1 text-sm">
                Name
                <input value={agentName} onChange={(event) => setAgentName(event.target.value)} required className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
              </label>
              <label className="grid gap-1 text-sm">
                Role
                <input value={agentRole} onChange={(event) => setAgentRole(event.target.value)} placeholder="frontend, backend, qa" required className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
              </label>
              <button type="submit" disabled={savingAgent} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {savingAgent ? "Creating…" : "Create agent"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editingAgentId && (
        <Modal title={`Edit agent${agentName ? ` · ${agentName}` : ""}`} onClose={closeAgentEditor} maxWidth="max-w-lg">
          <form onSubmit={handleUpdateAgent} className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm">Name
              <input value={agentName} onChange={(event) => setAgentName(event.target.value)} required className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
            </label>
            <label className="grid gap-1 text-sm">Role
              <input value={agentRole} onChange={(event) => setAgentRole(event.target.value)} required className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
            </label>
            <label className="grid gap-1 text-sm">System prompt <span className="text-gray-400">(optional)</span>
              <textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} rows={4} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm">LLM provider
                <select value={agentProvider} onChange={(event) => setAgentProvider(event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                  <option value="anthropic">Anthropic</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">Model
                <input value={agentModel} onChange={(event) => setAgentModel(event.target.value)} placeholder={agentProvider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini"} className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
              </label>
            </div>
            {agentProvider === "openai-compatible" && (
              <label className="grid gap-1 text-sm">Base URL
                <input value={agentBaseUrl} onChange={(event) => setAgentBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
              </label>
            )}
            <label className="grid gap-1 text-sm">API key
              <input type="password" value={agentApiKey} onChange={(event) => setAgentApiKey(event.target.value)} placeholder="Masukkan API key agent" className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800" />
              <span className="text-[11px] text-gray-400">
                {agents?.find((agent: any) => agent._id === editingAgentId)?.llmApiKeyConfigured
                  ? "API key tersimpan. Kosongkan untuk mempertahankannya."
                  : "Belum ada API key. Masukkan key untuk mengaktifkan agent."}
              </span>
            </label>
            {agentError && <p className="text-sm text-red-600">{agentError}</p>}
            <button type="submit" disabled={savingAgent} className="rounded-lg bg-[#6252d8] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {savingAgent ? "Saving…" : "Save changes"}
            </button>
          </form>
        </Modal>
      )}
      {isTeamOpen && (
        <Modal title="Team untuk project" onClose={() => setIsTeamOpen(false)}>
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
            <button type="button" disabled={savingTeam} onClick={() => void saveTeam()} className="mt-4 w-full rounded-lg bg-[#6252d8] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{savingTeam ? "Saving…" : "Save team"}</button>
        </Modal>
      )}
    </aside>
  );
}
