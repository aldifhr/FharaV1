"use client";

import { FormEvent, useEffect, useState } from "react";
import { createContext, useCallback, useContext } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/api/convex/_generated/api";
import Modal from "./Modal";
import { roleLabel } from "@/lib/agentRoles";

interface NewProjectContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openNewProject: () => void;
}

const NewProjectContext = createContext<NewProjectContextValue | null>(null);

export function useNewProject(): NewProjectContextValue {
  const context = useContext(NewProjectContext);
  if (!context) throw new Error("useNewProject must be used within NewProjectProvider");
  return context;
}

export function NewProjectProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const openNewProject = useCallback(() => setOpen(true), []);

  return (
    <NewProjectContext.Provider value={{ open, setOpen, openNewProject }}>
      {children}
      <NewProjectModal open={open} onClose={() => setOpen(false)} />
    </NewProjectContext.Provider>
  );
}

type Step = "project" | "team";

function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const agents = useQuery(api.agents.list, {});
  const createProject = useMutation(api.projects.create);
  const [step, setStep] = useState<Step>("project");
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [desktopReady, setDesktopReady] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);

  useEffect(() => {
    setDesktopReady(Boolean(window.moagentDesktop));
  }, []);

  useEffect(() => {
    if (!open) {
      setStep("project");
      setName("");
      setWorkspacePath("");
      setError("");
      setSelectedAgentIds([]);
    }
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (step === "project") {
      if (!name.trim()) {
        setError("Project name is required");
        return;
      }
      if (!workspacePath.trim()) {
        setError("Folder path is required");
        return;
      }
      setStep("team");
      return;
    }
    // A project with no agents gets no replies at all.
    if (selectedAgentIds.length === 0) {
      setError("Pick at least one agent for this project.");
      return;
    }
    setSaving(true);
    try {
      const projectId = (await createProject({
        name,
        workspacePath,
        agentIds: selectedAgentIds as never[],
      })) as unknown as string;
      setStep("project");
      setName("");
      setWorkspacePath("");
      setSelectedAgentIds([]);
      onClose();
      if (projectId) router.push(`/chats/${projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSaving(false);
    }
  }

  async function handleSelectFolder() {
    if (!window.moagentDesktop) return;
    setSelectingFolder(true);
    setError("");
    try {
      const selectedPath = await window.moagentDesktop.selectFolder();
      if (selectedPath) {
        setWorkspacePath(selectedPath);
        if (!name) {
          const folderName = selectedPath.split(/[\\/]/).filter(Boolean).pop();
          if (folderName) setName(folderName);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select folder");
    } finally {
      setSelectingFolder(false);
    }
  }

  if (!open) return null;

  return (
    <Modal title={step === "project" ? "Add project" : "Select team"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="mt-4 grid gap-3">
        {step === "project" ? (
          <>
            <label className="grid gap-1 text-sm">
              Project name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="E.g. MOAgent"
                required
                autoFocus
                className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
              />
            </label>
            <label className="grid gap-1 text-sm">
              Folder path
              <div className="flex gap-2">
                <input
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  placeholder="C:\projects\MOAgent"
                  required
                  className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
                />
                {desktopReady && (
                  <button
                    type="button"
                    onClick={handleSelectFolder}
                    disabled={selectingFolder}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 disabled:opacity-50"
                  >
                    {selectingFolder ? "..." : "Select"}
                  </button>
                )}
              </div>
            </label>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-500">Choose agents for the team <span className="font-medium dark:text-white">{name}</span>.</p>
            <fieldset className="grid gap-2">
              <div className="flex items-center justify-between">
                <legend className="text-sm font-medium">Team project</legend>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedAgentIds((current) =>
                      current.length === (agents ?? []).length
                        ? []
                        : (agents ?? []).map((agent) => agent._id)
                    )
                  }
                  className="text-xs font-medium text-[#635bff] hover:underline"
                >
                  {(agents ?? []).length > 0 && selectedAgentIds.length === (agents ?? []).length
                    ? "Deselect all"
                    : "Select all"}
                </button>
              </div>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                {(agents ?? []).length === 0 && <p className="text-xs text-gray-500 dark:text-gray-400">No agents yet. Create one with + in the Team section of the sidebar.</p>}
                {(agents ?? []).map((agent, index) => {
                  const agentList = agents ?? [];
                  const sameRoleBefore = agentList.slice(0, index).filter((a) => a.role === agent.role).length;
                  const label = roleLabel(agent.role);
                  const displayLabel = sameRoleBefore === 0 ? label : `${label} ${sameRoleBefore + 1}`;
                  return (
                  <label key={agent._id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedAgentIds.includes(agent._id)}
                      onChange={(event) =>
                        setSelectedAgentIds((current) =>
                          event.target.checked
                            ? [...current, agent._id]
                            : current.filter((id) => id !== agent._id)
                        )
                      }
                    />
                    <span>{displayLabel}</span>
                  </label>
                  );
                })}
              </div>
            </fieldset>
            <button
              type="button"
              onClick={() => setStep("project")}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium dark:border-gray-700"
            >
              ← Back
            </button>
          </>
        )}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={saving || (step === "team" && selectedAgentIds.length === 0)}
          className="mt-1 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          {saving ? "Saving..." : step === "project" ? "Next" : "Create project"}
        </button>
      </form>
    </Modal>
  );
}
