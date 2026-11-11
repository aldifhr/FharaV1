#!/usr/bin/env node
// Screens of the seeded fixtures, checked deterministically: no real model,
// no GitHub. Mirrors threadbear's Tools/tour-e2e.mjs + screenshots.sh (MIT):
// one plain script, a check() per visible state, a numbered PNG per screen,
// exit 1 on any failed check.
//
//   npm run test:fixtures-ui -- [--shots DIR] [--base http://127.0.0.1:3010] [--only held-resume,direct-idle]
//
// Needs, already running: a local Convex backend with the fixtures seeded
// (`npm run fixtures:seed`, CONVEX_SELF_HOSTED_URL + _ADMIN_KEY in the shell),
// and the web app pointed at it (NEXT_PUBLIC_CONVEX_URL). Chromium comes from
// FHARA_CHROMIUM (path to a chromium binary) or playwright's own install.
// The personal-chat check deletes the seeded chat; reseed to run it again.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const repo = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const base = opt("--base", process.env.FHARA_WEB_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const shots = path.resolve(opt("--shots", fs.mkdtempSync(path.join(os.tmpdir(), "fixtures-ui-"))));
const only = opt("--only", "")?.split(",").filter(Boolean) ?? [];
fs.mkdirSync(shots, { recursive: true });

const results = []; // { scenario, check, ok, detail }
let current = "setup";
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${current}: ${name}${ok || !detail ? "" : ` (${detail})`}`);
  results.push({ scenario: current, check: name, ok: !!ok, detail: ok ? "" : detail });
  return ok;
}
let shotNo = 0;
async function shot(page, name) {
  const file = path.join(shots, `${String(++shotNo).padStart(2, "0")}-${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
  } catch {
    // A shot that fails doesn't fail the run.
  }
  return file;
}

