import { execFile } from "node:child_process";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/api/convex/_generated/api";
import type { Id } from "@/api/convex/_generated/dataModel";
import { rejectUnsafeRequest } from "@/lib/apiGuard";
import { publicConvexUrl } from "@/lib/env.client";
import {
  LAUNCHERS,
  OpenInPolicyError,
  checkLoopbackRequest,
  isLauncherId,
  launcherCommand,
  resolveOpenTarget,
} from "@/lib/openInPolicy";
import { resolveWorkspaceBase } from "@/lib/projectFilesPolicy";

/**
 * POST /api/open-in { projectId, taskId?, launcher }: open the project's
 * folder (or the task's worktree) in a local editor or the file manager.
 * Loopback only; the folder is looked up server-side and must sit under the
 * project's known roots; the launcher is an allowlisted id run through
 * execFile with no shell.
 */

export const runtime = "nodejs";

class NotFound extends Error {}

type ProjectRow = { workspacePath?: string; worktreesPath?: string } | null;
type TaskRow = { projectId?: string; worktreePath?: string } | null;

async function lookupTarget(projectId: string, taskId: string | null): Promise<{ folder: string; roots: string[] }> {
  const convexUrl = publicConvexUrl();
  if (!convexUrl) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured on the web server.");
  const client = new ConvexHttpClient(convexUrl);
  let project: ProjectRow;
  try {
    project = (await client.query(api.projects.get, { projectId })) as ProjectRow;
  } catch {
    throw new NotFound("Project not found");
  }
  if (!project?.workspacePath) throw new NotFound("Project has no workspace");
  const base = resolveWorkspaceBase(project.workspacePath);
  // Known roots: the project's workspace, and its worktrees folder when it
  // is configured elsewhere (the default .moagent-worktrees sits inside).
  const roots = [base];
  if (project.worktreesPath?.trim()) roots.push(path.resolve(base, project.worktreesPath.trim()));
  if (!taskId) return { folder: base, roots };

  let task: TaskRow;
  try {
    task = (await client.query(api.tasks.get, { taskId: taskId as Id<"tasks"> })) as TaskRow;
  } catch {
    throw new NotFound("Task not found");
  }
  if (!task || String(task.projectId) !== projectId) throw new NotFound("Task not found");
  if (!task.worktreePath) throw new NotFound("This task has no worktree");
  return { folder: resolveWorkspaceBase(task.worktreePath), roots };
}

function launch(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { shell: false, windowsHide: true }, () => undefined);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function POST(request: NextRequest) {
  const rejected = rejectUnsafeRequest(request);
  if (rejected) return rejected;
  const loopback = checkLoopbackRequest(request);
  if (!loopback.ok) return NextResponse.json({ error: loopback.reason }, { status: 403 });

  let body: { projectId?: unknown; taskId?: unknown; launcher?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const taskId = typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : null;
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  if (!isLauncherId(body.launcher)) return NextResponse.json({ error: "Unknown launcher" }, { status: 400 });
  const launcher = body.launcher;

  try {
    const { folder, roots } = await lookupTarget(projectId, taskId);
    const real = await resolveOpenTarget(folder, roots);
    const { file, args } = launcherCommand(launcher, real);
    try {
      await launch(file, args);
    } catch (error) {
      const label = LAUNCHERS[launcher].label;
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return NextResponse.json(
        { error: missing ? `${label} was not found on this computer (${file} is not on PATH).` : `Could not start ${label}.` },
        { status: 422 },
      );
    }
    return NextResponse.json({ ok: true, launcher, folder: path.basename(real) });
  } catch (error) {
    if (error instanceof NotFound) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof OpenInPolicyError) return NextResponse.json({ error: error.message }, { status: 403 });
    return NextResponse.json({ error: "Unable to open the folder" }, { status: 400 });
  }
}
