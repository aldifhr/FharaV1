import { extractJson, type DraftFile } from "@/utils/json";

/**
 * Some models (e.g. meituan/longcat via the `nous` connection) answer a
 * JSON-only prompt with native tool-call markup instead:
 *
 *   <longcat_tool_call>{"name":"read_file","arguments":{"path":"src/a.js"}}</longcat_tool_call>
 *   <longcat_tool_call>read_file
 *   <longcat_arg_key>path</longcat_arg_key><longcat_arg_value>src/a.js</longcat_arg_value>
 *   </longcat_tool_call>
 *
 * The executor exposes no tools on that path, so the markup is parsed
 * here: write-style calls become file drafts, read-style calls become
 * file requests, and the markup is stripped from the text that is parsed
 * as JSON or shown in chat.
 */
export interface MarkupToolCall {
  name: string;
  args: Record<string, unknown>;
}

const BLOCK = /<([A-Za-z0-9_-]*tool_call)\b[^>]*>([\s\S]*?)(?:<\/\1>|$)/gi;
const ARG_PAIR =
  /<([A-Za-z0-9_-]*arg_key)>([\s\S]*?)<\/\1>\s*<([A-Za-z0-9_-]*arg_value)>([\s\S]*?)<\/\3>/gi;
/** Stray wrapper tags (`<tool_calls>`, `</longcat_tool_call>` without opener, ...). */
const STRAY_TAG = /<\/?[A-Za-z0-9_-]*tool_calls?\b[^>]*>/gi;

function parseArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  return {};
}

function parseBlock(body: string): MarkupToolCall | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    const json = extractJson(trimmed);
    if (json && typeof json === "object") {
      const value = json as Record<string, unknown>;
      const fn = (value.function && typeof value.function === "object" ? value.function : value) as Record<string, unknown>;
      const name = typeof fn.name === "string" ? fn.name : typeof value.tool === "string" ? value.tool : "";
      const args = parseArgs(fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? value.arguments);
      return { name, args };
    }
  }
  // GLM/longcat XML style: "<name>\n<x_arg_key>k</x_arg_key><x_arg_value>v</x_arg_value>..."
  const args: Record<string, unknown> = {};
  for (const match of trimmed.matchAll(ARG_PAIR)) {
    const key = match[2].trim();
    const raw = match[4];
    args[key] = raw;
  }
  const firstTag = trimmed.search(/<[A-Za-z0-9_-]*arg_key>/);
  const name = (firstTag >= 0 ? trimmed.slice(0, firstTag) : trimmed.split("\n")[0]).trim();
  // A bare path inside the block ("<x_tool_call>src/a.js</x_tool_call>").
  if (Object.keys(args).length === 0 && /^[\w./-]+\.[A-Za-z0-9]{1,6}$/.test(name)) {
    return { name: "read_file", args: { path: name } };
  }
  return { name, args };
}

/** Tool calls in the content plus the content with all tool-call markup removed. */
export function parseToolCallMarkup(content: string): { calls: MarkupToolCall[]; stripped: string; hadMarkup: boolean } {
  const calls: MarkupToolCall[] = [];
  let hadMarkup = false;
  const stripped = content
    .replace(BLOCK, (_all, _tag, body: string) => {
      hadMarkup = true;
      const call = parseBlock(body);
      if (call) calls.push(call);
      return "";
    })
    .replace(STRAY_TAG, () => {
      hadMarkup = true;
      return "";
    })
    .trim();
  return { calls, stripped, hadMarkup };
}

/** Remove tool-call markup (for chat output and JSON parsing). */
export function stripToolCallMarkup(content: string): string {
  return parseToolCallMarkup(content).stripped;
}

const PATH_KEYS = ["filePath", "file_path", "path", "filename", "file", "target_file", "targetFile"];
const CONTENT_KEYS = ["newContent", "new_content", "content", "contents", "file_text", "text", "code"];
const WRITE_NAME = /write|create|save|put|overwrite/i;

function stringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Split tool calls into full-file writes (usable as a draft) and paths
 * the model wanted to read. Partial edits (str_replace, patch) are not
 * trusted as drafts: their paths are treated as read requests so the
 * retry can return the full file.
 */
export function classifyToolCalls(calls: MarkupToolCall[]): { files: DraftFile[]; readPaths: string[] } {
  const files: DraftFile[] = [];
  const readPaths: string[] = [];
  for (const call of calls) {
    const paths: string[] = [];
    const single = stringArg(call.args, PATH_KEYS);
    if (single) paths.push(single);
    for (const key of ["paths", "files", "file_paths", "filePaths"]) {
      const list = call.args[key];
      if (Array.isArray(list)) for (const item of list) if (typeof item === "string") paths.push(item);
    }
    const content = stringArg(call.args, CONTENT_KEYS);
    if (single && content !== undefined && WRITE_NAME.test(call.name)) {
      files.push({ filePath: single.replace(/^\.\//, ""), newContent: content });
      continue;
    }
    readPaths.push(...paths.map((p) => p.replace(/^\.\//, "")));
  }
  return { files, readPaths: Array.from(new Set(readPaths)) };
}
