import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { killTree } from "./verification";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { QaCheck, QaReport } from "@/types/qa";

export type { QaCheck, QaReport } from "@/types/qa";

/** Thrown internally for environment problems; mapped to verdict "blocked". */
class QaEnvironmentError extends Error {}

/**
 * Label for one QA check (plan 011). Visual mode names each viewport;
 * structural mode runs a single pass and is labelled as a structural
 * check so no output ever claims viewport/responsive coverage that did
 * not run.
 */
export function checkLabelFor(viewportLabel: string, visualRegression: boolean): string {
  return visualRegression ? `${viewportLabel} viewport` : "structural check";
}

export interface QaOptions {
  baseUrl?: string;
  autoStartServer?: boolean;
  onCheck?: (check: QaCheck) => Promise<void>;
  /**
   * Task cancellation signal (Phase 4): checked between Playwright
   * steps; when it fires, the browser is closed and the auto-started
   * dev server is killed immediately instead of running to completion.
   */
  signal?: AbortSignal;
  /** Compare screenshots only when the task explicitly requests visual QA. */
  visualRegression?: boolean;
  /**
   * Environment preflight (browser binary present). Default true; tests
   * that exercise process handling without a browser turn it off.
   */
  preflight?: boolean;
  /** Dev-server startup timeout; defaults to QA_STARTUP_TIMEOUT_MS or 90s. */
  startupTimeoutMs?: number;
  /**
   * Workspace-relative files this task changed. Console errors whose
   * stack/source names none of them (and hydration-mismatch warnings)
   * are classified pre-existing: a warning, never a failed check.
   */
  changedFiles?: string[];
}

/** One console/page error as captured: its text plus stack/source location. */
export interface ConsoleErrorEntry {
  text: string;
  /** Stack trace and/or source URL (location of the console call). */
  source?: string;
}

