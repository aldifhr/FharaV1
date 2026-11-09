/**
 * Curated MCP server presets for the /integrations page.
 *
 * Pure TypeScript (no Convex, Node or DOM APIs): imported by the Convex
 * backend (create-from-preset), the web app (preset tiles and modal fields,
 * via `@/api/convex/lib/mcpPresets`) and the worker (tool → action policy).
 *
 * Every preset is a LOCAL stdio server, because stdio is the only transport
 * the worker launches today (packages/worker/src/mcp/client.ts). The
 * `custom` preset can also store a remote URL, which is saved and shown but
 * not connected by the worker (see `REMOTE_UNSUPPORTED_MESSAGE`).
 *
 * Arg templates:
 *  - `{workspace}`   the run's workspace path (filled by the worker at spawn)
 *  - `{field:<key>}` a plain (non-secret) field value, filled at create time
 *  - `{env:<KEY>}`   a SECRET value, filled by the worker at spawn from the
 *                    decrypted env. It never lives in the stored args.
 */

export type McpPresetId = "filesystem" | "github" | "playwright" | "postgres" | "fetch" | "custom";

export type McpToolActionKind = "read" | "list" | "write" | "move" | "delete";

export interface McpPresetField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  help?: string;
  required?: boolean;
}

export interface McpPresetSecret {
  /** Env var name the server reads (or the `{env:KEY}` arg placeholder). */
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  required: boolean;
}

export interface McpPreset {
  id: McpPresetId;
  name: string;
  /** One line for the tile. */
  description: string;
  /** lucide-react icon name the web maps to a component. */
  icon: "FolderTree" | "GitBranch" | "Globe" | "Database" | "Download" | "Terminal";
  command: string;
  /** Arg template (see header). */
  args: string[];
  fields: McpPresetField[];
  /** Required/optional env keys, stored encrypted. */
  secrets: McpPresetSecret[];
  docsUrl: string;
  /** What the host must have for the worker to spawn it. */
  requires: string;
  /** Free-form note shown in the modal (maintenance status etc.). */
  note?: string;
}

export const REMOTE_UNSUPPORTED_MESSAGE =
  "Saved, not connected: the worker only launches local stdio MCP servers today. Remote (SSE/HTTP) servers are stored for later.";

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read and search files inside the project workspace.",
    icon: "FolderTree",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{field:root}"],
    fields: [
      {
        key: "root",
        label: "Root path",
        defaultValue: "{workspace}",
        placeholder: "{workspace}",
        help: "{workspace} is the task's workspace. Any other root must be an absolute path.",
        required: true,
      },
    ],
    secrets: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    requires: "Node.js (npx)",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Issues, pull requests and code search through GitHub's MCP server.",
    icon: "GitBranch",
    command: "docker",
    args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
    fields: [],
    secrets: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "GitHub token",
        placeholder: "github_pat_…",
        help: "Leave empty on a project scope to use the project's connected GitHub account.",
        required: false,
      },
    ],
    docsUrl: "https://github.com/github/github-mcp-server",
    requires: "Docker",
    note: "Runs GitHub's official server image over stdio. Push and PRs from tasks keep using the OAuth connection.",
  },
  {
    id: "playwright",
    name: "Browser automation",
    description: "Drive a real browser with Playwright: open pages, read, click, type.",
    icon: "Globe",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless"],
    fields: [],
    secrets: [],
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    requires: "Node.js (npx); first run downloads a browser",
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "Run read-only SQL queries and inspect a database schema.",
    icon: "Database",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "{env:DATABASE_URL}"],
    fields: [],
    secrets: [
      {
        key: "DATABASE_URL",
        label: "Database URL",
        placeholder: "postgresql://user:pass@host:5432/db",
        required: true,
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres",
    requires: "Node.js (npx)",
    note: "Archived reference server: queries run in read-only transactions. The URL is passed as a process argument.",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetch a URL and return it as markdown.",
    icon: "Download",
    command: "uvx",
    args: ["mcp-server-fetch"],
    fields: [],
    secrets: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    requires: "uv (uvx) on the worker host",
  },
  {
    id: "custom",
    name: "Custom",
    description: "Any stdio command, or a remote URL saved for later.",
    icon: "Terminal",
    command: "",
    args: [],
    fields: [],
    secrets: [],
    docsUrl: "https://modelcontextprotocol.io/docs/learn/server-concepts",
    requires: "Whatever the command needs",
    note: "Custom servers expose only the tools you list under Allowed tools.",
  },
];

