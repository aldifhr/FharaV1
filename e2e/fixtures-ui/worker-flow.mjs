#!/usr/bin/env node
// One live worker flow against the mock LLM (scripts/mock-llm): send an
// instruction in a project's chat and record how far the task gets.
//
//   node e2e/fixtures-ui/worker-flow.mjs --project <projectId> [--base URL] [--shots DIR] [--seconds 240]
//
// Needs the same stack as run.mjs plus a running worker whose LLM provider
// points at the mock LLM. The project's workspacePath must be a throwaway
// local git repo (no remote). Prints the status timeline; exit 1 when the
// task does not reach done.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const repo = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const base = opt("--base", process.env.FHARA_WEB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const project = opt("--project");
const seconds = Number(opt("--seconds", "240"));
const shots = path.resolve(opt("--shots", fs.mkdtempSync(path.join(os.tmpdir(), "worker-flow-"))));
const instruction = opt("--say", "Add a footer to index.html that says Built with Fhara.");
if (!project) throw new Error("--project <projectId> is required");
fs.mkdirSync(shots, { recursive: true });

function tasksOfProject() {
  const out = execFileSync("npx", ["convex", "data", "tasks", "--limit", "200", "--format", "jsonl"], {
    cwd: path.join(repo, "apps/api"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
  return out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((t) => t.projectId === project);
}

const launch = async () => {
  const b = await chromium.launch({ executablePath: process.env.FHARA_CHROMIUM || undefined, args: ["--no-sandbox"] });
  return [b, await (await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" })).newPage()];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let [browser, page] = await launch();
await page.goto(`${base}/workspace/${project}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
const box = page.getByPlaceholder(/^(Message .*or type|Ask anything)/).or(page.locator("main [contenteditable=true]")).first();
await box.waitFor({ timeout: 60_000 });
await box.fill(instruction);
await box.press("Enter");
const t0 = Date.now();
// The chat reply decides whether a task starts. When it only offers a
// "Create task" button (chat never starts a task by itself), press it.
const create = page.getByRole("button", { name: /Create task/ }).last();
await create.waitFor({ timeout: 45_000 }).catch(() => {});
await page.screenshot({ path: path.join(shots, "worker-01-sent.png") });
if (await create.isVisible().catch(() => false)) {
  console.log("chat offered Create task; pressing it");
  await create.click();
  await page.waitForTimeout(2000);
  const confirm = page.getByRole("dialog").getByRole("button", { name: /Create|Start/ }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(shots, "worker-01b-create-task.png") });
}
// The browser is closed while the worker runs (a dev stack on a small box
// has little memory to spare) and opened again for the end shots.
await browser.close();

const timeline = [];
let last = "", task;
while (Date.now() - t0 < seconds * 1000) {
  await sleep(5000);
  task = tasksOfProject().sort((a, b) => b._creationTime - a._creationTime)[0];
  const state = task ? `${task.status}${task.pausedBy ? `/${task.pausedBy}` : ""}${task.errorMessage ? ` err=${String(task.errorMessage).slice(0, 160)}` : ""}` : "no task yet";
  if (state !== last) {
    timeline.push(`${Math.round((Date.now() - t0) / 1000)}s ${state}`);
    console.log(timeline.at(-1));
    last = state;
  }
  if (task && ["done", "failed", "cancelled", "waiting_input"].includes(task.status)) break;
  if (task?.status === "paused") break;
}
[browser, page] = await launch();
await page.goto(`${base}/workspace/${project}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: path.join(shots, "worker-02-chat-end.png") });
if (task) {
  await page.goto(`${base}/runs/${task._id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(shots, "worker-03-run.png"), fullPage: false });
}
await browser.close();
fs.writeFileSync(path.join(shots, "worker-flow.json"), JSON.stringify({ taskId: task?._id, timeline }, null, 2));
process.exit(task?.status === "done" ? 0 : 1);
