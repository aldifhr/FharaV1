"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import {
  Database,
  Download,
  ExternalLink,
  FolderTree,
  GitBranch,
  Globe,
  Plug,
  Plus,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import {
  MCP_PRESETS,
  fieldsFromArgs,
  getMcpPreset,
  type McpPreset,
} from "@/api/convex/lib/mcpPresets";
import { ROLE_KEYS, roleLabel } from "@/api/convex/lib/roles";
import IconRail from "@/components/IconRail";
import GithubWebhookSetup from "@/components/GithubWebhookSetup";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toasts";

const ICONS: Record<McpPreset["icon"], LucideIcon> = {
  FolderTree,
  GitBranch,
  Globe,
  Database,
  Download,
  Terminal,
};

type Server = {
  _id: string;
  projectId?: string;
  name: string;
  type: "local" | "remote";
  url?: string;
  command?: string;
  args?: string;
  status: "connected" | "disconnected" | "error" | "untested";
  errorMessage?: string;
  enabled?: boolean;
  autoConnect?: boolean;
  preset?: string;
  agentRoles?: string[];
  toolAllowlist?: string[];
  envKeys: string[];
  useGithubOAuth?: boolean;
  testPending: boolean;
  lastTestedAt?: number;
  toolCount?: number;
  toolNames?: string[];
};

type Project = { _id: string; name: string };

const INPUT =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong";
const LABEL = "grid gap-1.5 text-[12.5px] text-ink-2";
const GHOST_BTN = "rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50";
const PRIMARY_BTN =
  "rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.";

