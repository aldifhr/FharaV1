/**
 * Plan 009: MCP permission matrix + path authorization.
 *
 * Invariants: traversal/absolute paths outside the root set are refused;
 * symlinks pointing out are refused; protected names never pass; write
 * tools are filtered for every role by default; `supportedTools` scope
 * applies; system roots are never valid.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  actionForTool,
  authorizeToolCall,
  filterToolsForAgent,
  isForbiddenRoot,
  permissionsForRole,
  REASON_PATH_FORBIDDEN,
  REASON_PATH_INVALID,
  REASON_PATH_OUTSIDE,
  REASON_TOOL_DENIED,
  REASON_TOOL_UNKNOWN,
} from "@/mcp/permissions";
import type { McpToolDefinition } from "@/mcp/types";

const TOOLS: McpToolDefinition[] = [
  { name: "read_file", description: "read", inputSchema: {} },
  { name: "read_multiple_files", description: "read many", inputSchema: {} },
  { name: "list_directory", description: "list", inputSchema: {} },
  { name: "directory_tree", description: "tree", inputSchema: {} },
  { name: "get_file_info", description: "info", inputSchema: {} },
  { name: "list_allowed_directories", description: "dirs", inputSchema: {} },
  { name: "search_files", description: "search", inputSchema: {} },
  { name: "write_file", description: "write", inputSchema: {} },
  { name: "edit_file", description: "edit", inputSchema: {} },
  { name: "create_directory", description: "mkdir", inputSchema: {} },
  { name: "move_file", description: "move", inputSchema: {} },
  { name: "delete_file", description: "delete", inputSchema: {} },
  { name: "unknown_tool", description: "mystery", inputSchema: {} },
];

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-mcp-ws-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-mcp-out-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.ts"), "export {};", "utf-8");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf-8");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("tool -> action mapping", () => {
  it("maps the reference filesystem tools", () => {
    expect(actionForTool("read_file")).toBe("read");
    expect(actionForTool("read_multiple_files")).toBe("read");
    expect(actionForTool("list_directory")).toBe("list");
    expect(actionForTool("directory_tree")).toBe("list");
    expect(actionForTool("get_file_info")).toBe("read");
    expect(actionForTool("list_allowed_directories")).toBe("list");
    expect(actionForTool("search_files")).toBe("read");
    expect(actionForTool("write_file")).toBe("write");
    expect(actionForTool("edit_file")).toBe("write");
    expect(actionForTool("create_directory")).toBe("write");
    expect(actionForTool("move_file")).toBe("move");
    expect(actionForTool("delete_file")).toBe("delete");
  });

  it("maps unknown tools to unknown (fail closed)", () => {
    expect(actionForTool("unknown_tool")).toBe("unknown");
    expect(actionForTool("")).toBe("unknown");
  });
});

describe("role matrix", () => {
  it("developer can write/move but never delete", () => {
    const permission = permissionsForRole("Frontend Engineer");
    expect(permission).toMatchObject({ read: true, write: true, move: true, delete: false });
  });

  it("qa/researcher/orchestrator are read-only", () => {
    expect(permissionsForRole("QA Engineer")).toMatchObject({ read: true, write: false, move: false, delete: false });
    expect(permissionsForRole("Researcher")).toMatchObject({ read: true, write: false });
    expect(permissionsForRole("Orchestrator")).toMatchObject({ read: true, write: false });
  });

  it("unknown or missing roles get the read-only default", () => {
    expect(permissionsForRole("Wizard")).toMatchObject({ read: true, write: false, move: false, delete: false });
    expect(permissionsForRole(undefined)).toMatchObject({ read: true, write: false });
  });
});

describe("filterToolsForAgent", () => {
  it("hides write tools for every role by default", () => {
    for (const role of ["developer", "qa", "researcher", "orchestrator", "wizard"]) {
      const visible = filterToolsForAgent(TOOLS, { role }).map((t) => t.name);
      expect(visible).toContain("read_file");
      expect(visible).toContain("list_directory");
      for (const write of ["write_file", "edit_file", "create_directory", "move_file", "delete_file"]) {
        expect(visible).not.toContain(write);
      }
      // Unknown tools are never shown either.
      expect(visible).not.toContain("unknown_tool");
    }
  });

  it("shows write tools for developers only when the knob allows", () => {
    const names = filterToolsForAgent(TOOLS, { role: "developer", allowWrite: true }).map((t) => t.name);
    expect(names).toContain("write_file");
    expect(names).toContain("create_directory");
    expect(names).toContain("move_file");
    // Delete stays forbidden even for developers.
    expect(names).not.toContain("delete_file");
  });

  it("still hides write tools from qa even with the knob on", () => {
    const names = filterToolsForAgent(TOOLS, { role: "qa", allowWrite: true }).map((t) => t.name);
    expect(names).not.toContain("write_file");
  });

  it("respects the supportedTools scope", () => {
    const names = filterToolsForAgent(TOOLS, {
      role: "researcher",
      supportedTools: ["read_file", "search_files"],
    }).map((t) => t.name);
    expect(names).toEqual(["read_file", "search_files"]);
  });
});

describe("authorizeToolCall", () => {
  it("allows a read inside the roots", async () => {
    const result = await authorizeToolCall({
      tool: "read_file",
      args: { path: path.join(root, "src", "index.ts") },
      scope: { role: "researcher" },
      allowedRoots: [root],
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an unknown tool", async () => {
    const result = await authorizeToolCall({
      tool: "unknown_tool",
      args: {},
      scope: { role: "developer", allowWrite: true },
      allowedRoots: [root],
    });
    expect(result).toEqual({ ok: false, reason: REASON_TOOL_UNKNOWN });
  });

  it("refuses a write call for a read-only role at call time, even if it was listed", async () => {
    const result = await authorizeToolCall({
      tool: "write_file",
      args: { path: path.join(root, "src", "new.ts") },
      scope: { role: "researcher" },
      allowedRoots: [root],
    });
    expect(result).toEqual({ ok: false, reason: REASON_TOOL_DENIED });
  });

  it("refuses relative paths", async () => {
    const result = await authorizeToolCall({
      tool: "read_file",
      args: { path: "src/index.ts" },
      scope: { role: "researcher" },
      allowedRoots: [root],
    });
    expect(result).toEqual({ ok: false, reason: REASON_PATH_INVALID });
  });

  it("refuses absolute paths outside the root set", async () => {
    const result = await authorizeToolCall({
      tool: "read_file",
      args: { path: path.join(outside, "secret.txt") },
      scope: { role: "researcher" },
      allowedRoots: [root],
    });
    expect(result).toEqual({ ok: false, reason: REASON_PATH_OUTSIDE });
  });

  it("refuses paths that escape via ../", async () => {
    const traversal = path.join(root, "..", path.basename(outside), "secret.txt");
    const result = await authorizeToolCall({
      tool: "read_file",
      args: { path: traversal },
      scope: { role: "researcher" },
      allowedRoots: [root],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(REASON_PATH_OUTSIDE);
  });

  it("refuses a symlink inside the workspace pointing outside", async () => {
    const link = path.join(root, "link-out");
    await fs.symlink(outside, link);
    const result = await authorizeToolCall({
      tool: "read_file",
      args: { path: path.join(link, "secret.txt") },
      scope: { role: "researcher" },
      allowedRoots: [root],
    });
    expect(result).toEqual({ ok: false, reason: REASON_PATH_OUTSIDE });
  });

  it("allows a symlink that stays inside the workspace", async () => {
    const link = path.join(root, "link-in");
    await fs.symlink(path.join(root, "src"), link);
    const result = await authorizeToolCall({
      tool: "read_file",
      args: { path: path.join(link, "index.ts") },
      scope: { role: "researcher" },
      allowedRoots: [root],
    });
    expect(result.ok).toBe(true);
  });

  it("refuses protected names even inside the roots", async () => {
    for (const name of [".env", ".git/config", "node_modules/x.js", ".ssh/id_rsa", "key.pem"]) {
      const result = await authorizeToolCall({
        tool: "read_file",
        args: { path: path.join(root, name) },
        scope: { role: "researcher" },
        allowedRoots: [root],
      });
      expect(result).toEqual({ ok: false, reason: REASON_PATH_FORBIDDEN });
    }
  });

  it("checks every path argument, including move destinations", async () => {
    const result = await authorizeToolCall({
      tool: "move_file",
      args: { srcPath: path.join(root, "src", "index.ts"), destPath: path.join(outside, "y.ts") },
      scope: { role: "developer", allowWrite: true },
      allowedRoots: [root],
    });
    expect(result).toEqual({ ok: false, reason: REASON_PATH_OUTSIDE });
  });
});

describe("isForbiddenRoot", () => {
  it("never allows system roots", () => {
    for (const bad of ["/", "/etc", "/proc", "/sys", "/dev", "/root", "/boot"]) {
      expect(isForbiddenRoot(bad)).toBe(true);
    }
  });

  it("allows normal project directories", () => {
    expect(isForbiddenRoot(root)).toBe(false);
    expect(isForbiddenRoot("/Users/aldi/dev/project")).toBe(false);
  });
});
