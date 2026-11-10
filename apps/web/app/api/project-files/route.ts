import { promises as fs } from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/api/convex/_generated/api";
import { rejectUnsafeRequest } from "@/lib/apiGuard";
import {
  PathPolicyError,
  isDeniedPath,
  resolveContainedFile,
  resolveWorkspaceBase,
} from "@/lib/projectFilesPolicy";
import { publicConvexUrl } from "@/lib/env.client";

/**
 * Read-only file listing / preview for a registered project (release audit
 * P0-2). The caller names a `projectId`; the workspace directory is looked
 * up server-side in Convex, never taken from the request. Every file is
 * realpath-contained under that directory and secret-shaped files
 * (.env*, .git internals, keys) are neither listed nor read.
 */

export const runtime = "nodejs";

const IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo"]);
const MAX_FILES = 10_000;
const MAX_CONTENT = 7_000;
const MAX_TEXT_READ = 1_000_000;

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
    const relative = path.relative(base, absolute).split(path.sep).join("/");
    if (isDeniedPath(relative)) continue;
    // Symlinks are not followed while listing (entry.isDirectory/isFile are
    // false for them), so a link cannot pull outside files into the list.
    if (entry.isDirectory()) {
      await collectFiles(base, absolute, result);
    } else if (entry.isFile()) {
      result.push(relative);
    }
    if (result.length >= MAX_FILES) break;
  }
  return result;
}

class NotFound extends Error {}

/** The project's workspace directory, from Convex, realpath'd. */
async function projectBase(projectId: string): Promise<string> {
  const convexUrl = publicConvexUrl();
  if (!convexUrl) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured on the web server.");
  const client = new ConvexHttpClient(convexUrl);
  let project: { workspacePath?: string } | null;
  try {
    project = (await client.query(api.projects.get, { projectId })) as { workspacePath?: string } | null;
  } catch {
    throw new NotFound("Project not found");
  }
  if (!project?.workspacePath) throw new NotFound("Project has no workspace");
  const base = resolveWorkspaceBase(project.workspacePath);
  try {
    return await fs.realpath(base);
  } catch {
    throw new NotFound("Workspace directory not found");
  }
}

export async function GET(request: NextRequest) {
  const rejected = rejectUnsafeRequest(request);
  if (rejected) return rejected;
  try {
    const projectId = (request.nextUrl.searchParams.get("projectId") ?? "").trim();
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    const base = await projectBase(projectId);
    const filePath = request.nextUrl.searchParams.get("filePath");

    if (filePath) {
      if (path.basename(filePath) === ".DS_Store") {
        return NextResponse.json({ content: "", binary: true, reason: "System file — preview not available" });
      }
      const resolved = await resolveContainedFile(base, filePath);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return NextResponse.json({ error: "Not a file" }, { status: 400 });
      const mime = imageMimeFor(filePath);
      if (mime) {
        if (stat.size > IMAGE_MAX) {
          return NextResponse.json({ content: "", binary: true, reason: "Image too large to preview" });
        }
        const raw = await fs.readFile(resolved);
        return NextResponse.json({ content: "", image: true, mime, data: raw.toString("base64") });
      }
      // Read only the head of large text files; the preview is capped anyway.
      const handle = await fs.open(resolved, "r");
      let raw: Buffer;
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_READ));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        raw = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      if (isBinary(raw)) {
        return NextResponse.json({ content: "", binary: true, reason: "Binary file — preview not available" });
      }
      return NextResponse.json({ content: raw.toString("utf8").slice(0, MAX_CONTENT) });
    }

    const query = (request.nextUrl.searchParams.get("q") ?? "").toLowerCase();
    const files = (await collectFiles(base))
      .filter((file) => !query || file.toLowerCase().includes(query))
      .slice(0, 500);
    return NextResponse.json({ files });
  } catch (error) {
    if (error instanceof NotFound) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof PathPolicyError) return NextResponse.json({ error: error.message }, { status: 403 });
    return NextResponse.json({ error: "Unable to read project files" }, { status: 400 });
  }
}