// Fixture row ids, from the seeder's own ledger (devFixtureRows).
function convexData(table) {
  const out = execFileSync("npx", ["convex", "data", table, "--limit", "1000", "--format", "jsonl"], {
    cwd: path.join(repo, "apps/api"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
  return out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
}
const ledger = convexData("devFixtureRows");
const idOf = (fixture, table) => ledger.find((r) => r.fixture === fixture && r.table === table)?.rowId;
const agents = convexData("agents");
const ctoId = agents.find((a) => a.role === "cto")?._id;

const browser = await chromium.launch({
  executablePath: process.env.FHARA_CHROMIUM || undefined,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`${current}: ${e.message.split("\n")[0]}`));

async function open(url, waitFor) {
  await page.goto(base + url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  if (waitFor) await page.getByText(waitFor).first().waitFor({ timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
const visible = (loc) => loc.first().isVisible().catch(() => false);
const bodyText = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");

const scenarios = {
  async "planned-push"() {
    const task = idOf("planned-push", "tasks");
    check("task row seeded", !!task);
    await open(`/runs/${task}`, "Empty state for the orders list");
    const t = await bodyText();
    check("title shown", t.includes("Empty state for the orders list"));
    check("status Done", /\bDone\b/.test(t));
    check("plan has Review subtask", /review/i.test(t));
    await shot(page, "planned-push-run");
  },
  async "command-approval"() {
    const project = idOf("command-approval", "projects");
    await open(`/workspace/${project}`, "npm run test");
    const allow = page.getByRole("button", { name: /^(Allow|Izinkan)/ });
    const deny = page.getByRole("button", { name: /^(Deny|Decline|Tolak)/ });
    check("approval card Allow button", await visible(allow));
    check("approval card Deny button", await visible(deny));
    check("Always allow offered", await visible(page.getByText(/Always allow|Selalu izinkan/)));
    await shot(page, "command-approval-chat");
    await open("/inbox", "Run npm run test");
    check("inbox lists the command", (await bodyText()).includes("Run npm run test"));
    check("inbox Allow button", await visible(page.getByRole("button", { name: /^Allow$/ })));
    check("inbox Deny button", await visible(page.getByRole("button", { name: /^Deny$/ })));
    await shot(page, "command-approval-inbox");
  },
  async "held-resume"() {
    const project = idOf("held-resume", "projects");
    const task = idOf("held-resume", "tasks");
    await open(`/runs/${task}`, "Dark mode toggle");
    check("run status Paused", /\bPaused\b/.test(await bodyText()));
    await shot(page, "held-resume-run");
    await open(`/workspace/${project}`, "Dark mode toggle");
    await page.getByRole("tab", { name: /^tasks/i }).first().click().catch(() => {});
    await page.waitForTimeout(2000);
    check("board badge Paused", await visible(page.getByText("Paused", { exact: true })));
    await shot(page, "held-resume-board");
    await page.getByText("Dark mode toggle").first().click().catch(() => {});
    await page.waitForTimeout(2000);
    check("thread panel hold notice", await visible(page.getByText(/rate limit|429|retr/i)));
    check("thread panel Resume now", await visible(page.getByRole("button", { name: /Resume now/ })));
    await shot(page, "held-resume-thread");
  },
  async "verify-loop-failed"() {
    const task = idOf("verify-loop-failed", "tasks");
    await open(`/runs/${task}`, "CSV export for invoices");
    const t = await bodyText();
    check("status Failed", /\bFailed\b/.test(t));
    check("verification failure reason", t.includes("Verification failed after 3 runs"));
    check("typecheck log tail", t.includes("TS2322"));
    check("two fix rounds", t.includes("Fix verification (round 2)"));
    await shot(page, "verify-loop-failed-run");
  },
  async "research-fanout"() {
    const task = idOf("research-fanout", "tasks");
    await open(`/runs/${task}`, "Background job options");
    const t = await bodyText();
    check("status Done", /\bDone\b/.test(t));
    check("three angles", ["RA-1", "RA-2", "RA-3"].every((a) => t.includes(a)));
    check("RA-2 failed", /RA-2: Redis queue failed/.test(t));
    check("synthesis completed", /Synthesis completed/.test(t));
    await shot(page, "research-fanout-run");
  },
  async "direct-idle"() {
    const task = idOf("direct-idle", "tasks");
    await open(`/runs/${task}`, "Blurry header logo");
    const t = await bodyText();
    check("thread events replayed", t.includes("turn.completed") && t.includes("edit.diff"));
    check("idle thread not labelled 'Waiting for you'", !t.includes("Waiting for you"), "run header says Waiting for you");
    await shot(page, "direct-idle-run");
    await open("/", "Needs you");
    const needs = page.locator("section,div").filter({ has: page.getByText(/^Needs you$/) }).first();
    const home = await bodyText();
    const inNeeds = /Needs you.*Answer: Blurry header logo.*Recent failures/.test(home);
    check("idle direct thread NOT in Needs you", !inNeeds, "home Needs you lists 'Answer: Blurry header logo'");
    await shot(page, "direct-idle-home-needs-you");
    void needs;
  },
  async "personal-chat"() {
    check("CTO agent found", !!ctoId);
    await open(`/chats/personal/${ctoId}`, "Lost updates");
    check("seeded reply shown", (await bodyText()).includes("Lost updates"));
    await shot(page, "personal-chat");
    const del = page.getByRole("button", { name: "Delete chat" });
    if (!check("Delete chat button", await visible(del))) return;
    await del.first().click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Delete chat" });
    const confirmBtn = (await visible(confirm)) ? confirm : page.getByRole("button", { name: "Delete chat" }).last();
    check("confirm dialog", await visible(page.getByText("Delete this chat?")));
    await shot(page, "personal-chat-delete-confirm");
    await confirmBtn.first().click();
    await page.waitForTimeout(3000);
    const after = await bodyText();
    check("toast 'Chat deleted'", after.includes("Chat deleted"), "no success toast");
    check("seeded messages gone", !after.includes("Lost updates: both read"), "old reply still on screen");
    await shot(page, "personal-chat-after-delete");
  },
};

for (const [name, run] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  current = name;
  try {
    await run();
  } catch (e) {
    check("ran without error", false, e.message.split("\n")[0]);
    await shot(page, `${name}-error`);
  }
}
await browser.close();

current = "browser";
check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
fs.writeFileSync(path.join(shots, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; shots in ${shots}`);
process.exit(failed.length ? 1 : 0);
