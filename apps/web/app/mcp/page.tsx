"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import { Cable, Trash2, Globe, Terminal, Loader2 } from "lucide-react";
import { BlurFade } from "@/components/ui/blur-fade";
import { api } from "@/api/convex/_generated/api";
import type { Doc, Id } from "@/api/convex/_generated/dataModel";
import IconRail from "@/components/IconRail";
import { useToast } from "@/components/Toasts";
import { SkeletonBox } from "skullet/react";

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "connected"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
      : status === "error"
        ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"
        : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ${cls}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === "connected"
            ? "bg-emerald-500"
            : status === "error"
              ? "bg-red-500"
              : "bg-gray-400"
        }`}
      />
      {status}
    </span>
  );
}

function ServerCard({ server }: { server: Doc<"mcpServers"> }) {
  const [removing, setRemoving] = useState(false);
  const toast = useToast();

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", serverId: server._id }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Remove failed");
      toast("success", "Removed", server.name);
    } catch (err) {
      toast(
        "error",
        "Failed",
        err instanceof Error ? err.message : "Remove failed"
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <BlurFade inView>
      <div className="rounded-xl border border-[#ebe9f0] bg-white/70 p-5 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold">{server.name}</p>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
              {server.type === "remote" ? (
                <>
                  <Globe size={12} />
                  <span className="font-mono">{server.url}</span>
                </>
              ) : (
                <>
                  <Terminal size={12} />
                  <span className="font-mono">
                    {server.command}
                    {server.args ? ` ${server.args}` : ""}
                  </span>
                </>
              )}
            </p>
          </div>
          <StatusBadge status={server.status} />
        </div>

        {server.errorMessage && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {server.errorMessage}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={handleRemove}
            disabled={removing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-red-950"
          >
            {removing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            {removing ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </BlurFade>
  );
}

function AddServerForm({ projectId }: { projectId: Id<"projects"> }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"remote" | "local">("remote");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [autoConnect, setAutoConnect] = useState(false);
  const [allowedDirectories, setAllowedDirectories] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          projectId,
          name: name.trim(),
          type,
          url: type === "remote" ? url.trim() : undefined,
          command: type === "local" ? command.trim() : undefined,
          args: type === "local" && args.trim() ? args.trim() : undefined,
          // Plan 009: only local stdio servers are launched by the worker.
          enabled,
          autoConnect: type === "local" ? autoConnect : false,
          transport: type === "local" ? "stdio" : undefined,
          allowedDirectories:
            type === "local"
              ? allowedDirectories
                  .split(/\r?\n/)
                  .map((entry) => entry.trim())
                  .filter(Boolean)
              : undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Add failed");
      toast("success", "Server added", name.trim());
      setName("");
      setUrl("");
      setCommand("");
      setArgs("");
      setAllowedDirectories("");
    } catch (err) {
      toast(
        "error",
        "Failed",
        err instanceof Error ? err.message : "Add failed"
      );
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white";

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-[#ebe9f0] bg-white/70 p-5 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60"
    >
      <h3 className="text-sm font-semibold">Add MCP Server</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-gray-500">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="context7"
            required
            className={inputCls}
          />
        </label>
        <label className="grid gap-1 text-xs text-gray-500">
          Type
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "remote" | "local")}
            className={inputCls}
          >
            <option value="remote">Remote (HTTP)</option>
            <option value="local">Local (process)</option>
          </select>
        </label>
        {type === "remote" ? (
          <label className="grid gap-1 text-xs text-gray-500 sm:col-span-2">
            URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.context7.com/mcp"
              required
              className={`${inputCls} font-mono`}
            />
          </label>
        ) : (
          <>
            <label className="grid gap-1 text-xs text-gray-500">
              Command
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                required
                className={`${inputCls} font-mono`}
              />
            </label>
            <label className="grid gap-1 text-xs text-gray-500">
              Args (JSON array string)
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder='["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"]'
                className={`${inputCls} font-mono`}
              />
            </label>
            <label className="grid gap-1 text-xs text-gray-500 sm:col-span-2">
              Extra allowed directories (one absolute path per line)
              <textarea
                value={allowedDirectories}
                onChange={(e) => setAllowedDirectories(e.target.value)}
                placeholder={"/shared/libs\n/another/workspace"}
                rows={2}
                className={`${inputCls} font-mono`}
              />
            </label>
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-gray-600 dark:text-gray-300">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled (delivered to the worker)
        </label>
        {type === "local" && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoConnect}
              onChange={(e) => setAutoConnect(e.target.checked)}
            />
            Connect at task start
          </label>
        )}
      </div>
      <button
        type="submit"
        disabled={saving || !name.trim()}
        className="mt-3 rounded-lg bg-[#6252d8] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {saving ? "Adding…" : "Add Server"}
      </button>
    </form>
  );
}

export default function McpPage() {
  const projects = useQuery(api.projects.list, {});
  const [projectId, setProjectId] = useState<Id<"projects"> | null>(null);

  const servers = useQuery(
    api.mcpServers.list,
    projectId ? { projectId } : "skip"
  );

  useEffect(() => {
    if (!projectId && projects && projects.length > 0) {
      setProjectId(projects[0]._id as Id<"projects">);
    }
  }, [projects, projectId]);

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-gray-900 dark:text-gray-100 max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail />
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="min-w-0 flex-1 overflow-y-auto p-6 max-[979px]:p-4"
      >
        <div className="mx-auto max-w-3xl">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Cable size={20} />
            MCP Servers
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure external MCP servers. The worker discovers their tools
            over stdio and lets agents use them inside the project workspace —
            see <span className="font-mono">docs/mcp-filesystem.md</span>.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label htmlFor="mcp-project" className="text-sm text-gray-500">
              Project
            </label>
            <select
              id="mcp-project"
              value={projectId ?? ""}
              onChange={(e) => setProjectId(e.target.value as Id<"projects">)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            >
              {(projects ?? []).map((p: Doc<"projects">) => (
                <option key={p._id as string} value={p._id as string}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-6 space-y-4">
            {projectId && <AddServerForm projectId={projectId} />}

            {projects === undefined || servers === undefined ? (
              <div aria-hidden className="space-y-3">
                <SkeletonBox height={100} width="100%" />
                <SkeletonBox height={100} width="100%" />
              </div>
            ) : servers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-400 dark:border-gray-700">
                <Cable size={24} className="mx-auto mb-2 opacity-50" />
                No MCP servers configured.
                <p className="mx-auto mt-2 max-w-md text-xs">
                  Add one above. Remote servers need an HTTP endpoint; local
                  servers need a command to spawn.
                </p>
              </div>
            ) : (
              servers.map((s) => <ServerCard key={s._id} server={s} />)
            )}
          </div>
        </div>
      </motion.section>
    </div>
  );
}
