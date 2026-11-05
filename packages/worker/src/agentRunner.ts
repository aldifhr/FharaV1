import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { createProviderForAgent, type AgentLLMConfig } from "./llm";
import { readFile } from "./tools/readFile";
import { computeDiff, writeStaged, type FileDiff } from "./tools/gitDiff";
import { waitForApproval } from "./approvalGate";

export interface RunContext {
  taskId: string;
  projectId: string;
  workspacePath: string;
  command: string;
  orchestrationPlan?: string;
  agents: ({ _id: string; name: string; role: string; systemPrompt?: string } & AgentLLMConfig)[];
  // ponytail: callbacks di-inject dari index.ts agar agentRunner testable tanpa Convex.
  onChunk: (agentId: string, delta: string) => Promise<void>;
  appendMessage: (agentId: string, content: string) => Promise<void>;
  onEvent: (type: string, payload: Record<string, unknown>) => Promise<void>;
  requestApproval: (kind: "apply_changes" | "git_push" | "run_command", summary: string, payload: unknown, requestedByAgentId?: string) => Promise<string>;
  waitApproval: (approvalId: string) => Promise<{ status: "approved" | "rejected" | "pending" }>;
  saveFileChange: (fc: FileDiff) => Promise<string>;
  updateTaskStatus: (status: string) => Promise<void>;
  setAgentStatus: (agentId: string, status: string) => Promise<void>;
}

function findAgent(agents: RunContext["agents"], role: string) {
  return agents.find((a) => a.role.trim().toLowerCase() === role);
}

