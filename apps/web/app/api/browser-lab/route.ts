import { NextRequest, NextResponse } from "next/server";
import { VIEWPORTS, type BrowserCapture, type NetworkEntry, type ConsoleEntry } from "@/lib/browserLab";
import { rejectUnsafeRequest } from "@/lib/apiGuard";
import { readJsonObject } from "@/lib/proxyArgs";
import { UrlBlockedError, assertPublicHttpUrl } from "@/lib/ssrfGuard";

/**
 * Browser Lab capture: one headless Chromium pass against a URL.
 * Returns title, final URL, screenshot (data URL), console entries,
 * network failures and the rendered DOM head. Stateless: each call is a
 * fresh browser (no cookies or history leak between captures).
 *
 * Release audit P0-6 (SSRF):
 *  - http/https only; the host must resolve to public addresses only
 *    (no loopback, private, link-local, CGNAT or cloud-metadata ranges);
 *  - every request the page makes, including each redirect hop and
 *    WebSocket, is re-checked the same way and refused when it fails
 *    (redirects are resolved server-side, never handed to Chromium as 3xx);
 *  - service workers are blocked so they cannot bypass the request hook;
 *  - caps: 2 captures at a time, 45 s per capture, 5 MB per response and
 *    25 MB per capture.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_CONCURRENT = 2;
const CAPTURE_DEADLINE_MS = 45_000;
const NAV_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_HOPS = 5;

let active = 0;

/** Same knobs as the worker's QA browser (packages/worker/src/execution/qa.ts). */
function launchOptions(): { headless: true; executablePath?: string; args?: string[] } {
  const executablePath =
    process.env.QA_CHROMIUM_PATH?.trim() || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
  const flag = (process.env.QA_CHROMIUM_NO_SANDBOX ?? "").trim().toLowerCase();
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const noSandbox = flag === "0" || flag === "false" ? false : flag !== "" || isRoot;
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(noSandbox ? { args: ["--no-sandbox"] } : {}),
  };
}

class DeadlineError extends Error {}

