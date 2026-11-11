#!/usr/bin/env node
// Live worker flows against the mock LLM (scripts/mock-llm), one scripted
// mock per flow. Each flow drives the real worker through the web UI and
// checks what the task and the screens end up showing.
//
//   node e2e/fixtures-ui/worker-flows.mjs --project <projectId> [--flows a-normal,b-approval,...]
//        [--base http://127.0.0.1:3000] [--convex http://127.0.0.1:3210] [--shots DIR]
//        [--mock-port 3397]
//
// Needs, already running: the local Convex backend, the web app, and a worker
// whose ONLY active model is an `openai-compatible` provider row pointing at
// http://127.0.0.1:<mock-port>/v1 (any dummy key; the mock runs --no-token).
// This script starts and stops the mock itself, with
// scripts/mock-llm/scripts/flow-<name>.json for each flow. The project must be
// a throwaway local git repo with no remote. Writes results.json and one or
// more PNGs per flow into --shots; exit 1 when any check fails.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { chromium } from "playwright-core";

const repo = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const base = opt("--base", process.env.FHARA_WEB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const convexUrl = opt("--convex", process.env.CONVEX_SELF_HOSTED_URL ?? process.env.CONVEX_URL ?? "http://127.0.0.1:3210");
const project = opt("--project");
const mockPort = Number(opt("--mock-port", "3397"));
const shots = path.resolve(opt("--shots", fs.mkdtempSync(path.join(os.tmpdir(), "worker-flows-"))));
if (!project) throw new Error("--project <projectId> is required");
fs.mkdirSync(shots, { recursive: true });
process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";

const convex = new ConvexHttpClient(convexUrl);
const q = (name, a) => convex.query(name, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── results ────────────────────────────────────────────────────────────
const resultsFile = path.join(shots, "results.json");
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, "utf8")) : {};
let current = "setup";
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${current}: ${name}${ok || !detail ? "" : ` (${detail})`}`);
  results[current].checks.push({ check: name, ok: !!ok, detail: ok ? "" : String(detail).slice(0, 500) });
  return !!ok;
}
function note(line) {
  console.log(`      ${current}: ${line}`);
  results[current].notes.push(line);
}

// ── mock LLM (one process per flow) ──────────────────────────────────────
let mockProc = null;
const mockBase = `http://127.0.0.1:${mockPort}`;
async function startMock(flow) {
  await stopMock();
  const script = path.join(repo, "scripts/mock-llm/scripts", `flow-${flow}.json`);
  if (!fs.existsSync(script)) throw new Error(`no mock script ${script}`);
  mockProc = spawn("npx", ["tsx", "scripts/mock-llm/server.ts", "--port", String(mockPort), "--speed", "0", "--no-token", "--quiet", "--script", script, "--data-dir", path.join(os.tmpdir(), "fhara-mock-llm-flows")], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  mockProc.stderr.on("data", (d) => process.stderr.write(`[mock] ${d}`));
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const ok = await fetch(`${mockBase}/v1/models`).then((r) => r.ok).catch(() => false);
    if (ok) return;
  }
  throw new Error("mock LLM did not start");
}
async function stopMock() {
  if (!mockProc) return;
  try { process.kill(-mockProc.pid, "SIGTERM"); } catch {}
  mockProc = null;
  for (let i = 0; i < 20; i++) {
    const up = await fetch(`${mockBase}/v1/models`).then(() => true).catch(() => false);
    if (!up) return;
    await sleep(250);
  }
}
const mockCalls = () => fetch(`${mockBase}/__mock/calls`).then((r) => r.json());
const mockDisable = (rule) => fetch(`${mockBase}/__mock/disable?rule=${rule}`, { method: "POST" }).then((r) => r.json());

