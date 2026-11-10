import { wenv } from "@fhara/config/worker";
import {
  localBrowser,
  Stagehand,
  type BrowserContext,
  type StagehandBrowser,
} from "@browserbasehq/stagehand";
import { assertUrlAllowed } from "@/tools/urlGuard";

// The URL guard lives in `tools/urlGuard.ts` so tools that only validate a
// URL (the Agent Reach tool) do not pull the browser runtime in. Re-exported
// here for the existing importers.
export { assertUrlAllowed, extractDomain, isBlockedHost } from "@/tools/urlGuard";

type StagehandModelName = `openai/${string}` | `anthropic/${string}` | `google/${string}` | `groq/${string}` | `cerebras/${string}`;

export interface WebClientConfig {
  userAgent?: string;
  timeoutMs?: number;
  maxContentLength?: number;
  headless?: boolean;
  stagehandModelName?: StagehandModelName;
  stagehandApiKey?: string;
}

export interface PageResult {
  url: string;
  title: string;
  content: string;
  statusCode: number;
  headers: Record<string, string>;
  links: string[];
  images: string[];
}

export interface NavigateResult {
  success: boolean;
  url: string;
  title: string;
  error?: string;
}

export interface SearchResult {
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONTENT_LENGTH = 500_000;

/** Extract unique http(s) URLs from free text, trailing punctuation stripped. */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const urls = found.map((u) => u.replace(/[.,;:!?]+$/, ""));
  return [...new Set(urls)];
}

/**
 * Browser-backed WebClient built on Stagehand (`@browserbasehq/stagehand`).
 *
 * Stagehand wraps a real browser (Playwright/Chromium under the hood via
 * `localBrowser`) and exposes it through a browser-automation object model:
 * navigation, content extraction, screenshots, and agentic actions
 * (`act`/`observe`/`extract`) when a Stagehand runtime + model are configured.
 *
 * This client covers the LiveBrowserTool surface:
 * - navigate + extract text/links/images from JS-rendered pages
 * - web search
 * - screenshots
 */
export class WebClient {
  private browser?: StagehandBrowser;
  private stagehand?: Stagehand;
  private context?: BrowserContext;
  private closed = false;

  constructor(private readonly config: WebClientConfig = {}) {}

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const browser = await localBrowser.launch({
      headless: this.config.headless ?? true,
    });
    this.browser = browser;
    // Model + key come from the resolved LLM config threaded in by the
    // caller (agentExecutor/taskRunner via the Phase 2 resolver) — this
    // tool no longer reads LLM_* env vars, so provider rotation/disable in
    // Settings actually takes effect here. Stagehand-specific env vars
    // remain as operator overrides.
    const modelName: StagehandModelName =
      (this.config.stagehandModelName as StagehandModelName | undefined) ??
      (wenv("STAGEHAND_MODEL") as StagehandModelName); // default anthropic/claude-sonnet-4-20250514
    const apiKey = this.config.stagehandApiKey ?? wenv("STAGEHAND_API_KEY");
    const stagehand = await Stagehand.create({
      browser,
      ...(apiKey ? { model: { modelName, apiKey } } : {}),
    });
    this.stagehand = stagehand;
    this.context = stagehand.browser.context;
    return this.context;
  }

  private async ensureStagehand(): Promise<Stagehand> {
    await this.getContext();
    if (!this.stagehand) throw new Error("Stagehand browser is not initialized");
    return this.stagehand;
  }

  async act(instruction: string): Promise<unknown> {
    const stagehand = await this.ensureStagehand();
    return stagehand.act(instruction);
  }

  async observe(instruction?: string): Promise<unknown> {
    const stagehand = await this.ensureStagehand();
    return stagehand.observe(instruction);
  }

  async fetch(url: string): Promise<PageResult> {
    assertUrlAllowed(url);
    // Fresh page per fetch so concurrent fetches cannot share one URL.
    const page = await (await this.getContext()).newPage();
    try {
      const response = await page.goto(url, {
        waitUntil: "load",
        timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (!response) {
        throw new Error(`Stagehand navigation returned no response for ${url}`);
      }
      const title = await page.title();
      const content = await page.evaluate<string>(
        `document.body ? (document.body.innerText || document.body.textContent || "") : ""`
      );
      const links = await page.evaluate<string[]>(
        `Array.from(document.querySelectorAll("a[href]")).map((a) => a.href)`
      );
      const images = await page.evaluate<string[]>(
        `Array.from(document.querySelectorAll("img")).map((i) => i.src).filter((src) => Boolean(src))`
      );
      return {
        url: response.url() || url,
        title,
        content: content.slice(0, this.config.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH),
        statusCode: response.status(),
        headers: response.headers(),
        links,
        images,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async search(query: string, limit = 10): Promise<SearchResult["results"]> {
    const context = await this.getContext();
    const page = await context.newPage();
    try {
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
        waitUntil: "load",
        timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const results = await page.evaluate<SearchResult["results"]>(
        `Array.from(document.querySelectorAll("div.result")).map((r) => {
          const a = r.querySelector("a.result__a");
          const snippet = r.querySelector("a.result__snippet");
          return {
            title: a?.innerText?.trim() ?? "",
            url: a?.href ?? "",
            snippet: snippet?.innerText?.trim() ?? "",
          };
        }).filter((r) => r.url).slice(0, ${limit})`
      );
      return results;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async screenshot(url: string): Promise<Uint8Array> {
    assertUrlAllowed(url);
    const page = await (await this.getContext()).newPage();
    try {
      const response = await page.goto(url, {
        waitUntil: "load",
        timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (!response) {
        throw new Error(`Stagehand navigation returned no response for ${url}`);
      }
      return await page.screenshot({ timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stagehand = this.stagehand;
    const browser = this.browser;
    const context = this.context;
    this.stagehand = undefined;
    this.browser = undefined;
    this.context = undefined;
    try {
      await stagehand?.close();
    } catch {
      // ignore cleanup errors
    }
    try {
      await context?.close();
    } catch {
      // ignore cleanup errors
    }
    try {
      await browser?.close();
    } catch {
      // ignore cleanup errors
    }
  }
}

export default WebClient;
