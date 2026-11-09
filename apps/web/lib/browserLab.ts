/**
 * Browser Lab model (frontend only).
 *
 * The data below comes from a headless Chromium pass against a URL
 * (`/api/browser-lab`): title, final URL, screenshot, console entries,
 * network failures and the rendered DOM head. Nothing here drives a
 * browser directly — the "live" view is the embedded iframe for URLs that
 * allow framing, plus a polled screenshot/DOM refresh for the rest.
 */

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
  at: number;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  failed: boolean;
}

export interface BrowserCapture {
  title: string;
  finalUrl: string;
  screenshot: string | null;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  dom: string;
  capturedAt: number;
  viewport: { width: number; height: number };
}

export interface BrowserAction {
  id: string;
  kind: "goto" | "click" | "type" | "screenshot" | "wait";
  label: string;
  detail?: string;
  at: number;
}

export interface BrowserSession {
  id: string;
  url: string;
  viewport: string;
  startedAt: number;
  actions: BrowserAction[];
}

export const VIEWPORTS: Record<string, { label: string; width: number; height: number }> = {
  desktop: { label: "Desktop 1440×900", width: 1440, height: 900 },
  tablet: { label: "Tablet 768×1024", width: 768, height: 1024 },
  mobile: { label: "Mobile 375×812", width: 375, height: 812 },
};

export function newBrowserId(): string {
  return `bl_${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`}`;
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/[^.\s/$.?#].[^\s]*$/i.test(value.trim());
}

/** A Playwright snippet reproducing the recorded steps (for devs). */
export function playwrightSnippet(url: string, viewport: string, actions: BrowserAction[]): string {
  const vp = VIEWPORTS[viewport] ?? VIEWPORTS.desktop;
  const lines: string[] = [
    `import { chromium } from "playwright";`,
    ``,
    `const browser = await chromium.launch();`,
    `const page = await browser.newPage({ viewport: { width: ${vp.width}, height: ${vp.height} } });`,
    `await page.goto(${JSON.stringify(url)});`,
  ];
  for (const action of actions) {
    switch (action.kind) {
      case "click":
        lines.push(`await page.click(${JSON.stringify(action.detail ?? "text=Load more")});`);
        break;
      case "type":
        lines.push(`await page.fill(${JSON.stringify("input")}, ${JSON.stringify(action.detail ?? "")});`);
        break;
      case "screenshot":
        lines.push(`await page.screenshot({ path: ${JSON.stringify("screenshot.png")} });`);
        break;
      case "wait":
        lines.push(`await page.waitForTimeout(${action.detail ? Number(action.detail) || 500 : 500});`);
        break;
      case "goto":
        lines.push(`await page.goto(${JSON.stringify(action.detail ?? url)});`);
        break;
    }
  }
  lines.push(``, `await browser.close();`);
  return lines.join("\n");
}

/** Short human summary of a capture, for the run brief. */
export function captureSummary(capture: BrowserCapture): string {
  const errors = capture.console.filter((e) => e.type === "error").length;
  const failed = capture.network.filter((n) => n.failed).length;
  return `Browser capture of ${capture.finalUrl} ("${capture.title}") — ${capture.console.length} console entries (${errors} errors), ${capture.network.length} network requests (${failed} failed), DOM ${capture.dom.length} chars.`;
}

const HISTORY_KEY = "moagent.browserLab.sessions.v1";

export function loadSessions(): BrowserSession[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as BrowserSession[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: BrowserSession[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions.slice(0, 20)));
  } catch {
    /* storage denied */
  }
}
