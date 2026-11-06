import { WebClient, type PageResult, type NavigateResult, type SearchResult } from "./webClient";

export type { PageResult, NavigateResult, SearchResult };

export interface BrowserConfig {
  userAgent?: string;
  timeoutMs?: number;
  maxContentLength?: number;
  headless?: boolean;
}

/**
 * Live Browser Tool - Allows agents to browse websites in real-time
 * 
 * This tool provides web browsing capabilities for AI agents to:
 * - Navigate to URLs and extract page content
 * - Search the web for information
 * - Analyze page structure (links, images)
 * - Handle JavaScript-rendered pages (via screenshots)
 */
export class LiveBrowserTool {
  private client: WebClient;
  private currentUrl: string = "";
  private sessionHistory: string[] = [];

  constructor(config: BrowserConfig = {}) {
    this.client = new WebClient({
      userAgent: config.userAgent ?? "Mozilla/5.0 (compatible; MOAgent/1.0)",
      timeoutMs: config.timeoutMs ?? 30000,
      maxContentLength: config.maxContentLength ?? 500_000,
      headless: config.headless ?? true,
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Navigate to a URL and get page content
   */
  async navigate(url: string): Promise<NavigateResult> {
    try {
      const normalizedUrl = this.normalizeUrl(url);
      const result = await this.client.fetch(normalizedUrl);
      
      this.currentUrl = result.url;
      this.sessionHistory.push(result.url);

      return {
        success: true,
        url: result.url,
        title: result.title,
      };
    } catch (error) {
      return {
        success: false,
        url,
        title: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get content from current page or specific URL
   */
  async getContent(url?: string): Promise<PageResult | null> {
    try {
      const targetUrl = url ?? this.currentUrl;
      if (!targetUrl) {
        throw new Error("No URL specified and no current page in session");
      }
      return await this.client.fetch(targetUrl);
    } catch {
      return null;
    }
  }

  /**
   * Search the web using DuckDuckGo (no API key required)
   */
  async search(query: string, limit = 10): Promise<SearchResult> {
    try {
      const results = await this.client.search(query, limit);
      return {
        query,
        results,
      };
    } catch (error) {
      return {
        query,
        results: [],
      };
    }
  }

  /**
   * Extract all links from a page
   */
  async getLinks(url?: string): Promise<string[]> {
    const content = await this.getContent(url);
    return content?.links ?? [];
  }

  /**
   * Extract all image URLs from a page
   */
  async getImages(url?: string): Promise<string[]> {
    const content = await this.getContent(url);
    return content?.images ?? [];
  }

  /**
   * Take a screenshot of a page (Stagehand-backed browser screenshot)
   */
  async takeScreenshot(url?: string): Promise<{ screenshot: string; error?: string }> {
    try {
      const target = url ?? this.currentUrl;
      if (!target) {
        return { screenshot: "", error: "No URL specified and no current page in session" };
      }
      const buffer = await this.client.screenshot(target);
      const screenshot = `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
      return { screenshot };
    } catch (error) {
      return {
        screenshot: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Ask the Stagehand agentic layer to perform an action on the current page
   * (self-healing browser actions driven by an LLM).
   */
  async act(instruction: string): Promise<unknown> {
    return await this.client.act(instruction);
  }

  /**
   * Ask the Stagehand agentic layer to observe the current page (accessibility
   * snapshot / context) without acting.
   */
  async observe(instruction?: string): Promise<unknown> {
    return await this.client.observe(instruction);
  }

  /**
   * Get the current URL in the session
   */
  getCurrentUrl(): string {
    return this.currentUrl;
  }

  /**
   * Get browsing history for this session
   */
  getHistory(): string[] {
    return [...this.sessionHistory];
  }

  /**
   * Go back in history (if supported)
   */
  async back(): Promise<NavigateResult> {
    if (this.sessionHistory.length < 2) {
      return {
        success: false,
        url: this.currentUrl,
        title: "",
        error: "No history to go back to",
      };
    }
    // Pop current URL
    this.sessionHistory.pop();
    const previousUrl = this.sessionHistory[this.sessionHistory.length - 1];
    if (previousUrl) {
      return await this.navigate(previousUrl);
    }
    return {
      success: false,
      url: this.currentUrl,
      title: "",
      error: "No previous URL in history",
    };
  }

  /**
   * Form submission helper
   */
  async submitForm(url: string, _data: Record<string, string>): Promise<PageResult | null> {
    // For simple form submissions, use URL-encoded data
    const params = new URLSearchParams(_data);
    const formUrl = `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
    return await this.getContent(formUrl);
  }

  private normalizeUrl(url: string): string {
    url = url.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    return url;
  }
}

export default LiveBrowserTool;