export async function runTask(ctx: RunContext) {
  const ws = ctx.workspacePath;
  await fs.mkdir(path.resolve(ws), { recursive: true });

  const frontend = findAgent(ctx.agents, "frontend");
  const cto = findAgent(ctx.agents, "cto");
  const qa = findAgent(ctx.agents, "qa");
  if (!frontend) throw new Error("Frontend agent not found");
  const providerFor = (agent: RunContext["agents"][number]) =>
    createProviderForAgent(agent);

  await ctx.setAgentStatus(frontend._id, "working");

  const fileHint = extractFileHint(ctx.command);
  const repositoryContext = await exploreRepository(ws, fileHint);
  await ctx.onEvent("agent.context", { agentId: frontend._id, context: repositoryContext });
  let draft = await providerFor(frontend).complete([
    ...(frontend.systemPrompt ? [{ role: "system" as const, content: frontend.systemPrompt }] : []),
    {
      role: "user",
      content: `Repository context:\n${repositoryContext}\n\nOrchestrator plan:\n${ctx.orchestrationPlan ?? "(none)"}\n\nCommand: ${ctx.command}\nTarget file hint: ${fileHint ?? "(explore)"}\nReturn JSON only: { "filePath": "...", "newContent": "..." }. Preserve existing behavior and unrelated code.`,
    },
  ]);

  let parsed = parseDraft(draft.content);
  if (!parsed) {
    await ctx.onEvent("agent.error", { message: "Frontend draft parse failed" });
    await ctx.updateTaskStatus("failed");
    return;
  }

  let diff = await computeDiff(ws, parsed.filePath, parsed.newContent);
  let reviewResult: ReviewResult = { verdict: "approved", findings: [] };
  for (let reviewAttempt = 0; reviewAttempt < 2; reviewAttempt += 1) {
    if (!cto) break;
    await ctx.setAgentStatus(cto._id, "working");
    const review = await providerFor(cto).stream!(
      [
        ...(cto.systemPrompt ? [{ role: "system" as const, content: cto.systemPrompt }] : []),
        {
          role: "user",
          content: `Repository context:\n${repositoryContext}\n\nOrchestrator plan:\n${ctx.orchestrationPlan ?? "(none)"}\n\nDiff:\n${diff.diff}\n\nReturn JSON only with this schema: {"verdict":"approved"|"changes_requested","findings":[{"severity":"critical"|"high"|"medium"|"low","filePath":"...","description":"...","suggestion":"..."}]}. Use an empty findings array when approved.`,
        },
      ],
      async (delta) => {
        await ctx.onChunk(cto._id, delta);
      }
    );
    const parsedReview = parseReview(review.content);
    if (!parsedReview) {
      await ctx.onEvent("agent.error", { message: "CTO review parse failed; rejecting changes" });
      await ctx.setAgentStatus(cto._id, "idle");
      await ctx.updateTaskStatus("failed");
      await ctx.setAgentStatus(frontend._id, "idle");
      return;
    }
    reviewResult = parsedReview;
    await ctx.onEvent("review.completed", {
      agentId: cto._id,
      verdict: parsedReview.verdict,
      findings: parsedReview.findings,
    });
    await ctx.setAgentStatus(cto._id, "idle");
    if (reviewResult.verdict === "approved") break;
    if (reviewAttempt === 1) {
      await ctx.onEvent("agent.error", { message: "CTO requested changes after maximum revision attempts" });
      await ctx.updateTaskStatus("failed");
      await ctx.setAgentStatus(frontend._id, "idle");
      return;
    }
    draft = await providerFor(frontend).complete([
      ...(frontend.systemPrompt ? [{ role: "system" as const, content: frontend.systemPrompt }] : []),
      {
        role: "user",
        content: `Revise the proposed change using this CTO feedback:\n${JSON.stringify(reviewResult.findings)}\n\nCurrent diff:\n${diff.diff}\n\nRepository context:\n${repositoryContext}\n\nReturn JSON only: { "filePath": "...", "newContent": "..." }.`,
      },
    ]);
    parsed = parseDraft(draft.content);
    if (!parsed) {
      await ctx.onEvent("agent.error", { message: "Frontend revision parse failed" });
      await ctx.updateTaskStatus("failed");
      await ctx.setAgentStatus(frontend._id, "idle");
      return;
    }
    diff = await computeDiff(ws, parsed.filePath, parsed.newContent);
  }

  const fcId = await ctx.saveFileChange(diff);
  await ctx.onEvent("fileChanges.updated", { fileChanges: [fcId] });
  await ctx.onEvent("task.status", { status: "running" });
  await ctx.appendMessage(
    frontend._id,
    `Changes are prepared in ${diff.filePath}. I will run checks before requesting approval.`
  );

  if (qa) {
    await ctx.setAgentStatus(qa._id, "working");
    const qaResult = await runResponsiveQa(ws, async (check) => {
      await ctx.onEvent("task.check", { agentId: qa._id, ...check });
    });
    await ctx.setAgentStatus(qa._id, "idle");
    if (!qaResult.passed) {
      await ctx.appendMessage(qa._id, `QA found issues: ${qaResult.failures.join("; ")}`);
      await ctx.onEvent("agent.error", { message: `QA failed: ${qaResult.failures.join("; ")}` });
      await ctx.updateTaskStatus("failed");
      await ctx.setAgentStatus(frontend._id, "idle");
      return;
    }
  }

  // 4. Approval gate — STOP sebelum apply
  await ctx.updateTaskStatus("needs_approval");
  await ctx.setAgentStatus(frontend._id, "needs_you");
  await ctx.onEvent("task.status", { status: "needs_approval" });
  await ctx.appendMessage(
    frontend._id,
    `QA is complete. Changes for ${diff.filePath} are ready to apply. Waiting for your approval.`
  );

  const approvalId = await ctx.requestApproval(
    "apply_changes",
    `Apply changes to ${diff.filePath}`,
    { fileChanges: [fcId], diff: diff.diff },
    frontend._id
  );

  const decision = await waitForApproval(async () => {
    const d = await ctx.waitApproval(approvalId);
    return { status: d.status as any };
  });

  if (decision.status !== "approved") {
    await ctx.appendMessage(frontend._id, "Changes were rejected and were not applied to the workspace.");
    await ctx.updateTaskStatus("rejected");
    await ctx.onEvent("task.status", { status: "rejected" });
    await ctx.setAgentStatus(frontend._id, "idle");
    return;
  }

  // 5. Apply staged (sekarang baru tulis permanen)
  await writeStaged(ws, diff);
  await ctx.updateTaskStatus("done");
  await ctx.onEvent("task.status", { status: "done" });
  await ctx.appendMessage(
    frontend._id,
    `Done. Changes in ${diff.filePath} were applied successfully${qa ? " and QA completed successfully" : ""}.`
  );
  await ctx.setAgentStatus(frontend._id, "idle");
}