async function mcpAction(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("/api/mcp-servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Record<string, unknown>;
  if (!res.ok || !data.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // legacy space-separated
  }
  return raw.trim().split(/\s+/).filter(Boolean);
}

function presetFor(server: Server): McpPreset {
  return getMcpPreset(server.preset) ?? (server.type === "remote" ? getMcpPreset("custom")! : getMcpPreset("filesystem")!);
}

function statusInfo(server: Server): { dot: string; label: string } {
  if (server.testPending) return { dot: "bg-amber-500 animate-pulse", label: "Testing…" };
  if (server.enabled === false) return { dot: "bg-ink-3/40", label: "Off" };
  switch (server.status) {
    case "connected":
      return { dot: "bg-emerald-500", label: server.toolCount !== undefined ? `Connected · ${server.toolCount} tools` : "Connected" };
    case "error":
      return { dot: "bg-red-500", label: "Error" };
    case "untested":
      return { dot: "bg-ink-3", label: "Untested" };
    default:
      return { dot: "bg-ink-3", label: "Not connected yet" };
  }
}

function rolesText(roles: string[] | undefined): string {
  if (!roles || roles.length === 0) return "All roles";
  return roles.map((role) => roleLabel(role)).join(", ");
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition disabled:opacity-50 ${
        on ? "border-transparent bg-ink" : "border-line-strong bg-bubble"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full transition ${on ? "translate-x-[18px] bg-canvas" : "translate-x-[3px] bg-ink-3"}`}
      />
    </button>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 flex items-baseline gap-2 text-[13px] font-medium text-ink-2">
        {title}
        {count !== undefined && <span className="tabular-nums text-ink-3">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

/** GitHub OAuth row: per project, reusing the existing connect flow. */
function GithubOAuthRow({ projectId }: { projectId?: string }) {
  const toast = useToast();
  const integrations = useQuery(api.integrations.listByProject, projectId ? { projectId: projectId as never } : "skip");
  const oauthUrl = useQuery(api.integrations.getOAuthUrl, projectId ? { projectId: projectId as never } : "skip");
  const github = (integrations ?? []).find((row) => row.type === "github" && row.status !== "disconnected");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type === "github_oauth_success") toast("success", "GitHub connected");
      if (type === "github_oauth_error") toast("error", "GitHub connection failed", String((event.data as { error?: string }).error ?? ""));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [toast]);

  let detail: string;
  let dot = "bg-ink-3";
  if (!projectId) detail = "Connected per project. Pick a project above to connect.";
  else if (integrations === undefined) detail = "Loading…";
  else if (!github) detail = "Not connected. Used for pushes and pull requests.";
  else if (github.status === "error") {
    detail = github.errorMessage ?? "Connection error";
    dot = "bg-red-500";
  } else {
    detail = github.githubOwner && github.githubRepo ? `Connected · ${github.githubOwner}/${github.githubRepo}` : "Connected · no repository chosen";
    dot = "bg-emerald-500";
  }

  return (
    <>
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bubble text-ink-2">
        <GitBranch size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px]">GitHub account</p>
        <p className="truncate text-[12.5px] text-ink-3">OAuth · {detail}</p>
      </div>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      {projectId &&
        (github && github.status === "active" ? (
          <Link href={`/chats/${projectId}`} className={GHOST_BTN}>
            Repository
          </Link>
        ) : oauthUrl === null ? (
          <span className="text-[12.5px] text-ink-3" title="Set GITHUB_CLIENT_ID on the Convex deployment">
            OAuth app not configured
          </span>
        ) : (
          <button
            type="button"
            disabled={!oauthUrl}
            onClick={() => oauthUrl && window.open(oauthUrl, "github-oauth", "width=720,height=780")}
            className={PRIMARY_BTN}
          >
            Connect
          </button>
        ))}
    </li>
    {projectId && github && github.status === "active" && <GithubWebhookSetup integrationId={github._id} />}
    </>
  );
}

function ServerModal({
  preset,
  server,
  projects,
  defaultProjectId,
  onClose,
}: {
  preset: McpPreset;
  server?: Server;
  projects: Project[];
  defaultProjectId?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const editing = Boolean(server);
  const storedArgs = parseArgs(server?.args);
  const [name, setName] = useState(server?.name ?? preset.name);
  const [scope, setScope] = useState<string>(server ? (server.projectId ?? "global") : (defaultProjectId ?? "global"));
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of preset.fields) initial[field.key] = field.defaultValue ?? "";
    return server ? { ...initial, ...fieldsFromArgs(preset, storedArgs) } : initial;
  });
  const [roles, setRoles] = useState<string[]>(server?.agentRoles ?? []);
  const [enabled, setEnabled] = useState(server?.enabled !== false);
  const [autoConnect, setAutoConnect] = useState(server?.autoConnect === true);
  const [useOAuth, setUseOAuth] = useState(server?.useGithubOAuth ?? (!server && preset.id === "github" && Boolean(defaultProjectId)));
  // Custom preset
  const [type, setType] = useState<"local" | "remote">(server?.type ?? "local");
  const [command, setCommand] = useState(server?.command ?? "");
  const [argsText, setArgsText] = useState(storedArgs.join("\n"));
  const [url, setUrl] = useState(server?.url ?? "");
  const [toolsText, setToolsText] = useState((server?.toolAllowlist ?? []).join(", "));
  // Secrets: stored keys show as ••••; `replacing` opens an input.
  const storedKeys = server?.envKeys ?? [];
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [removeKeys, setRemoveKeys] = useState<string[]>([]);
  const [customEnv, setCustomEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirm) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, confirm]);

  const secretKeys = useMemo(() => {
    const keys = preset.secrets.map((secret) => secret.key);
    for (const key of storedKeys) if (!keys.includes(key)) keys.push(key);
    return keys;
  }, [preset, storedKeys]);

  const projectScoped = scope !== "global";
  const oauthCoversToken = preset.id === "github" && projectScoped && useOAuth;

  const buildPayload = () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(secretValues)) if (value.trim()) env[key] = value;
    for (const row of customEnv) if (row.key.trim() && row.value.trim()) env[row.key.trim()] = row.value;
    const payload: Record<string, unknown> = {
      name: name.trim(),
      agentRoles: roles,
      enabled,
      autoConnect,
    };
    if (Object.keys(env).length > 0) payload.env = env;
    if (preset.id === "github") payload.useGithubOAuth = projectScoped && useOAuth;
    if (preset.fields.length > 0) payload.fields = fields;
    if (preset.id === "custom") {
      payload.type = type;
      if (type === "remote") payload.url = url.trim();
      else {
        payload.command = command.trim();
        payload.commandArgs = argsText.split("\n").map((line) => line.trim()).filter(Boolean);
      }
    }
    if (preset.id !== "filesystem") {
      payload.toolAllowlist = toolsText.split(/[,\s]+/).map((tool) => tool.trim()).filter(Boolean);
    }
    return payload;
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = buildPayload();
      if (server) {
        const scopeChanged = (server.projectId ?? "global") !== scope;
        await mcpAction("update", {
          serverId: server._id,
          ...payload,
          ...(scopeChanged ? { projectId: projectScoped ? scope : null } : {}),
          ...(removeKeys.length ? { removeEnvKeys: removeKeys } : {}),
        });
        toast("success", "Saved", name.trim());
      } else {
        await mcpAction("create", {
          presetId: preset.id,
          ...(projectScoped ? { projectId: scope } : {}),
          ...payload,
        });
        toast("success", "Added", `${name.trim()} · run Test to check it starts`);
      }
      onClose();
    } catch (err) {
      toast("error", "Couldn't save", errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!server) return;
    setTesting(true);
    try {
      const result = await mcpAction("test", { serverId: server._id });
      if (result.queued === false) toast("info", "Not tested", String(result.message ?? ""));
      else toast("info", "Test queued", "A running worker will start the server and list its tools.");
    } catch (err) {
      toast("error", "Couldn't start the test", errorText(err));
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!server) return;
    setRemoving(true);
    try {
      await mcpAction("remove", { serverId: server._id });
      toast("success", "Removed", server.name);
      setConfirm(null);
      onClose();
    } catch (err) {
      toast("error", "Couldn't remove", errorText(err));
    } finally {
      setRemoving(false);
    }
  };

  const Icon = ICONS[preset.icon];
  const status = server ? statusInfo(server) : null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? `Edit ${server?.name}` : `Add ${preset.name}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-panel text-ink shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bubble text-ink-2">
            <Icon size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-medium">{editing ? server?.name : `Add ${preset.name}`}</h2>
            <p className="truncate text-[12.5px] text-ink-3">{preset.description}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-3 hover:bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {status && server && (
            <div className="rounded-lg border border-line bg-canvas px-3 py-2.5 text-[12.5px]">
              <p className="flex items-center gap-2 text-ink-2">
                <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.label}
                {server.lastTestedAt && !server.testPending && (
                  <span className="text-ink-3">· tested {new Date(server.lastTestedAt).toLocaleString()}</span>
                )}
              </p>
              {server.testPending && <p className="mt-1 text-ink-3">Waiting for a running worker to pick up the test.</p>}
              {server.errorMessage && <p className="mt-1 break-words text-ink-2">{server.errorMessage}</p>}
              {server.toolNames && server.toolNames.length > 0 && (
                <p className="mt-1 break-words font-mono text-[11.5px] text-ink-3">{server.toolNames.join(", ")}</p>
              )}
            </div>
          )}

          <label className={LABEL}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
          </label>

          <label className={LABEL}>
            Scope
            <select value={scope} onChange={(e) => setScope(e.target.value)} className={INPUT}>
              <option value="global">Global (every project)</option>
              {projects.map((project) => (
                <option key={project._id} value={project._id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          {preset.fields.map((field) => (
            <label key={field.key} className={LABEL}>
              {field.label}
              <input
                value={fields[field.key] ?? ""}
                placeholder={field.placeholder}
                onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                className={`${INPUT} font-mono`}
              />
              {field.help && <span className="text-[12px] text-ink-3">{field.help}</span>}
            </label>
          ))}

          {preset.id === "custom" && (
            <>
              <div className="flex gap-1 rounded-lg border border-line bg-canvas p-1 text-[13px]">
                {(["local", "remote"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setType(option)}
                    className={`flex-1 rounded-md px-2 py-1 transition ${type === option ? "bg-bubble text-ink" : "text-ink-3 hover:text-ink"}`}
                  >
                    {option === "local" ? "Command (stdio)" : "URL (SSE/HTTP)"}
                  </button>
                ))}
              </div>
              {type === "local" ? (
                <>
                  <label className={LABEL}>
                    Command
                    <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className={`${INPUT} font-mono`} />
                  </label>
                  <label className={LABEL}>
                    Arguments (one per line)
                    <textarea
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      rows={3}
                      placeholder={"-y\n@scope/some-mcp-server\n{workspace}"}
                      className={`${INPUT} font-mono`}
                    />
                    <span className="text-[12px] text-ink-3">
                      {"{workspace}"} is the task workspace; {"{env:KEY}"} inserts a secret below.
                    </span>
                  </label>
                </>
              ) : (
                <label className={LABEL}>
                  URL
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" className={`${INPUT} font-mono`} />
                  <span className="text-[12px] text-ink-3">Saved only: the worker does not connect to remote servers yet.</span>
                </label>
              )}
            </>
          )}

          {preset.id === "github" && (
            <label className={`flex items-start gap-2 text-[13px] ${projectScoped ? "text-ink-2" : "text-ink-3"}`}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={projectScoped && useOAuth}
                disabled={!projectScoped}
                onChange={(e) => setUseOAuth(e.target.checked)}
              />
              <span>
                Use this project&apos;s GitHub connection
                {!projectScoped && <span className="block text-[12px]">Only for a project scope. A global server needs its own token.</span>}
              </span>
            </label>
          )}

          {(secretKeys.length > 0 || preset.id === "custom") && (
            <div className="space-y-3">
              <p className="text-[12.5px] text-ink-2">Secrets <span className="text-ink-3">· stored encrypted, never shown again</span></p>
              {secretKeys.map((key) => {
                const spec = preset.secrets.find((secret) => secret.key === key);
                const stored = storedKeys.includes(key) && !removeKeys.includes(key);
                const coveredByOAuth = oauthCoversToken && key === "GITHUB_PERSONAL_ACCESS_TOKEN";
                return (
                  <div key={key} className="grid gap-1.5">
                    <span className="flex items-baseline justify-between gap-2 text-[12.5px] text-ink-2">
                      <span>
                        {spec?.label ?? key} <span className="font-mono text-[11.5px] text-ink-3">{key}</span>
                      </span>
                      {spec?.required && <span className="text-[11.5px] text-ink-3">required</span>}
                    </span>
                    {coveredByOAuth ? (
                      <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink-3">From the GitHub connection</p>
                    ) : stored && !replacing[key] ? (
                      <div className="flex items-center gap-2">
                        <span className="flex-1 rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[13px] text-ink-3">••••••••</span>
                        <button type="button" className={GHOST_BTN} onClick={() => setReplacing((prev) => ({ ...prev, [key]: true }))}>
                          Replace
                        </button>
                        {!spec?.required && (
                          <button type="button" className={GHOST_BTN} onClick={() => setRemoveKeys((prev) => [...prev, key])}>
                            Clear
                          </button>
                        )}
                      </div>
                    ) : (
                      <input
                        type="password"
                        autoComplete="off"
                        value={secretValues[key] ?? ""}
                        placeholder={spec?.placeholder ?? (stored ? "New value" : "")}
                        onChange={(e) => setSecretValues((prev) => ({ ...prev, [key]: e.target.value }))}
                        className={`${INPUT} font-mono`}
                      />
                    )}
                    {spec?.help && !coveredByOAuth && <span className="text-[12px] text-ink-3">{spec.help}</span>}
                  </div>
                );
              })}
              {preset.id === "custom" && (
                <>
                  {customEnv.map((row, index) => (
                    <div key={index} className="flex gap-2">
                      <input
                        value={row.key}
                        placeholder="KEY"
                        onChange={(e) =>
                          setCustomEnv((prev) => prev.map((entry, i) => (i === index ? { ...entry, key: e.target.value.toUpperCase() } : entry)))
                        }
                        className={`${INPUT} w-2/5 font-mono`}
                      />
                      <input
                        type="password"
                        autoComplete="off"
                        value={row.value}
                        placeholder="value"
                        onChange={(e) => setCustomEnv((prev) => prev.map((entry, i) => (i === index ? { ...entry, value: e.target.value } : entry)))}
                        className={`${INPUT} font-mono`}
                      />
                    </div>
                  ))}
                  <button type="button" className={`${GHOST_BTN} inline-flex items-center gap-1`} onClick={() => setCustomEnv((prev) => [...prev, { key: "", value: "" }])}>
                    <Plus size={13} /> Add env var
                  </button>
                </>
              )}
            </div>
          )}

          {preset.id !== "filesystem" && (
            <label className={LABEL}>
              Allowed tools {preset.id !== "custom" && <span className="text-ink-3">(optional, beyond the preset&apos;s own)</span>}
              <input value={toolsText} onChange={(e) => setToolsText(e.target.value)} placeholder="tool_a, tool_b" className={`${INPUT} font-mono`} />
              <span className="text-[12px] text-ink-3">Listed tools are treated as read-only and offered to every allowed role.</span>
            </label>
          )}

          <div className="grid gap-1.5">
            <span className="text-[12.5px] text-ink-2">Roles <span className="text-ink-3">· none selected = all roles</span></span>
            <div className="flex flex-wrap gap-1.5">
              {ROLE_KEYS.map((role) => {
                const on = roles.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setRoles((prev) => (on ? prev.filter((entry) => entry !== role) : [...prev, role]))}
                    className={`rounded-full border px-2.5 py-1 text-[12.5px] transition ${
                      on ? "border-transparent bg-ink text-canvas" : "border-line text-ink-2 hover:bg-hover"
                    }`}
                  >
                    {roleLabel(role)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-5 text-[13px] text-ink-2">
            <span className="flex items-center gap-2">
              <Toggle on={enabled} onChange={setEnabled} label="Enabled" /> Enabled
            </span>
            {(preset.id !== "custom" || type === "local") && (
              <span className="flex items-center gap-2">
                <Toggle on={autoConnect} onChange={setAutoConnect} label="Start with each task" /> Start with each task
              </span>
            )}
          </div>

          <p className="text-[12px] text-ink-3">
            Needs {preset.requires}.{preset.note ? ` ${preset.note}` : ""}{" "}
            <a href={preset.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-ink-2 hover:text-ink">
              Docs <ExternalLink size={11} />
            </a>
          </p>
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          {server && (
            <>
              <button
                type="button"
                className={`${GHOST_BTN} text-red-600 dark:text-red-400`}
                onClick={() =>
                  setConfirm({
                    title: `Remove ${server.name}?`,
                    message: "Agents lose its tools on their next run. Stored secrets are deleted with it.",
                    confirmLabel: "Remove",
                  })
                }
              >
                Remove
              </button>
              <button type="button" className={GHOST_BTN} disabled={testing || server.testPending} onClick={() => void test()}>
                {server.testPending ? "Testing…" : "Test"}
              </button>
            </>
          )}
          <span className="flex-1" />
          <button type="button" className={GHOST_BTN} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={PRIMARY_BTN} disabled={saving || !name.trim()} onClick={() => void save()}>
            {saving ? "Saving…" : editing ? "Save" : "Add"}
          </button>
        </footer>
      </div>
      <ConfirmDialog request={confirm} pending={removing} onCancel={() => setConfirm(null)} onConfirm={() => void remove()} />
    </div>,
    document.body
  );
}

/**
 * Integrations: external connections and MCP servers, globally or per
 * project (`?project=<id>`). A run uses global + its project's enabled
 * servers; each server can be limited to some roles. Writes go through
 * /api/mcp-servers (service token stays server-side); secrets are sealed
 * by Convex and only their key names come back.
 */
function IntegrationsPage() {
  const router = useRouter();
  const projectId = useSearchParams().get("project") ?? undefined;
  const projects = useQuery(api.projects.list, {}) as Project[] | undefined;
  const servers = useQuery(api.mcpServers.list, projectId ? { projectId: projectId as never } : {}) as Server[] | undefined;
  const toast = useToast();
  const [modal, setModal] = useState<{ preset: McpPreset; server?: Server } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const projectName = useMemo(() => {
    const names = new Map((projects ?? []).map((project) => [String(project._id), project.name]));
    return (id?: string) => (id ? (names.get(String(id)) ?? "Project") : "Global");
  }, [projects]);

  // Keep the open modal's server row live (status, test results).
  const liveServer = modal?.server ? (servers ?? []).find((row) => row._id === modal.server!._id) : undefined;

  const toggle = async (server: Server, next: boolean) => {
    setBusy(server._id);
    try {
      await mcpAction("toggle", { serverId: server._id, enabled: next });
    } catch (err) {
      toast("error", "Couldn't update", errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const setProject = (value: string) => {
    router.replace(value ? `/integrations?project=${value}` : "/integrations");
  };

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <IconRail projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-[26px] font-semibold tracking-tight">Integrations</h1>
              <p className="mt-1 text-[15px] text-ink-2">Connections and MCP servers your agents can use.</p>
            </div>
            <select
              aria-label="Scope"
              value={projectId ?? ""}
              onChange={(e) => setProject(e.target.value)}
              className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] text-ink outline-none focus:border-line-strong"
            >
              <option value="">All projects</option>
              {(projects ?? []).map((project) => (
                <option key={project._id} value={project._id}>
                  {project.name}
                </option>
              ))}
            </select>
          </header>

          <Section title="Connected" count={servers ? servers.length + 1 : undefined}>
            {servers === undefined ? (
              <div className="space-y-3" aria-label="Loading integrations">
                {[0, 1].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-xl bg-hover" />
                ))}
              </div>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                <GithubOAuthRow projectId={projectId} />
                {servers.map((server) => {
                  const preset = presetFor(server);
                  const Icon = ICONS[preset.icon];
                  const status = statusInfo(server);
                  return (
                    <li key={server._id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setModal({ preset, server })}
                        onKeyDown={(e) => {
                          // Keys on the inner toggle belong to the toggle.
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setModal({ preset, server });
                          }
                        }}
                        className="flex cursor-pointer items-center gap-3 px-4 py-3 outline-none transition hover:bg-hover focus-visible:bg-hover"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bubble text-ink-2">
                          <Icon size={15} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={`truncate text-[14px] ${server.enabled === false ? "text-ink-3" : ""}`}>{server.name}</p>
                          <p className="truncate text-[12.5px] text-ink-3">
                            {projectName(server.projectId)} · {rolesText(server.agentRoles)} · {status.label}
                          </p>
                        </div>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} title={status.label} aria-hidden />
                        <Toggle
                          on={server.enabled !== false}
                          disabled={busy === server._id}
                          label={`${server.enabled === false ? "Enable" : "Disable"} ${server.name}`}
                          onChange={(next) => void toggle(server, next)}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {servers && servers.length === 0 && (
              <p className="mt-3 text-[13px] text-ink-3">No MCP servers yet. Add one below.</p>
            )}
          </Section>

          <Section title="Add">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {MCP_PRESETS.map((preset) => {
                const Icon = ICONS[preset.icon];
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setModal({ preset })}
                    className="flex flex-col items-start gap-2 rounded-xl border border-line bg-panel p-4 text-left transition hover:border-line-strong hover:bg-hover"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bubble text-ink-2">
                      <Icon size={15} />
                    </span>
                    <span className="text-[14px] font-medium">{preset.name}</span>
                    <span className="text-[12.5px] leading-snug text-ink-3">{preset.description}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-4 flex items-center gap-1.5 text-[12.5px] text-ink-3">
              <Plug size={13} /> A run uses global servers plus its project&apos;s, enabled only, limited to the roles you pick.
            </p>
          </Section>
        </div>
      </main>

      {modal && (
        <ServerModal
          key={modal.server?._id ?? modal.preset.id}
          preset={modal.preset}
          server={liveServer ?? modal.server}
          projects={projects ?? []}
          defaultProjectId={projectId}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <IntegrationsPage />
    </Suspense>
  );
}