// ── browser ──────────────────────────────────────────────────────────────
let browser = null, page = null;
const pageErrors = [];
async function openBrowser() {
  if (browser) return;
  browser = await chromium.launch({ executablePath: process.env.FHARA_CHROMIUM || undefined, args: ["--no-sandbox"] });
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" })).newPage();
  page.on("pageerror", (e) => pageErrors.push(`${current}: ${e.message.split("\n")[0]}`));
}
async function closeBrowser() {
  // A dev stack on a small box has little memory to spare: no browser while the worker runs.
  if (browser) await browser.close().catch(() => {});
  browser = page = null;
}
async function open(url, waitFor) {
  await openBrowser();
  await page.goto(base + url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  if (waitFor) await page.getByText(waitFor).first().waitFor({ timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
let shotNo = 0;
async function shot(name) {
  if (!page) return;
  const file = `${current}-${String(++shotNo).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(shots, file) }).catch(() => {});
  results[current].shots.push(file);
}
const visible = (loc) => loc.first().isVisible().catch(() => false);
const bodyText = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");

async function sendInChat(text) {
  await open(`/workspace/${project}`);
  const box = page.getByPlaceholder(/^Message .*or type/).or(page.locator("main [contenteditable=true]")).first();
  await box.waitFor({ timeout: 60_000 });
  await box.fill(text);
  await box.press("Enter");
}

// ── task state ───────────────────────────────────────────────────────────
const tasks = () => q(anyApi.tasks.listByProject, { projectId: project, limit: 50 });
const events = (taskId) => q(anyApi.taskEvents.listByTask, { taskId, limit: 1000 });
async function newTaskSince(known, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = (await tasks()).find((x) => !known.has(x._id));
    if (t) return t;
    await sleep(1500);
  }
  return null;
}
const stateOf = (t) => (t ? `${t.status}${t.pausedBy ? `/${t.pausedBy}` : ""}` : "gone");
/** Poll one task until `until(task, events)` is true or the time runs out; records the status timeline. */
async function waitTask(taskId, until, timeoutMs, timeline) {
  const t0 = Date.now();
  let last = "", task = null;
  while (Date.now() - t0 < timeoutMs) {
    task = await q(anyApi.tasks.get, { taskId });
    const s = stateOf(task) + (task?.errorMessage ? ` err=${String(task.errorMessage).slice(0, 140)}` : "");
    if (s !== last) {
      timeline.push(`${Math.round((Date.now() - t0) / 1000)}s ${s}`);
      console.log(`      ${current}: ${timeline.at(-1)}`);
      last = s;
    }
    if (await until(task)) return task;
    await sleep(2000);
  }
  return task;
}
const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** Approve a plan/apply approval from the project chat when the task parks on one. */
async function approveFromChat(taskId) {
  await open(`/workspace/${project}`);
  const approve = page.getByRole("button", { name: /^Approve\b/ });
  await approve.first().waitFor({ timeout: 30_000 }).catch(() => {});
  await shot("approval");
  const ok = await visible(approve);
  if (ok) await approve.first().click();
  await page.waitForTimeout(2000);
  await closeBrowser();
  return ok;
}

/** Drive a task to a terminal state, approving apply cards on the way. */
async function runToEnd(taskId, timeline, { timeoutMs = 240_000, approve = true } = {}) {
  const t0 = Date.now();
  let task;
  for (let round = 0; round < 4; round++) {
    task = await waitTask(taskId, (t) => !t || TERMINAL.has(t.status) || t.status === "needs_approval" || t.status === "paused" || t.status === "waiting_input", timeoutMs - (Date.now() - t0), timeline);
    if (task?.status === "needs_approval" && approve) {
      check(`apply approval ${round + 1} approved from chat`, await approveFromChat(taskId));
      continue;
    }
    break;
  }
  return task;
}

async function finishShots(taskId) {
  await open(`/workspace/${project}`);
  await page.waitForTimeout(2500);
  await shot("chat-end");
  if (taskId) {
    await open(`/runs/${taskId}`);
    await page.waitForTimeout(2500);
    await shot("run");
  }
}
const types = (evs) => evs.map((e) => e.type);

// ── flows ────────────────────────────────────────────────────────────────
const flows = {
  /** a. A normal task to Done, with QA actually running (not blocked). */
  async "a-normal"(r) {
    const known = new Set((await tasks()).map((t) => t._id));
    await sendInChat("Add a footer to index.html that says Built with Fhara.");
    const create = page.getByRole("button", { name: /Create task/ }).last();
    await create.waitFor({ timeout: 60_000 }).catch(() => {});
    await shot("chat-reply");
    if (check("chat reply offers Create task", await visible(create))) {
      await create.click();
      await page.waitForTimeout(2000);
      const confirm = page.getByRole("dialog").getByRole("button", { name: /Create|Start/ }).last();
      if (await visible(confirm)) await confirm.click();
    }
    await closeBrowser();
    const t = await newTaskSince(known);
    if (!check("task created", !!t)) return;
    r.taskId = t._id;
    // By design the offered task is the request plus the CTO's reply (ChatPanel.createTaskFromMessage).
    note(`instruction: ${(t.command ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    const end = await runToEnd(t._id, r.timeline);
    check("task Done", end?.status === "done", stateOf(end) + " " + (end?.errorMessage ?? ""));
    const evs = types(await events(t._id));
    check("QA ran (qa.passed / qa.failed / qa.warning)", evs.some((e) => /^qa\.(passed|failed|warning)$/.test(e)), `qa events: ${evs.filter((e) => e.startsWith("qa.")).join(",") || "none"}`);
    check("QA not blocked", !evs.includes("qa.blocked"));
    await finishShots(t._id);
    const body = await bodyText();
    check("run page shows Done", /\bDone\b/.test(body));
    check("run page has no 'QA blocked'", !/QA blocked/i.test(body));
  },

  /** b. A command approval: the worker asks, Allow in the UI, the task continues. */
  async "b-approval"(r) {
    const known = new Set((await tasks()).map((t) => t._id));
    await sendInChat("/task Run npm run test and report the result.");
    await closeBrowser();
    const t = await newTaskSince(known);
    if (!check("task created from /task", !!t)) return;
    r.taskId = t._id;
    // Wait for the approval request (the shell node waits in-process; the task stays running).
    let pending = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const evs = await events(t._id);
      pending = evs.find((e) => /command[._]approval|approval\.requested/.test(e.type) && /npm/.test(JSON.stringify(e.payload ?? {})));
      const task = await q(anyApi.tasks.get, { taskId: t._id });
      if (pending || TERMINAL.has(task?.status)) break;
      await sleep(2000);
    }
    note(`approval event: ${pending?.type ?? "none"}`);
    await open(`/workspace/${project}`, "npm run test");
    const allow = page.getByRole("button", { name: /^Allow/ });
    await allow.first().waitFor({ timeout: 60_000 }).catch(() => {});
    await shot("approval-card");
    if (check("Allow button on the command card", await visible(allow))) {
      // "Allow" (once), never "Always allow".
      const once = page.getByRole("button", { name: /^Allow( once)?$/ });
      await ((await visible(once)) ? once : allow).first().click();
      await page.waitForTimeout(2500);
      await shot("allowed");
    }
    await closeBrowser();
    const end = await runToEnd(t._id, r.timeline, { timeoutMs: 180_000 });
    const evs = await events(t._id);
    check("command ran after Allow (shell.command)", types(evs).includes("shell.command"), types(evs).slice(-12).join(","));
    check("task Done", end?.status === "done", stateOf(end) + " " + (end?.errorMessage ?? ""));
    await finishShots(t._id);
  },

  /** c. The mock returns 429 → the task is held → Resume → it continues. */
  async "c-held-resume"(r) {
    const known = new Set((await tasks()).map((t) => t._id));
    await sendInChat("/task Add docs/HOLD.md that says the hold test passed.");
    await closeBrowser();
    const t = await newTaskSince(known);
    if (!check("task created", !!t)) return;
    r.taskId = t._id;
    const held = await waitTask(t._id, (x) => !x || x.status === "paused" || TERMINAL.has(x.status), 180_000, r.timeline);
    check("task held (paused by 'held')", held?.status === "paused" && held?.pausedBy === "held", stateOf(held) + " " + (held?.errorMessage ?? ""));
    // The provider recovers; then the user presses Resume now.
    await mockDisable("hold-429");
    await open(`/workspace/${project}`, "HOLD.md");
    await shot("held-chat");
    await page.getByRole("tab", { name: /^tasks/i }).first().click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.getByText("HOLD.md").first().click().catch(() => {});
    await page.waitForTimeout(2000);
    const resume = page.getByRole("button", { name: /Resume( now)?/ });
    await shot("held-thread");
    if (check("Resume button shown", await visible(resume))) {
      await resume.first().click();
      await page.waitForTimeout(3000);
      await shot("resumed");
    }
    await closeBrowser();
    const end = await runToEnd(t._id, r.timeline);
    check("task Done after Resume", end?.status === "done", stateOf(end) + " " + (end?.errorMessage ?? ""));
    const calls = await mockCalls();
    note(`mock statuses: ${calls.map((c) => c.status).join(",")}`);
    await finishShots(t._id);
  },

  /** d. The mock returns 500, then recovers (retry / fallback) without user action. */
  async "d-500-recover"(r) {
    const known = new Set((await tasks()).map((t) => t._id));
    await sendInChat("/task Add docs/RETRY.md that says the retry test passed.");
    await closeBrowser();
    const t = await newTaskSince(known);
    if (!check("task created", !!t)) return;
    r.taskId = t._id;
    const end = await runToEnd(t._id, r.timeline);
    const calls = await mockCalls();
    note(`mock calls: ${calls.map((c) => `${c.role}:${c.status}`).join(" ")}`);
    check("mock answered 500 at least once", calls.some((c) => c.status === 500));
    check("the same role succeeded after the 500", calls.some((c) => c.status === 500) && calls.some((c, i) => c.status === 200 && calls.slice(0, i).some((p) => p.status === 500 && p.role === c.role)));
    check("task Done (no hold, no failure)", end?.status === "done", stateOf(end) + " " + (end?.errorMessage ?? ""));
    await finishShots(t._id);
  },

  /** e. A verification failure followed by a fix round. */
  async "e-verify-fix"(r) {
    const known = new Set((await tasks()).map((t) => t._id));
    await sendInChat("/task Add a typed greet() helper in src/greet.ts.");
    await closeBrowser();
    const t = await newTaskSince(known);
    if (!check("task created", !!t)) return;
    r.taskId = t._id;
    const end = await runToEnd(t._id, r.timeline, { timeoutMs: 360_000 });
    const evs = await events(t._id);
    const checks = evs.filter((e) => e.type === "task.check" && /^verify:/.test(e.payload?.label ?? ""));
    note(`verify checks: ${checks.map((e) => `${e.payload.label}=${e.payload.status}`).join(" ")}`);
    check("a verification check failed first", checks.some((e) => e.payload.status === "failed"));
    const calls = await mockCalls();
    check("a fix round ran (mock saw the verify-fix prompt)", calls.some((c) => c.rule === "verify-fix"), calls.map((c) => c.rule).join(","));
    const lastTypecheck = checks.filter((e) => /typecheck/.test(e.payload.label)).at(-1);
    check("typecheck passed after the fix", lastTypecheck?.payload.status === "passed", lastTypecheck ? lastTypecheck.payload.status : "no typecheck");
    check("task Done", end?.status === "done", stateOf(end) + " " + (end?.errorMessage ?? ""));
    await finishShots(t._id);
  },

  /** f. Cancel a running task. */
  async "f-cancel"(r) {
    const known = new Set((await tasks()).map((t) => t._id));
    await sendInChat("/task Add docs/SLOW.md (the mock answers slowly).");
    await closeBrowser();
    const t = await newTaskSince(known);
    if (!check("task created", !!t)) return;
    r.taskId = t._id;
    // Wait until the slow executor call is in flight.
    const running = await waitTask(t._id, async (x) => {
      if (!x || TERMINAL.has(x.status)) return true;
      return x.status === "running" && (await mockCalls()).some((c) => c.rule === "slow-code-change");
    }, 120_000, r.timeline);
    check("task running with the slow call in flight", running?.status === "running");
    await open(`/workspace/${project}`, "SLOW.md");
    await page.getByRole("tab", { name: /^tasks/i }).first().click().catch(() => {});
    await page.waitForTimeout(2000);
    const stop = page.getByRole("button", { name: /^Stop task/ });
    await shot("board-running");
    if (check("Stop task button on the board", await visible(stop))) {
      await stop.first().click();
      await page.waitForTimeout(1000);
      const confirm = page.getByRole("dialog").getByRole("button", { name: /Stop task|Cancel task/ });
      await shot("stop-confirm");
      if (await visible(confirm)) await confirm.first().click();
      await page.waitForTimeout(2000);
    }
    await closeBrowser();
    const end = await waitTask(t._id, (x) => !x || TERMINAL.has(x.status), 90_000, r.timeline);
    check("task Cancelled", end?.status === "cancelled", stateOf(end) + " " + (end?.errorMessage ?? ""));
    // The worker must let go: no further executor call after the cancel.
    await sleep(8000);
    const after = await q(anyApi.tasks.get, { taskId: t._id });
    check("still cancelled a few seconds later (not resurrected)", after?.status === "cancelled", stateOf(after));
    await finishShots(t._id);
  },

  /** g. A personal chat reply from the mock (no project). */
  async "g-personal-chat"() {
    const agents = await q(anyApi.agents.list, {});
    const cto = agents.find((a) => a.role === "cto");
    if (!check("CTO agent found", !!cto)) return;
    await open(`/chats/personal/${cto._id}`);
    const box = page.getByPlaceholder(/Message/).or(page.locator("main [contenteditable=true]")).first();
    await box.waitFor({ timeout: 60_000 });
    await box.fill("Quick question: what should I work on first?");
    await box.press("Enter");
    const reply = page.getByText(/Mock reply from your personal chat/);
    await reply.first().waitFor({ timeout: 60_000 }).catch(() => {});
    await shot("personal-chat");
    check("mock reply shown in the personal chat", await visible(reply));
    const calls = await mockCalls();
    check("mock matched the personal chat rule", calls.some((c) => c.rule === "chat-reply-personal"), calls.map((c) => c.rule).join(","));
    await closeBrowser();
  },

  /** h. A /research fan-out with one angle failing. */
  async "h-research"(r) {
    const known = new Set((await tasks()).map((t) => t._id));
    await sendInChat("/research 3 Which background job runner fits a small Node app?");
    await closeBrowser();
    const t = await newTaskSince(known);
    if (!check("task created from /research", !!t)) return;
    r.taskId = t._id;
    const end = await runToEnd(t._id, r.timeline, { timeoutMs: 300_000 });
    const subs = ((await q(anyApi.workspace.listSubtasksByProject, { projectId: project })).find((x) => x.taskId === t._id)?.subtasks) ?? [];
    note(`subtasks: ${subs.map((s) => `${s.key}=${s.status}`).join(" ")}`);
    const ra2 = subs.find((s) => s.key === "ra-2");
    const synth = subs.find((s) => s.key === "synthesis");
    check("three angles planned", ["ra-1", "ra-2", "ra-3"].every((k) => subs.some((s) => s.key === k)));
    check("RA-2 failed", ra2?.status === "failed", ra2?.status);
    check("RA-1 and RA-3 completed", ["ra-1", "ra-3"].every((k) => subs.find((s) => s.key === k)?.status === "completed"));
    check("synthesis completed", synth?.status === "completed", synth?.status);
    check("task Done", end?.status === "done", stateOf(end) + " " + (end?.errorMessage ?? ""));
    await finishShots(t._id);
  },
};

const wanted = (opt("--flows", "") || Object.keys(flows).join(",")).split(",").filter(Boolean);
let failed = 0;
for (const name of wanted) {
  if (!flows[name]) throw new Error(`unknown flow ${name}`);
  current = name;
  shotNo = 0;
  results[name] = { checks: [], notes: [], shots: [], timeline: [], startedAt: new Date().toISOString() };
  try {
    // A clean slate: no open task of an earlier flow competes for the chat's cards.
    for (const t of await tasks()) {
      if (!TERMINAL.has(t.status)) await convex.mutation(anyApi.tasks.cancel, { taskId: t._id }).catch(() => {});
    }
    await startMock(name);
    await flows[name](results[name]);
  } catch (e) {
    check("ran without error", false, e.message.split("\n")[0]);
    await shot("error").catch(() => {});
  } finally {
    await closeBrowser();
  }
  try {
    results[name].mockCalls = (await mockCalls()).map(({ n, role, rule, status }) => ({ n, role, rule, status }));
  } catch {}
  results[name].pass = results[name].checks.every((c) => c.ok);
  if (!results[name].pass) failed++;
  console.log(`== ${name}: ${results[name].pass ? "PASS" : "FAIL"}`);
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
}
await stopMock();
if (pageErrors.length) console.log(`page errors:\n  ${pageErrors.join("\n  ")}`);
console.log(`${wanted.length - failed}/${wanted.length} flows passed; results in ${resultsFile}`);
process.exit(failed ? 1 : 0);