function extractFileHint(command: string): string | null {
  const m = command.match(/[\w./-]+\.(tsx?|jsx?|css|html)/i);
  return m ? m[0] : null;
}

async function exploreRepository(workspaceRoot: string, fileHint: string | null): Promise<string> {
  const files: string[] = [];
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", ".convex"]);
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 3 || files.length >= 120) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (/\.(tsx?|jsx?|css|json|md|html)$/i.test(entry.name)) {
        files.push(path.relative(workspaceRoot, absolute));
      }
    }
  }
  await visit(workspaceRoot, 0);
  const candidates = fileHint
    ? files.filter((file) => file.toLowerCase().includes(fileHint.toLowerCase()))
    : [];
  const selected = [...new Set([...candidates, ...files])].slice(0, 20);
  const sections: string[] = [`Files:\n${selected.join("\n")}`];
  for (const file of selected.slice(0, 8)) {
    try {
      const content = await readFile(workspaceRoot, file);
      sections.push(`\n--- ${file} ---\n${content.slice(0, 12_000)}`);
    } catch (error) {
      sections.push(`\n--- ${file} unavailable: ${error instanceof Error ? error.message : String(error)} ---`);
    }
  }
  return sections.join("\n");
}

function parseDraft(content: string): { filePath: string; newContent: string } | null {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < content.length; index += 1) {
      const character = content[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          inString = false;
        }

      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;

        const candidate = content.slice(start, index + 1);
        try {
          const parsed: unknown = JSON.parse(candidate);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "filePath" in parsed &&
            "newContent" in parsed
          ) {
            const draft = parsed as { filePath: unknown; newContent: unknown };
            if (typeof draft.filePath === "string" && typeof draft.newContent === "string") {
              return { filePath: draft.filePath, newContent: draft.newContent };
            }
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        break;
      }
    }
  }
  return null;
}

type ReviewFinding = {
  severity: "critical" | "high" | "medium" | "low";
  filePath: string;
  description: string;
  suggestion: string;
};

type ReviewResult = {
  verdict: "approved" | "changes_requested";
  findings: ReviewFinding[];
};

