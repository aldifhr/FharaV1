import { NextRequest, NextResponse } from "next/server";
import { VIEWPORTS, type BrowserCapture, type NetworkEntry, type ConsoleEntry } from "@/lib/browserLab";

/**
 * Browser Lab capture: one headless Chromium pass against a URL.
 * Returns title, final URL, screenshot (data URL), console entries,
 * network failures and the rendered DOM head. Stateless: each call is a
 * fresh browser (no cookies or history leak between captures).
 */

export const runtime = "nodejs";
export const maxDuration = 60;

function validUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  let body: { url?: string; viewport?: string };
  try {
    body = (await request.json()) as { url?: string; viewport?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const url = validUrl(body.url ?? "");
  if (!url) return NextResponse.json({ error: "Provide an http(s) URL" }, { status: 400 });

  const viewport = VIEWPORTS[body.viewport ?? ""] ?? VIEWPORTS.desktop;

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return NextResponse.json({ error: "Playwright is not installed." }, { status: 503 });
  }

  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport });

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
      const entry: NetworkEntry = {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: response.status() >= 400,
      };
      networkEntries.push(entry);
    });
    page.on("requestfailed", (req) => {
      networkEntries.push({
        url: req.url(),
        method: req.method(),
        status: 0,
        failed: true,
      });
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {
      // Even on timeout, whatever rendered is still meaningful.
    });

    const title = (await page.title().catch(() => "")).slice(0, 200);
    const finalUrl = page.url();
    const dom = (await page.content().catch(() => "")).slice(0, 60_000);
    const buffer = await page.screenshot({ fullPage: false }).catch(() => null);
    const screenshot = buffer ? `data:image/png;base64,${buffer.toString("base64")}` : null;

    const capture: BrowserCapture = {
      title,
      finalUrl,
      screenshot,
      console: consoleEntries.slice(-100),
      network: networkEntries.slice(-200),
      dom,
      capturedAt: Date.now(),
      viewport: { width: viewport.width, height: viewport.height },
    };
    return NextResponse.json(capture);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 500) : "Capture failed" },
      { status: 502 },
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