export function getMcpPreset(id: string | undefined): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}

const FIELD_TOKEN = /^\{field:([A-Za-z0-9_]+)\}$/;

/**
 * Fill `{field:key}` tokens from plain field values. `{workspace}` and
 * `{env:KEY}` pass through untouched (the worker fills them at spawn).
 * A missing field falls back to its default, then to an empty arg, which is
 * dropped.
 */
export function buildPresetArgs(preset: McpPreset, fields: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const arg of preset.args) {
    const match = FIELD_TOKEN.exec(arg);
    if (!match) {
      out.push(arg);
      continue;
    }
    const field = preset.fields.find((entry) => entry.key === match[1]);
    const value = (fields[match[1]] ?? field?.defaultValue ?? "").trim();
    if (value) out.push(value);
  }
  return out;
}

/** Recover plain field values from stored args (for the edit modal). */
export function fieldsFromArgs(preset: McpPreset, args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  preset.args.forEach((template, index) => {
    const match = FIELD_TOKEN.exec(template);
    if (match && args[index] !== undefined) values[match[1]] = args[index];
  });
  return values;
}

// ---------------------------------------------------------------------------
// Tool policy (read by the worker's permission layer).
// ---------------------------------------------------------------------------

const PLAYWRIGHT_READ = new Set([
  "browser_snapshot",
  "browser_navigate",
  "browser_navigate_back",
  "browser_navigate_forward",
  "browser_take_screenshot",
  "browser_tabs",
  "browser_tab_list",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
  "browser_close",
  "browser_resize",
]);
const PLAYWRIGHT_WRITE = new Set([
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_file_upload",
  "browser_handle_dialog",
  "browser_evaluate",
]);

/**
 * Tool → action for a non-filesystem preset, or `null` when the preset does
 * not know the tool (the worker then denies it: fail closed). Filesystem and
 * legacy rows (no preset) keep the worker's own filesystem table.
 */
export function presetToolAction(
  presetId: string | undefined,
  tool: string,
  toolAllowlist?: readonly string[]
): McpToolActionKind | null {
  switch (presetId) {
    case "fetch":
      return tool === "fetch" ? "read" : allowlisted(tool, toolAllowlist);
    case "postgres":
      // The reference server runs every query in a READ ONLY transaction.
      return tool === "query" ? "read" : allowlisted(tool, toolAllowlist);
    case "playwright":
      if (PLAYWRIGHT_READ.has(tool)) return "read";
      if (PLAYWRIGHT_WRITE.has(tool)) return "write";
      return allowlisted(tool, toolAllowlist);
    case "github":
      if (/^(get|list|search)_/.test(tool)) return "read";
      if (/^(create|update|add|push|merge|fork|request|assign|reply|submit|dismiss|mark|manage)_/.test(tool)) return "write";
      if (/^delete_/.test(tool)) return "delete";
      return allowlisted(tool, toolAllowlist);
    case "custom":
      return allowlisted(tool, toolAllowlist);
    default:
      return null;
  }
}

function allowlisted(tool: string, list: readonly string[] | undefined): McpToolActionKind | null {
  return list?.includes(tool) ? "read" : null;
}

/** Whether call-time path validation (filesystem roots) applies to a preset. */
export function presetChecksPaths(presetId: string | undefined): boolean {
  return presetId === undefined || presetId === "filesystem";
}

/**
 * Role allowlist match. An empty/missing allowlist means every role. A role
 * matches when its free-form value equals an allowed key, or names it
 * ("Frontend Engineer" → frontend; "QA" → qa).
 */
export function mcpRoleAllowed(agentRoles: readonly string[] | undefined, role: string | undefined): boolean {
  if (!agentRoles || agentRoles.length === 0) return true;
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  return agentRoles.some((allowed) => {
    const key = allowed.trim().toLowerCase();
    if (!key) return false;
    if (normalized === key) return true;
    return new RegExp(`(^|[^a-z])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(normalized);
  });
}

/** Env key names the user may set: shell-safe and not a worker secret. */
export const MCP_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MCP_RESERVED_ENV_KEYS = new Set([
  "CONVEX_SERVICE_TOKEN",
  "PROVIDER_ENCRYPTION_KEY",
  "PROVIDER_ENCRYPTION_KEY_OLD",
  "CONVEX_DEPLOY_KEY",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "PATH",
]);