function parseReview(content: string): ReviewResult | null {
  const parsed = extractJson(content);
  if (!parsed || typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { verdict?: unknown; findings?: unknown };
  if (candidate.verdict !== "approved" && candidate.verdict !== "changes_requested") return null;
  if (!Array.isArray(candidate.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const finding of candidate.findings) {
    if (typeof finding !== "object" || finding === null) return null;
    const value = finding as Record<string, unknown>;
    if (
      !["critical", "high", "medium", "low"].includes(String(value.severity)) ||
      typeof value.filePath !== "string" ||
      typeof value.description !== "string" ||
      typeof value.suggestion !== "string"
    ) return null;
    findings.push({
      severity: value.severity as ReviewFinding["severity"],
      filePath: value.filePath,
      description: value.description,
      suggestion: value.suggestion,
    });
  }
  return { verdict: candidate.verdict, findings };
}

function extractJson(content: string): unknown {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const character = content[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
      } else if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(content.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

async function runResponsiveQa(
  workspaceRoot: string,
  onCheck: (check: { label: string; status: "running" | "clean" | "failed"; details?: string }) => Promise<void>
): Promise<{ passed: boolean; failures: string[] }> {
  const baseUrl = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
  const screenshotsDir = path.join(workspaceRoot, ".qa", "screenshots");
  const baselinesDir = path.join(workspaceRoot, ".qa", "baselines");
  await fs.mkdir(screenshotsDir, { recursive: true });
  let server: ChildProcess | undefined;
  const failures: string[] = [];
  try {
    if (!(await canReach(baseUrl))) {
      server = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
        cwd: workspaceRoot,
        env: { ...process.env, PORT: "3000" },
        windowsHide: true,
      });
      if (!(await waitForUrl(baseUrl, 30_000))) {
        throw new Error(`QA dev server did not start at ${baseUrl}`);
      }
    }
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [
        { label: "desktop", width: 1440, height: 900 },
        { label: "tablet", width: 768, height: 1024 },
        { label: "mobile", width: 375, height: 812 },
      ]) {
        await onCheck({ label: `${viewport.label} responsive`, status: "running" });
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
        const consoleErrors: string[] = [];
        const networkErrors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("requestfailed", (request) => {
          networkErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`);
        });
        await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
        await page.locator("body").waitFor({ state: "visible" });
        const screenshotPath = path.join(screenshotsDir, `${viewport.label}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const firstButton = page.locator("button").first();
        if (await firstButton.count()) await firstButton.click({ timeout: 5_000 });
        await page.close();
        const details = [
          ...consoleErrors.map((error) => `console: ${error}`),
          ...networkErrors.map((error) => `network: ${error}`),
        ];
        if (details.length) {
          failures.push(`${viewport.label}: ${details.join(", ")}`);
          await onCheck({ label: `${viewport.label} responsive`, status: "failed", details: details.join("; ") });
        } else {
          const baseline = await compareScreenshot(screenshotPath, path.join(baselinesDir, `${viewport.label}.png`));
          await onCheck({
            label: `${viewport.label} responsive`,
            status: baseline.status,
            details: `Screenshot saved to .qa/screenshots/${viewport.label}.png; ${baseline.details}`,
          });
          if (baseline.status === "failed") failures.push(`${viewport.label}: ${baseline.details}`);
        }
      }

      async function compareScreenshot(
        actualPath: string,
        baselinePath: string
      ): Promise<{ status: "clean" | "failed"; details: string }> {
        try {
          const [actual, baseline] = await Promise.all([fs.readFile(actualPath), fs.readFile(baselinePath)]);
          const actualPng = PNG.sync.read(actual);
          const baselinePng = PNG.sync.read(baseline);
          if (actualPng.width !== baselinePng.width || actualPng.height !== baselinePng.height) {
            return {
              status: "failed",
              details: `Screenshot dimensions differ from baseline (${actualPng.width}x${actualPng.height} vs ${baselinePng.width}x${baselinePng.height})`,
            };
          }
          const diff = new PNG({ width: actualPng.width, height: actualPng.height });
          const changedPixels = pixelmatch(
            baselinePng.data,
            actualPng.data,
            diff.data,
            actualPng.width,
            actualPng.height,
            { threshold: 0.1 }
          );
          if (changedPixels > 0) {
            await fs.writeFile(`${actualPath}.diff.png`, PNG.sync.write(diff));
            return { status: "failed", details: `Screenshot differs from baseline by ${changedPixels} pixels` };
          }
          return { status: "clean", details: "Screenshot matches baseline" };
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { status: "clean", details: "Baseline not found; screenshot captured for baseline creation" };
          }
          const digest = createHash("sha256").update(await fs.readFile(actualPath)).digest("hex").slice(0, 12);
          return { status: "failed", details: `Screenshot comparison failed (${digest}): ${error instanceof Error ? error.message : String(error)}` };
        }
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (server?.pid) server.kill();
  }
  return { passed: failures.length === 0, failures };
}

async function canReach(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canReach(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
