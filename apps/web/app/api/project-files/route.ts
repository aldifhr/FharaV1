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

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};
const IMAGE_MAX = 2_000_000;

// ponytail: base64 data-URL is fine for local preview; upgrade to blob URLs if files grow
function imageMimeFor(filePath: string): string | null {
  return IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? null;
}

function isBinary(buf: Buffer) {
  return buf.subarray(0, 8000).includes(0);
}

async function collectFiles(base: string, current = base, result: string[] = []) {
  if (result.length >= MAX_FILES) return result;
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.name === ".DS_Store") continue;
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
      if (path.basename(filePath) === ".DS_Store") {
        return NextResponse.json({ content: "", binary: true, reason: "System file — preview not available" });
      }
      const mime = imageMimeFor(filePath);
      const resolved = resolveFile(base, filePath);
      const raw = await fs.readFile(resolved);
      if (mime) {
        if (raw.length > IMAGE_MAX) {
          return NextResponse.json({ content: "", binary: true, reason: "Image too large to preview" });
        }
        return NextResponse.json({
          content: "",
          image: true,
          mime,
          data: raw.toString("base64"),
        });
      }
      if (isBinary(raw)) {
        return NextResponse.json({ content: "", binary: true, reason: "Binary file — preview not available" });
      }
      const content = raw.toString("utf8");
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
