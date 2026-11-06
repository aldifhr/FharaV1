import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readFile } from "@/tools/readFile";

const IGNORED = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".convex",
  ".turbo",
  ".qa",
  "coverage",
]);

const SOURCE_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|html|vue|svelte)$/i;

export interface RepositoryContextOptions {
  fileHint?: string | null;
  maxFiles?: number;
  maxFilesToRead?: number;
  maxCharsPerFile?: number;
}

export async function exploreRepository(
  workspaceRoot: string,
  options: RepositoryContextOptions = {}
): Promise<{ context: string; files: string[] }> {
  const maxFiles = options.maxFiles ?? 120;
  const maxFilesToRead = options.maxFilesToRead ?? 8;
  const maxCharsPerFile = options.maxCharsPerFile ?? 12_000;
  const files: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 3 || files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignored(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (SOURCE_EXTENSIONS.test(entry.name)) {
        files.push(path.relative(workspaceRoot, absolute).replace(/\\/g, "/"));
      }
      if (files.length >= maxFiles) return;
    }
  }

  await visit(workspaceRoot, 0);

  const hint = options.fileHint?.toLowerCase() ?? null;
  const candidates = hint
    ? files.filter((file) => file.toLowerCase().includes(hint))
    : [];

  // Prefer hinted files, then prefer shallow/source files over dumps.
  const ordered = [
    ...new Set([
      ...candidates,
      ...files.slice().sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b)),
    ]),
  ].slice(0, maxFilesToRead * 2);

  const selected = ordered.slice(0, maxFilesToRead);
  const sections: string[] = [`Workspace files:\n${ordered.slice(0, 60).join("\n")}`];
  for (const file of selected) {
    try {
      const content = await readFile(workspaceRoot, file);
      sections.push(`\n--- ${file} ---\n${content.slice(0, maxCharsPerFile)}`);
    } catch (error) {
      sections.push(
        `\n--- ${file} unavailable: ${error instanceof Error ? error.message : String(error)} ---`
      );
    }
  }
  return { context: sections.join("\n"), files };
}

export function ignored(name: string): boolean {
  return IGNORED.has(name) || name.startsWith(".qa");
}

function depthOf(file: string): number {
  return file.split("/").length;
}
