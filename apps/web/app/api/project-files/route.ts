import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo"]);
const MAX_FILES = 10_000;
const MAX_CONTENT = 7_000;

function getBase(workspacePath: string) {
  const trimmed = workspacePath.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.split(/[\\/]+/).includes("..")) {
    throw new Error("Invalid workspace path");
  }
  return path.resolve(trimmed);
}

function resolveFile(base: string, filePath: string) {
  const resolved = path.resolve(base, filePath.replace(/^[/\\]+/, ""));
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("File is outside the workspace");
  }
  return resolved;
}

async function collectFiles(base: string, current = base, result: string[] = []) {
  if (result.length >= MAX_FILES) return result;
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(base, absolute, result);
    } else if (entry.isFile()) {
      result.push(path.relative(base, absolute).split(path.sep).join("/"));
    }
    if (result.length >= MAX_FILES) break;
  }
  return result;
}

export async function GET(request: NextRequest) {
  try {
    const workspacePath = request.nextUrl.searchParams.get("workspacePath") ?? "";
    const filePath = request.nextUrl.searchParams.get("filePath");
    const base = getBase(workspacePath);

    if (filePath) {
      const content = await fs.readFile(resolveFile(base, filePath), "utf8");
      return NextResponse.json({ content: content.slice(0, MAX_CONTENT) });
    }

    const query = (request.nextUrl.searchParams.get("q") ?? "").toLowerCase();
    const files = (await collectFiles(base))
      .filter((file) => !query || file.toLowerCase().includes(query))
      .slice(0, 500);
    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to read project files" },
      { status: 400 },
    );
  }
}
