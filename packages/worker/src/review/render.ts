/**
 * PNG renders for the options review, on the QA Playwright/Chromium setup.
 *
 *  - `renderHtmlOption`: a sanitized html option, rendered with JavaScript
 *    disabled, service workers blocked and EVERY network request aborted
 *    (data: URIs never reach the router), under the preview CSP.
 *  - `captureRoute`: a screenshot of a route of the running app (loopback
 *    only), for a "today's screen" reference option and QA's
 *    build-vs-mockup check. Only same-origin requests are allowed.
 */
import { chromium, type Browser } from "playwright";
import { chromiumLaunchOptions, isLoopbackUrl } from "@/execution/qa";
import { previewDocument } from "@/api/convex/lib/optionsReview";

export const RENDER_VIEWPORT = { width: 1280, height: 800 } as const;
/** Tallest render kept (px); taller pages are clipped. */
export const RENDER_MAX_HEIGHT = 2400;
const RENDER_TIMEOUT_MS = 20_000;

async function withBrowser<T>(fn: (browser: Browser) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("cancelled");
  const browser = await chromium.launch(chromiumLaunchOptions());
  const onAbort = () => void browser.close().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn(browser);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => undefined);
  }
}

/** Render one sanitized html option to PNG (scripts off, network blocked). */
export async function renderHtmlOption(sanitizedHtml: string, opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
  return await withBrowser(async (browser) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
      viewport: { ...RENDER_VIEWPORT },
      deviceScaleFactor: 1,
      bypassCSP: false,
    });
    try {
      await context.route("**/*", (route) => route.abort("blockedbyclient"));
      const page = await context.newPage();
      await page.setContent(previewDocument(sanitizedHtml), { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
      const full = await page.screenshot({ fullPage: true, type: "png", timeout: RENDER_TIMEOUT_MS });
      return await clipPng(page, full);
    } finally {
      await context.close().catch(() => undefined);
    }
  }, opts.signal);
}

/** Screenshot `route` of the running app at `baseUrl` (loopback only). */
export async function captureRoute(baseUrl: string, route: string, opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
  if (!isLoopbackUrl(baseUrl)) throw new Error("Route screenshots are only taken of a local app (loopback URL)");
  const target = new URL(route, baseUrl);
  const origin = new URL(baseUrl).origin;
  if (target.origin !== origin) throw new Error("The route must stay on the app's own origin");
  return await withBrowser(async (browser) => {
    const context = await browser.newContext({ viewport: { ...RENDER_VIEWPORT }, deviceScaleFactor: 1, serviceWorkers: "block" });
    try {
      await context.route("**/*", (r) => {
        const url = r.request().url();
        return url.startsWith(origin) || url.startsWith("data:") ? r.continue() : r.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.goto(target.toString(), { waitUntil: "networkidle", timeout: 45_000 }).catch(async () => {
        await page.waitForLoadState("load", { timeout: 15_000 });
      });
      const full = await page.screenshot({ fullPage: true, type: "png", timeout: RENDER_TIMEOUT_MS });
      return await clipPng(page, full);
    } finally {
      await context.close().catch(() => undefined);
    }
  }, opts.signal);
}

/** Keep at most RENDER_MAX_HEIGHT px of a full-page shot. */
async function clipPng(page: import("playwright").Page, full: Buffer): Promise<Buffer> {
  const height = full.readUInt32BE(20);
  if (height <= RENDER_MAX_HEIGHT) return full;
  return await page.screenshot({
    type: "png",
    fullPage: true,
    clip: { x: 0, y: 0, width: RENDER_VIEWPORT.width, height: RENDER_MAX_HEIGHT },
    timeout: RENDER_TIMEOUT_MS,
  });
}