export async function POST(request: NextRequest) {
  const rejected = rejectUnsafeRequest(request);
  if (rejected) return rejected;

  const body = await readJsonObject(request, 8 * 1024);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  let url: string;
  try {
    url = await assertPublicHttpUrl(typeof body.url === "string" ? body.url : "");
  } catch (error) {
    const message = error instanceof UrlBlockedError ? error.message : "Provide an http(s) URL";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const viewport = VIEWPORTS[typeof body.viewport === "string" ? body.viewport : ""] ?? VIEWPORTS.desktop;

  if (active >= MAX_CONCURRENT) {
    return NextResponse.json({ error: "Another capture is running; try again in a moment." }, { status: 429 });
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return NextResponse.json({ error: "Playwright is not installed." }, { status: 503 });
  }

  active += 1;
  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  try {
    const capture = (async (): Promise<BrowserCapture> => {
      browser = await chromium.launch(launchOptions());
      if (finished) {
        await browser.close().catch(() => undefined);
        throw new DeadlineError("Capture timed out");
      }
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });

      // Per-capture DNS verdict cache (host → allowed?) and byte budget.
      const verdicts = new Map<string, Promise<boolean>>();
      const allowed = (target: string): Promise<boolean> => {
        let host: string;
        try {
          const parsed = new URL(target);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return Promise.resolve(false);
          host = parsed.host;
        } catch {
          return Promise.resolve(false);
        }
        let verdict = verdicts.get(host);
        if (!verdict) {
          verdict = assertPublicHttpUrl(target).then(
            () => true,
            () => false,
          );
          verdicts.set(host, verdict);
        }
        return verdict;
      };
      let totalBytes = 0;

      // Playwright does not route the follow-up of a redirect it fulfilled,
      // so redirects are never handed to the browser as 3xx. Each hop is
      // fetched here with maxRedirects 0 and its Location checked first:
      //  - a navigation gets a tiny page that navigates to the checked
      //    Location (that navigation is routed and checked again);
      //  - a subresource is followed here, hop by hop, up to MAX_HOPS.
      await context.route("**/*", async (route) => {
        const req = route.request();
        let target = req.url();
        const abort = () => route.abort("blockedbyclient").catch(() => undefined);
        try {
          for (let hop = 0; ; hop += 1) {
            if (!(await allowed(target))) return await abort();
            const response = await route.fetch({ url: target, maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS });
            const status = response.status();
            const location = response.headers()["location"];
            if (status >= 300 && status < 400 && location) {
              const next = new URL(location, target).toString();
              if (!(await allowed(next))) return await abort();
              if (req.isNavigationRequest()) {
                const escaped = next.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
                return await route.fulfill({
                  status: 200,
                  contentType: "text/html; charset=utf-8",
                  body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escaped}">`,
                });
              }
              if (hop >= MAX_HOPS) return await abort();
              target = next;
              continue;
            }
            const declared = Number(response.headers()["content-length"] ?? "0");
            if (declared > MAX_RESPONSE_BYTES || totalBytes + declared > MAX_TOTAL_BYTES) return await abort();
            const bodyBuffer = await response.body();
            totalBytes += bodyBuffer.length;
            if (bodyBuffer.length > MAX_RESPONSE_BYTES || totalBytes > MAX_TOTAL_BYTES) return await abort();
            return await route.fulfill({ response, body: bodyBuffer });
          }
        } catch {
          await route.abort("failed").catch(() => undefined);
        }
      });
      await context.routeWebSocket(/.*/, async (ws) => {
        const httpUrl = ws.url().replace(/^ws(s?):/i, "http$1:");
        if (await allowed(httpUrl)) ws.connectToServer();
        else await ws.close().catch(() => undefined);
      });

      const page = await context.newPage();

      page.on("console", (message) => {
        const text = message.text().slice(0, 2000);
        if (text) {
          const loc = typeof message.location === "function" ? message.location() : (message.location as { url?: string; lineNumber?: number } | undefined);
          consoleEntries.push({
            type: message.type(),
            text,
            location: loc?.url ? `${loc.url}:${loc.lineNumber ?? "?"}` : undefined,
            at: Date.now(),
          });
        }
      });
      page.on("pageerror", (error) => {
        consoleEntries.push({ type: "error", text: String(error).slice(0, 2000), at: Date.now() });
      });
      page.on("response", (response) => {
        networkEntries.push({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          failed: response.status() >= 400,
        });
      });
      page.on("requestfailed", (req) => {
        networkEntries.push({ url: req.url(), method: req.method(), status: 0, failed: true });
      });

      await page.goto(url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS }).catch(() => {
        // Even on timeout, whatever rendered is still meaningful.
      });

      const title = (await page.title().catch(() => "")).slice(0, 200);
      const finalUrl = page.url();
      const dom = (await page.content().catch(() => "")).slice(0, 60_000);
      const buffer = await page.screenshot({ fullPage: false, timeout: 10_000 }).catch(() => null);
      const screenshot = buffer ? `data:image/png;base64,${buffer.toString("base64")}` : null;

      return {
        title,
        finalUrl,
        screenshot,
        console: consoleEntries.slice(-100),
        network: networkEntries.slice(-200),
        dom,
        capturedAt: Date.now(),
        viewport: { width: viewport.width, height: viewport.height },
      };
    })();

    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new DeadlineError("Capture timed out")), CAPTURE_DEADLINE_MS);
    });
    capture.catch(() => undefined); // the race below owns the error
    return NextResponse.json(await Promise.race([capture, timeout]));
  } catch (error) {
    const status = error instanceof DeadlineError ? 504 : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 500) : "Capture failed" },
      { status },
    );
  } finally {
    finished = true;
    if (deadline) clearTimeout(deadline);
    await (browser as { close(): Promise<void> } | undefined)?.close().catch(() => undefined);
    active -= 1;
  }
}