const HYDRATION_PATTERNS = [
  /hydration failed/i,
  /hydration (mismatch|error)/i,
  /did(?:n't| not) match\.?\s*server/i,
  /hydrated but some attributes/i,
  /server rendered (html|text)[^.]*(didn't|did not|does not|doesn't) match/i,
  /text content does not match server-rendered html/i,
  /there was an error while hydrating/i,
];

/** React's hydration-mismatch warning/error (usually a pre-existing SSR issue). */
export function isHydrationMismatch(text: string): boolean {
  return HYDRATION_PATTERNS.some((pattern) => pattern.test(text));
}

const SOURCE_PATH_RE =
  /(?:^|[\s(@"'`])\.?\/?((?:[\w@.\-\[\]()]+\/)+[\w@.\-\[\]]+\.(?:tsx|ts|jsx|js|mjs|cjs|vue|svelte|astro))(?=[:\s)"'`?]|$)/g;

function normalizeRel(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/\/\.\//g, "/")
    .replace(/^(\.?\/)+/, "");
}

/**
 * Source files named in an error's text/stack, workspace-relative where
 * possible. Bundler chunks, node_modules and Next/Vite internals are
 * dropped: they say nothing about which project file failed.
 */
export function sourcePathsIn(text: string): string[] {
  const cleaned = text
    // Next/webpack dev frames: webpack-internal:///(app-pages-browser)/./components/x.tsx
    .replace(/webpack-internal:\/\/\/(?:\([^)\/]*\)\/)?/g, " ")
    // http://127.0.0.1:3000/src/x.tsx (Vite serves sources by path)
    .replace(/https?:\/\/[^/\s]+/g, " ")
    .replace(/file:\/\//g, " ");
  const out: string[] = [];
  for (const match of cleaned.matchAll(SOURCE_PATH_RE)) {
    const candidate = normalizeRel(match[1] ?? "");
    if (!candidate.includes("/")) continue;
    if (/(^|\/)node_modules\//.test(candidate)) continue;
    if (/^(_next|@vite|@fs|@id|@react-refresh|__vite|static\/chunks)\b/.test(candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** The changed file an error references (path, or path without extension), if any. */
export function changedFileReferenced(text: string, changedFiles: string[]): string | undefined {
  for (const file of changedFiles) {
    const rel = normalizeRel(file);
    if (!rel) continue;
    const noExt = rel.replace(/\.[a-z0-9]+$/i, "");
    if (text.includes(rel) || (noExt.includes("/") && text.includes(noExt))) return rel;
  }
  return undefined;
}

/**
 * Split captured console errors into the ones this change plausibly
 * caused and pre-existing ones. Pre-existing = names no changed file AND
 * (a hydration-mismatch warning, or its stack names only files the task
 * did not change). An error with no source path at all is NOT assumed
 * pre-existing (we cannot tell where it came from), unless it is a
 * hydration mismatch. Also derives the most likely file for the caused
 * errors (a changed file first, else the first project source path).
 */
export function classifyConsoleErrors(
  entries: ConsoleErrorEntry[],
  changedFiles: string[]
): { caused: string[]; preExisting: string[]; filePath?: string } {
  const caused: string[] = [];
  const preExisting: string[] = [];
  let filePath: string | undefined;
  let fallbackPath: string | undefined;
  for (const entry of entries) {
    const haystack = `${entry.text}\n${entry.source ?? ""}`;
    const changed = changedFileReferenced(haystack, changedFiles);
    const paths = sourcePathsIn(haystack);
    if (changed) {
      caused.push(entry.text);
      filePath ??= changed;
      continue;
    }
    const fromUnchanged = changedFiles.length > 0 && paths.length > 0;
    if (isHydrationMismatch(entry.text) || fromUnchanged) {
      preExisting.push(entry.text);
      continue;
    }
    caused.push(entry.text);
    fallbackPath ??= paths[0];
  }
  return { caused, preExisting, ...(filePath ?? fallbackPath ? { filePath: filePath ?? fallbackPath } : {}) };
}

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const SERVER_LOG_LIMIT = 4_000;

function startupTimeoutMs(options: QaOptions): number {
  if (options.startupTimeoutMs && options.startupTimeoutMs > 0) return options.startupTimeoutMs;
  const fromEnv = Number(process.env.QA_STARTUP_TIMEOUT_MS ?? process.env.QA_SERVER_START_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_STARTUP_TIMEOUT_MS;
}

/** Every dev server QA started, so a worker exit/signal never orphans one. */
const liveServers = new Set<ChildProcess>();
let exitHookInstalled = false;
function trackServer(child: ChildProcess): void {
  liveServers.add(child);
  child.once("exit", () => liveServers.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const server of liveServers) killTree(server);
  });
}

/** True when the URL points at this machine (auto-start is only safe there). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * CLI args that pin the dev server to the allocated port and host. Vite-
 * family servers ignore PORT, and `localhost` may bind ::1 only while QA
 * probes 127.0.0.1. Exported for tests.
 */
export function devServerPortArgs(script: string, port: string): string[] {
  if (/\bnext\b/.test(script)) return ["--", "--port", port, "--hostname", "127.0.0.1"];
  if (/\bastro\b/.test(script)) return ["--", "--port", port, "--host", "127.0.0.1"];
  if (/\bnuxi?\b/.test(script)) return ["--", "--port", port, "--host", "127.0.0.1"];
  if (/\b(vite|svelte-kit)\b/.test(script)) {
    return ["--", "--port", port, "--host", "127.0.0.1", "--strictPort"];
  }
  return [];
}

interface DevCommand {
  kind: "script" | "static";
  script?: "dev" | "start";
  args: string[];
}

/**
 * Decide how to start the target app, or throw QaEnvironmentError with a
 * clear setup note (no package.json script and no index.html; missing
 * node_modules for a project with dependencies).
 */
async function resolveDevCommand(workspaceRoot: string, port: string): Promise<DevCommand> {
  const exists = (rel: string) =>
    fs.access(path.join(workspaceRoot, rel)).then(() => true, () => false);
  let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object } | null = null;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"));
  } catch {
    pkg = null;
  }
  const scriptName = pkg?.scripts?.dev ? "dev" : pkg?.scripts?.start ? "start" : undefined;
  if (!scriptName) {
    if (await exists("index.html")) return { kind: "static", args: [] };
    throw new QaEnvironmentError(
      pkg
        ? "package.json has no \"dev\" or \"start\" script and there is no index.html to serve"
        : "No package.json with a dev/start script and no index.html: nothing QA can start"
    );
  }
  const hasDeps =
    Object.keys(pkg?.dependencies ?? {}).length + Object.keys(pkg?.devDependencies ?? {}).length > 0;
  if (hasDeps && !(await exists("node_modules"))) {
    throw new QaEnvironmentError("node_modules is missing (run npm install in the project first)");
  }
  const script = pkg?.scripts?.[scriptName] ?? "";
  return { kind: "script", script: scriptName, args: devServerPortArgs(script, port) };
}

/**
 * Browser-runnable project: an explicit QA/dev URL, a package.json
 * dev/start script, or a root index.html (served statically).
 */
export async function isBrowserRunnable(workspaceRoot: string, explicitUrl?: string): Promise<boolean> {
  if (explicitUrl || process.env.QA_BASE_URL) return true;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"));
    if (pkg?.scripts?.dev || pkg?.scripts?.start) return true;
  } catch {
    // No/invalid package.json: fall through to index.html.
  }
  return fs.access(path.join(workspaceRoot, "index.html")).then(() => true, () => false);
}

/** Minimal static server for plain index.html projects. */
async function startStaticServer(root: string, port: number): Promise<import("node:http").Server> {
  const http = await import("node:http");
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".ico": "image/x-icon",
  };
  const resolvedRoot = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      if (urlPath === "/favicon.ico") { res.writeHead(204).end(); return; }
      let file = path.resolve(resolvedRoot, `.${urlPath}`);
      if (!file.startsWith(resolvedRoot)) { res.writeHead(403).end(); return; }
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isDirectory()) file = path.join(file, "index.html");
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

/**
 * Browser launch options. QA_CHROMIUM_PATH (fallback
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) points at a system Chromium, e.g.
 * on linux-arm64 where Playwright's CDN has no build. --no-sandbox is added
 * when QA_CHROMIUM_NO_SANDBOX=1, when running as root, or inside a
 * container (/.dockerenv), where Chromium's sandbox cannot start.
 */
export function chromiumLaunchOptions(): { headless: true; executablePath?: string; args?: string[] } {
  const executablePath =
    process.env.QA_CHROMIUM_PATH?.trim() || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
  const flag = (process.env.QA_CHROMIUM_NO_SANDBOX ?? "").trim().toLowerCase();
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  let inContainer = false;
  try {
    inContainer = existsSync("/.dockerenv");
  } catch {
    inContainer = false;
  }
  const noSandbox = flag === "0" || flag === "false" ? false : flag !== "" || isRoot || inContainer;
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(noSandbox ? { args: ["--no-sandbox"] } : {}),
  };
}

async function browserInstalled(): Promise<boolean> {
  try {
    const executable = chromiumLaunchOptions().executablePath ?? chromium.executablePath();
    if (!executable) return false;
    await fs.access(executable);
    return true;
  } catch {
    return false;
  }
}

export const QA_VIEWPORTS = [
  { label: "desktop", width: 1440, height: 900 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "mobile", width: 375, height: 812 },
];

const DEV_NOISE_PATTERNS = [
  /\/_next\/(?:webpack-)?hmr\b/i,
  /webpack-hmr/i,
  /\[Fast Refresh\]/i,
];

function isDevNoise(text: string): boolean {
  return DEV_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

export async function runResponsiveQa(
  workspaceRoot: string,
  options: QaOptions = {}
): Promise<QaReport> {
  // QA must run the TARGET project itself: when no URL is explicitly
  // given, allocate a free port and let the auto-start dev server run
  // there. Defaulting silently to a fixed port (historically 3000) made
  // QA pass against whatever foreign app happened to sit on it.
  let baseUrl = options.baseUrl ?? process.env.QA_BASE_URL;
  if (!baseUrl) {
    const freePort = await getFreePort();
    baseUrl = `http://127.0.0.1:${freePort}`;
  }
  const screenshotsDir = path.join(workspaceRoot, ".qa", "screenshots");
  const baselinesDir = path.join(workspaceRoot, ".qa", "baselines");
  // Artefacts only exist in visual mode; structural QA never writes into
  // the user's repo.
  if (options.visualRegression) await fs.mkdir(screenshotsDir, { recursive: true });

  const checks: QaCheck[] = [];
  const failures: string[] = [];
  const inconclusive: string[] = [];
  let blockedReason: string | undefined;
  let server: ChildProcess | undefined;
  let staticServer: import("node:http").Server | undefined;
  let browser: Browser | undefined;
  const signal = options.signal;
  // Last lines the dev server printed (stdout + stderr), so a start
  // failure reports the real cause (compile error, EADDRINUSE, ...).
  let serverLog = "";
  const appendLog = (chunk: Buffer | string) => {
    serverLog = (serverLog + chunk.toString()).slice(-SERVER_LOG_LIMIT);
  };
  const logTail = (): string => {
    const lines = serverLog.trim().split(/\r?\n/).filter(Boolean).slice(-15).join("\n");
    return lines ? `\nLast dev-server output:\n${lines}` : "";
  };
  const block = async (reason: string) => {
    blockedReason = reason;
    await record({ label: "qa-environment", status: "inconclusive", details: reason });
  };

  // On abort, tear down immediately: close the browser and kill the
  // dev-server PROCESS TREE instead of letting the current step run
  // out. The server is spawned detached (its own process group), so
  // killTree reaches the grandchildren a plain kill() would orphan —
  // npm's shell shim and the actual dev server behind it (Phase 4
  // hardening).
  const onAbort = () => {
    if (browser) void browser.close().catch(() => undefined);
    if (server) killTree(server);
    if (staticServer) staticServer.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const record = async (check: QaCheck) => {
    checks.push(check);
    if (check.status === "failed") failures.push(`${check.label}: ${check.details ?? "failed"}`);
    if (check.status === "inconclusive") {
      inconclusive.push(`${check.label}: ${check.details ?? "inconclusive"}`);
    }
    await options.onCheck?.(check);
  };

  try {
    if (signal?.aborted) {
      await record({
        label: "qa-run",
        status: "failed",
        details: "QA cancelled before it could run",
      });
    } else if (!(await isBrowserRunnable(workspaceRoot, options.baseUrl))) {
      await block(
        "the project is not browser-runnable (no QA/dev URL, no package.json dev/start script, no index.html)"
      );
    } else if (options.preflight !== false && !(await browserInstalled())) {
      await block(
        "Chromium is not installed on the worker (run: npx playwright install chromium, or set QA_CHROMIUM_PATH to a system Chromium)"
      );
    } else if (!(await canReach(baseUrl))) {
      if (options.autoStartServer === false || !isLoopbackUrl(baseUrl)) {
        await record({
          label: "application reachable",
          status: "failed",
          details: `No server reachable at ${baseUrl}${
            isLoopbackUrl(baseUrl) ? "" : " (remote URL: not auto-started)"
          }`,
        });
      } else {
        // Derive the dev-server port from the resolved URL so the
        // auto-started server (and the checks below) target the same
        // app. Allowing a stale default here would QA whichever foreign
        // process happens to sit on that port.
        let targetPort = "3000";
        try {
          targetPort = new URL(baseUrl).port || targetPort;
        } catch {
          // Malformed qaUrl/host: keep the historical default port.
        }
        const dev = await resolveDevCommand(workspaceRoot, targetPort);
        let exited: { code: number | null; error?: string } | null = null;
        if (dev.kind === "static") {
          staticServer = await startStaticServer(workspaceRoot, Number(targetPort));
        } else {
          const isWin = process.platform === "win32";
          const npmArgs = ["run", dev.script ?? "dev", ...dev.args];
          server = spawn(isWin ? "cmd.exe" : "npm", isWin ? ["/c", "npm.cmd", ...npmArgs] : npmArgs, {
            cwd: workspaceRoot,
            env: buildChildEnv({ PORT: targetPort, HOST: "127.0.0.1" }),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            // Own process group on POSIX so the finally/abort cleanup
            // can killTree the whole tree (see killTree).
            detached: !isWin,
          });
          trackServer(server);
          server.stdout?.on("data", appendLog);
          server.stderr?.on("data", appendLog);
          server.once("error", (error: NodeJS.ErrnoException) => {
            exited = { code: null, error: error.code === "ENOENT" ? "npm is not installed or not on PATH" : error.message };
          });
          server.once("exit", (code) => {
            if (!exited) exited = { code };
          });
        }
        const up = await waitForUrl(baseUrl, startupTimeoutMs(options), signal, () => exited !== null);
        const exitInfo = exited as { code: number | null; error?: string } | null;
        if (signal?.aborted) {
          await record({
            label: "qa-run",
            status: "failed",
            details: "QA cancelled while the development server was starting",
          });
        } else if (!up && exitInfo?.error) {
          await block(`Could not start the dev server: ${exitInfo.error}`);
        } else if (!up) {
          await record({
            label: "application reachable",
            status: "failed",
            details: `${
              exitInfo
                ? `Development server exited (code ${exitInfo.code ?? "?"}) before it served ${baseUrl}`
                : `Development server did not start at ${baseUrl} within ${Math.round(
                    startupTimeoutMs(options) / 1000
                  )}s`
            }${logTail()}`,
          });
        } else {
          await record({
            label: "application reachable",
            status: "passed",
            details: baseUrl,
          });
        }
      }
    } else {
      await record({ label: "application reachable", status: "passed", details: baseUrl });
    }

    if (failures.length === 0 && !blockedReason) {
      try {
        browser = await chromium.launch(chromiumLaunchOptions());
      } catch (error) {
        throw new QaEnvironmentError(
          `Browser could not launch: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
        );
      }
      try {
        const qaViewports = options.visualRegression
      ? QA_VIEWPORTS
      : [{ label: "structural", width: 1280, height: 720 }];
    for (const viewport of qaViewports) {
          // Cancellation is checked between Playwright steps: an
          // aborted task stops before the next viewport instead of
          // running every remaining check.
          if (signal?.aborted) {
            await record({
              label: "qa-run",
              status: "failed",
              details: "QA cancelled",
            });
            break;
          }
          // Structural mode has no viewports to label: the check is one
          // structural pass over the page. Naming it a "viewport" check
          // would claim responsive coverage that never ran (plan 011).
          const label = checkLabelFor(viewport.label, options.visualRegression ?? false);
          const consoleErrors: ConsoleErrorEntry[] = [];
          const networkErrors: string[] = [];
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
          });
          page.on("console", (message) => {
            if (message.type() !== "error") return;
            const text = message.text().slice(0, 300);
            if (isDevNoise(text)) return;
            // Chromium's generic "Failed to load resource" line carries no
            // URL; HTTP failures are reported (with their URL) by the
            // response listener below instead.
            if (/^Failed to load resource/i.test(text)) return;
            const location = message.location();
            consoleErrors.push({
              text,
              source: location?.url ? `${location.url}:${location.lineNumber ?? 0}` : undefined,
            });
          });
          const origin = new URL(baseUrl).origin;
          page.on("response", (response) => {
            const url = response.url();
            if (response.status() < 400 || isDevNoise(url)) return;
            if (response.request().isNavigationRequest()) return; // main document: checked below
            if (/\/favicon\.ico(?:$|\?)/i.test(url)) return;
            // Third-party sub-resources are not the app's defect.
            if (!url.startsWith(origin)) return;
            networkErrors.push(`HTTP ${response.status()} ${url}`);
          });
          // Uncaught exceptions arrive as `pageerror`, not console errors.
          page.on("pageerror", (error) => {
            consoleErrors.push({
              text: `Uncaught: ${error.message}`.slice(0, 300),
              source: (error.stack ?? "").slice(0, 2_000),
            });
          });
          page.on("requestfailed", (request) => {
            const url = request.url();
            if (isDevNoise(url)) return;
            networkErrors.push(
              `${request.method()} ${url}: ${request.failure()?.errorText ?? "failed"}`
            );
          });

          try {
            const response = await page.goto(baseUrl, {
              waitUntil: "load",
              timeout: 30_000,
            });
            // Best effort: pages with polling/analytics never go idle.
            await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
            const status = response?.status() ?? 0;
            if (status >= 400) {
              await record({
                label,
                status: "failed",
                details: `Page returned HTTP ${status}`,
              });
              continue;
            }

            await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
            const bodyText = (await page.locator("body").innerText()).trim();
            if (bodyText.length === 0) {
              await record({ label, status: "failed", details: "Page body is empty" });
              continue;
            }

            const overlay = page.locator(
              "[data-nextjs-dialog-overlay], .vite-error-overlay"
            );
            // Only a VISIBLE overlay counts, and its own text is reported:
            // "overlay is visible" alone told the user nothing about the error.
            if ((await overlay.count()) > 0 && (await overlay.first().isVisible().catch(() => false))) {
              const overlayText = await page
                .locator("[data-nextjs-dialog], [data-nextjs-dialog-overlay], .vite-error-overlay")
                .first()
                .innerText({ timeout: 2_000 })
                .catch(() => "");
              const summary = overlayText.replace(/\s+/g, " ").trim().slice(0, 400);
              await record({
                label,
                status: "failed",
                details: summary
                  ? `Framework error overlay is visible: ${summary}`
                  : "Framework error overlay is visible",
              });
              continue;
            }

            // Deterministic split (no blind retry can change it): errors
            // this change plausibly caused fail the check; pre-existing
            // ones (hydration mismatch, stack only in unchanged files)
            // are carried as a warning on an otherwise-passing check.
            const consoleSplit = classifyConsoleErrors(consoleErrors, options.changedFiles ?? []);
            const preExisting = consoleSplit.preExisting.length > 0 ? consoleSplit.preExisting : undefined;
            const preExistingNote = preExisting
              ? `; pre-existing, not caused by this change: ${preExisting.join(" | ")}`
              : "";
            if (consoleSplit.caused.length > 0) {
              await record({
                label,
                status: "failed",
                details: `Console errors: ${consoleSplit.caused.join(" | ")}${preExistingNote}`,
                ...(consoleSplit.filePath ? { filePath: consoleSplit.filePath } : {}),
                ...(preExisting ? { preExisting } : {}),
              });
              continue;
            }
            if (networkErrors.length > 0) {
              await record({
                label,
                status: "failed",
                details: `Network failures: ${networkErrors.join(" | ")}`,
              });
              continue;
            }

            if (options.visualRegression) {
              const screenshotPath = path.join(screenshotsDir, `${viewport.label}.png`);
              await page.screenshot({ path: screenshotPath, fullPage: true });
              const baseline = await compareScreenshot(
                screenshotPath,
                path.join(baselinesDir, `${viewport.label}.png`)
              );
              await record({
                label,
                status: baseline.status,
                details: `${baseline.details}${preExistingNote}`,
                ...(preExisting ? { preExisting } : {}),
              });
            } else {
              await record({
                label,
                status: "passed",
                details: `Page rendered with visible body; no screenshot or visual comparison${preExistingNote}`,
                ...(preExisting ? { preExisting } : {}),
              });
            }
          } catch (error) {
            await record({
              label,
              status: "failed",
              details: error instanceof Error ? error.message : String(error),
            });
          } finally {
            await page.close();
          }
        }
      } finally {
        await browser.close();
        browser = undefined;
      }
    }
  } catch (error) {
    if (error instanceof QaEnvironmentError) {
      await block(error.message);
    } else {
      await record({
        label: "qa-run",
        status: "failed",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    // Cleanup on EVERY exit path — success, failure, exception, abort:
    // the browser was already closed in its own finally above; the dev
    // server's whole process tree dies here, not just the npm shim.
    signal?.removeEventListener("abort", onAbort);
    if (server) {
      killTree(server);
      liveServers.delete(server);
      server = undefined;
    }
    if (staticServer) {
      staticServer.close();
      staticServer = undefined;
    }
  }

  const verdict: QaReport["verdict"] =
    failures.length > 0
      ? "failed"
      : blockedReason
        ? "blocked"
        : inconclusive.length > 0
          ? "inconclusive"
          : "passed";
  return { verdict, checks, failures, inconclusive, ...(blockedReason ? { blockedReason } : {}) };
}

async function compareScreenshot(
  actualPath: string,
  baselinePath: string
): Promise<{ status: QaCheck["status"]; details: string }> {
  let actual: Buffer;
  try {
    actual = await fs.readFile(actualPath);
  } catch (error) {
    return {
      status: "failed",
      details: `Screenshot was not captured: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let baseline: Buffer;
  try {
    baseline = await fs.readFile(baselinePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // No baseline yet: save this screenshot as baseline, don't fail the run.
      try {
        await fs.mkdir(path.dirname(baselinePath), { recursive: true });
        await fs.writeFile(baselinePath, actual);
        return {
          status: "passed",
          details: "Baseline created, no comparison (first visual run; nothing to compare against yet)",
        };
      } catch {
        return {
          status: "inconclusive",
          details: "No baseline screenshot; visual regression was not verified",
        };
      }
    }
    return {
      status: "failed",
      details: `Baseline could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const actualPng = PNG.sync.read(actual);
    const baselinePng = PNG.sync.read(baseline);
    if (
      actualPng.width !== baselinePng.width ||
      actualPng.height !== baselinePng.height
    ) {
      return {
        status: "failed",
        details: `Screenshot dimensions differ (${actualPng.width}x${actualPng.height} vs ${baselinePng.width}x${baselinePng.height})`,
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
      return {
        status: "failed",
        details: `Screenshot differs from baseline by ${changedPixels} pixels`,
      };
    }
    return { status: "passed", details: "Screenshot matches baseline" };
  } catch (error) {
    const digest = createHash("sha256").update(actual).digest("hex").slice(0, 12);
    return {
      status: "failed",
      details: `Screenshot comparison failed (${digest}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** First free TCP port for the auto-started dev server. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a free port"));
      });
    });
  });
}

/**
 * Any HTTP response means a server is listening: a 404/500 at `/` is a
 * page problem for the browser checks to report, not "unreachable" (which
 * would spawn a second server on the same port).
 */
async function canReach(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
    await response.body?.cancel().catch(() => undefined);
    return response.status > 0;
  } catch {
    return false;
  }
}

async function waitForUrl(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  gaveUp?: () => boolean
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    // The server process already died: fail fast instead of polling.
    if (gaveUp?.()) return canReach(url);
    if (await canReach(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
