"use client";

import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../api/convex/_generated/api";
import Link from "next/link";
import IconRail from "../components/IconRail";
import Sidebar from "../components/Sidebar";
import Modal from "../components/Modal";

export default function Home() {
  const projects = useQuery(api.projects.list, {});
  const agents = useQuery(api.agents.list, {});
  const createProject = useMutation(api.projects.create);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await createProject({ name, workspacePath, agentIds: selectedAgentIds as never[] });
      setName("");
      setWorkspacePath("");
      setSelectedAgentIds([]);
      setIsCreateOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Project gagal dibuat");
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
      setError(err instanceof Error ? err.message : "Folder gagal dipilih");
    } finally {
      setSelectingFolder(false);
    }
  }

  if (projects === undefined || agents === undefined) {
    return <div className="flex h-screen items-center justify-center">Loading…</div>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail onNewProject={() => setIsCreateOpen(true)} />
      <Sidebar />
      <main className="flex min-w-0 flex-1 items-center justify-center p-8">
        <div className="max-w-lg text-center">
          <h1 className="text-2xl font-semibold">Agent Workspace</h1>
          <p className="mt-2 text-sm text-gray-500">
            Pilih project dari sidebar atau tambahkan folder project Windows dengan tombol +.
          </p>
          {projects.length > 0 && (
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {projects.slice(0, 3).map((project) => (
                <Link
                  key={project._id}
                  href={`/workspace/${project._id}`}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
                >
                  {project.name}
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>

      {isCreateOpen && (
        <Modal title="Tambah project" onClose={() => setIsCreateOpen(false)}>
          <form
            onSubmit={handleSubmit}
            className="mt-4 grid gap-3"
          >
              <label className="grid gap-1 text-sm">
                Nama project
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Contoh: MOAgent"
                  required
                  className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
                />
              </label>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Team project</legend>
                <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                  {agents.length === 0 && <p className="text-xs text-gray-400">Buat agent terlebih dahulu dari Team.</p>}
                  {agents.map((agent) => (
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
                      <span>{agent.name}</span>
                      <span className="text-xs text-gray-400">{agent.role}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="grid gap-1 text-sm">
                Path folder Windows
                <div className="flex gap-2">
                  <input
                    value={workspacePath}
                    onChange={(event) => setWorkspacePath(event.target.value)}
                    placeholder={"D:\\CODE\\MOAgent"}
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
                      {selectingFolder ? "..." : "Pilih"}
                    </button>
                  )}
                </div>
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={saving}
                className="mt-1 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? "Menyimpan…" : "Tambah project"}
              </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
