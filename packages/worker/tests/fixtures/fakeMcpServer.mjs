#!/usr/bin/env node
/**
 * Minimal MCP stdio server used by the worker's client/registry tests.
 * Not production code — implement just enough of the MCP protocol
 * (initialize / tools/list / tools/call) to exercise McpClient + registry.
 *
 * Usage: node fakeMcpServer.mjs [root] [--hang|--crash|--garbage]
 *   [root]          confinement root (default: cwd). The registry passes the
 *                   workspace via the `{workspace}` token in args.
 *   --hang          never respond (timeout / kill path).
 *   --crash         exit immediately with code 3 (dead server path).
 *   --garbage       emit a non-JSON line before the first response (the
 *                   client must drop protocol junk, not crash).
 * Also honours FAKE_MCP_MODE for direct (non-registry) invocation.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as readline from "node:readline";

const args = process.argv.slice(2);
const flag = args.find((a) => a.startsWith("--"));
const mode = process.env.FAKE_MCP_MODE ?? (flag ? flag.slice(2) : "normal");
const positional = args.filter((a) => !a.startsWith("--"));
const root = nodePath.resolve(positional[0] ?? process.env.FAKE_MCP_ROOT ?? process.cwd());

const TOOLS = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "read_multiple_files", description: "Read many files", inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } } },
  { name: "write_file", description: "Write a file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
  { name: "edit_file", description: "Edit a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "create_directory", description: "Create a directory", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "list_directory", description: "List a directory", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "directory_tree", description: "Directory tree", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "move_file", description: "Move a file", inputSchema: { type: "object", properties: { srcPath: { type: "string" }, destPath: { type: "string" } } } },
  { name: "search_files", description: "Search files", inputSchema: { type: "object", properties: { path: { type: "string" }, regex: { type: "string" } } } },
  { name: "get_file_info", description: "File info", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "list_allowed_directories", description: "Allowed directories", inputSchema: { type: "object", properties: {} } },
  { name: "delete_file", description: "Delete a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
];

function confine(target) {
  const resolved = nodePath.resolve(target);
  const rel = nodePath.relative(root, resolved);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
  return resolved;
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function handleCall(name, parameters) {
  const p = parameters ?? {};
  switch (name) {
    case "list_allowed_directories":
      return textResult(`Allowed directories:\n${root}`);
    case "read_file": {
      const target = confine(String(p.path ?? ""));
      if (!target) return textResult("path outside allowed directories", true);
      try {
        return textResult(await fs.readFile(target, "utf-8"));
      } catch (error) {
        return textResult(`read failed: ${error.message}`, true);
      }
    }
    case "list_directory": {
      const target = confine(String(p.path ?? ""));
      if (!target) return textResult("path outside allowed directories", true);
      try {
        const entries = await fs.readdir(target);
        return textResult(entries.map((e) => `[${e}]`).join("\n"));
      } catch (error) {
        return textResult(`list failed: ${error.message}`, true);
      }
    }
    case "get_file_info": {
      const target = confine(String(p.path ?? ""));
      if (!target) return textResult("path outside allowed directories", true);
      try {
        const stat = await fs.stat(target);
        return textResult(JSON.stringify({ size: stat.size, isDirectory: stat.isDirectory() }));
      } catch (error) {
        return textResult(`stat failed: ${error.message}`, true);
      }
    }
    case "search_files": {
      const target = confine(String(p.path ?? ""));
      if (!target) return textResult("path outside allowed directories", true);
      return textResult(`search in ${target} for ${String(p.regex ?? "")}`);
    }
    case "write_file": {
      const target = confine(String(p.path ?? ""));
      if (!target) return textResult("path outside allowed directories", true);
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.writeFile(target, String(p.content ?? ""), "utf-8");
      return textResult(`wrote ${target}`);
    }
    case "create_directory": {
      const target = confine(String(p.path ?? ""));
      if (!target) return textResult("path outside allowed directories", true);
      await fs.mkdir(target, { recursive: true });
      return textResult(`created ${target}`);
    }
    default:
      return textResult(`unknown tool: ${name}`, true);
  }
}

if (mode === "crash") {
  process.exit(3);
}

const rl = readline.createInterface({ input: process.stdin });
let garbageEmitted = false;

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // not protocol JSON — ignore
  }
  const id = message.id;
  if (id === undefined || id === null) return; // notification: no reply
  if (mode === "hang") return; // wedged server: never answer

  if (mode === "garbage" && !garbageEmitted) {
    garbageEmitted = true;
    process.stdout.write("this-is-not-json\n");
  }

  const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  try {
    switch (message.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-filesystem", version: "1.0.0" },
          },
        });
        break;
      case "ping":
        send({ jsonrpc: "2.0", id, result: {} });
        break;
      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        break;
      case "tools/call": {
        const { name, arguments: parameters } = message.params ?? {};
        send({ jsonrpc: "2.0", id, result: await handleCall(name, parameters) });
        break;
      }
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
  }
});
