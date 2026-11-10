import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafeRequest } from "@/lib/apiGuard";

/**
 * Settings → About: the app version, the git commit this checkout runs,
 * and THIRD_PARTY_NOTICES.md. Read-only, local files only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// apps/web → repo root (next runs with cwd = apps/web).
const repoRoot = path.resolve(process.cwd(), "../..");

function git(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: repoRoot, timeout: 5_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

async function readJson(file: string): Promise<{ name?: string; version?: string } | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

/** A dependency's package.json (workspace node_modules, then the hoisted root). */
async function packageVersion(name: string): Promise<{ version?: string } | null> {
  return (
    (await readJson(path.join(process.cwd(), "node_modules", name, "package.json"))) ??
    (await readJson(path.join(repoRoot, "node_modules", name, "package.json")))
  );
}

export async function GET(request: NextRequest) {
  const rejected = rejectUnsafeRequest(request);
  if (rejected) return rejected;
  const [rootPkg, commit, commitDate, branch, notices, nextPkg, convexPkg] = await Promise.all([
    readJson(path.join(repoRoot, "package.json")),
    git(["rev-parse", "HEAD"]),
    git(["log", "-1", "--format=%cI"]),
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    fs.readFile(path.join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8").catch(() => null),
    packageVersion("next"),
    packageVersion("convex"),
  ]);
  return NextResponse.json({
    name: rootPkg?.name ?? "fhara",
    version: rootPkg?.version ?? null,
    commit,
    commitDate,
    branch,
    node: process.version,
    next: nextPkg?.version ?? null,
    convex: convexPkg?.version ?? null,
    notices: notices ? notices.slice(0, 200_000) : null,
  });
}
