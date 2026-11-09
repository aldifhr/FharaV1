#!/usr/bin/env node
/**
 * Workload by role, printed as a plain-text table you can paste anywhere.
 *
 *   npm run stats:roles                       all projects, last 30 days
 *   npm run stats:roles -- --days 7           7 | 30 | 90
 *   npm run stats:roles -- --project Shop     project name or id
 *   npm run stats:roles -- --json             raw query result
 *
 * Calls the same Convex query the Team page uses (workload.byRole) with the
 * deployment URL from the root .env (NEXT_PUBLIC_CONVEX_URL, else CONVEX_URL).
 * Reads only; nothing is written.
 */
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { loadRootEnv } from "./env.mjs";
import { formatWorkloadTable, type WorkloadResult } from "../apps/api/convex/lib/workload";

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

async function main() {
  const { merged } = loadRootEnv();
  const url = merged.NEXT_PUBLIC_CONVEX_URL || merged.CONVEX_URL;
  if (!url) {
    console.error("No Convex URL: set NEXT_PUBLIC_CONVEX_URL in the root .env (see .env.example).");
    process.exit(1);
  }
  const days = Number(arg("days") ?? 30);
  if (![7, 30, 90].includes(days)) {
    console.error("--days must be 7, 30 or 90");
    process.exit(1);
  }
  const client = new ConvexHttpClient(url);

  let projectId: string | undefined;
  let projectName = "All projects";
  const wanted = arg("project");
  if (wanted) {
    const projects = (await client.query(anyApi.projects.list, {})) as Array<{ _id: string; name: string }>;
    const match =
      projects.find((p) => p._id === wanted) ??
      projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      console.error(`No project "${wanted}". Projects: ${projects.map((p) => p.name).join(", ") || "none"}`);
      process.exit(1);
    }
    projectId = match._id;
    projectName = match.name;
  }

  const result = (await client.query(anyApi.workload.byRole, {
    sinceDays: days,
    ...(projectId ? { projectId } : {}),
  })) as WorkloadResult & { truncated: string[] };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Workload by role · ${projectName} · last ${days} days`);
  console.log("");
  console.log(formatWorkloadTable(result));
  if (result.truncated?.length) console.log(`\nRead limit reached for ${result.truncated.join(", ")}; older rows are left out.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
