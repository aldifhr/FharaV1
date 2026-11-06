import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface QaCheck {
  label: string;
  status: "passed" | "failed" | "inconclusive";
  details?: string;
}

export interface QaReport {
  verdict: "passed" | "failed" | "inconclusive";
  checks: QaCheck[];
  failures: string[];
  inconclusive: string[];
}

export interface QaOptions {
  baseUrl?: string;
  autoStartServer?: boolean;
  onCheck?: (check: QaCheck) => Promise<void>;
}

const VIEWPORTS = [
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
  const baseUrl = options.baseUrl ?? process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
  const screenshotsDir = path.join(workspaceRoot, ".qa", "screenshots");
  const baselinesDir = path.join(workspaceRoot, ".qa", "baselines");
  await fs.mkdir(screenshotsDir, { recursive: true });

  const checks: QaCheck[] = [];
  const failures: string[] = [];
  const inconclusive: string[] = [];
  let server: ChildProcess | undefined;

  const record = async (check: QaCheck) => {
    checks.push(check);
    if (check.status === "failed") failures.push(`${check.label}: ${check.details ?? "failed"}`);
    if (check.status === "inconclusive") {
      inconclusive.push(`${check.label}: ${check.details ?? "inconclusive"}`);
    }
    await options.onCheck?.(check);
  };

  try {
    if (!(await canReach(baseUrl))) {
      if (options.autoStartServer === false) {
        await record({
          label: "application reachable",
          status: "failed",
          details: `No server reachable at ${baseUrl}`,
        });
      } else {
        const isWin = process.platform === "win32";
        server = spawn(
          isWin ? "cmd.exe" : "npm",
          isWin ? ["/c", "npm.cmd", "run", "dev"] : ["run", "dev"],
          {
            cwd: workspaceRoot,
            env: { ...process.env, PORT: "3000" },
            windowsHide: true,
            stdio: "ignore",
          }
        );
        if (!(await waitForUrl(baseUrl, 30_000))) {
          await record({
            label: "application reachable",
            status: "failed",
            details: `Development server did not start at ${baseUrl}`,
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

    if (failures.length === 0) {
      const browser = await chromium.launch({ headless: true });
      try {
        for (const viewport of VIEWPORTS) {
          const label = `${viewport.label} viewport`;
          const consoleErrors: string[] = [];
          const networkErrors: string[] = [];
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
          });
          page.on("console", (message) => {
            if (message.type() !== "error") return;
            const text = message.text().slice(0, 300);
            if (isDevNoise(text)) return;
            consoleErrors.push(text);
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
              waitUntil: "networkidle",
              timeout: 30_000,
            });
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
            if ((await overlay.count()) > 0) {
              await record({
                label,
                status: "failed",
                details: "Framework error overlay is visible",
              });
              continue;
            }

            if (consoleErrors.length > 0) {
              await record({
                label,
                status: "failed",
                details: `Console errors: ${consoleErrors.join(" | ")}`,
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

            const screenshotPath = path.join(screenshotsDir, `${viewport.label}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true });
            const baseline = await compareScreenshot(
              screenshotPath,
              path.join(baselinesDir, `${viewport.label}.png`)
            );
            await record({
              label,
              status: baseline.status,
              details: baseline.details,
            });
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
      }
    }
  } catch (error) {
    await record({
      label: "qa-run",
      status: "failed",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (server?.pid) {
      server.kill();
      server = undefined;
    }
  }

  const verdict: QaReport["verdict"] =
    failures.length > 0 ? "failed" : inconclusive.length > 0 ? "inconclusive" : "passed";
  return { verdict, checks, failures, inconclusive };
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
      return {
        status: "inconclusive",
        details: "No baseline screenshot; visual regression was not verified",
      };
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
