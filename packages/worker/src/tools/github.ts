/**
 * GitHub MCP Client
 *
 * Connects to the official GitHub MCP server (github-mcp-server) via stdio
 * and provides typed wrappers for common GitHub operations.
 *
 * Usage:
 *   const github = await GitHubMcpClient.create({ token: "ghp_..." });
 *   const repos = await github.listRepos();
 *   const pr = await github.createPR({ owner, repo, title, head, base, body });
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface GitHubConfig {
  token: string;
  owner?: string;
  repo?: string;
}

export interface Repository {
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  html_url: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
}

export interface PullRequestReview {
  body?: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
}

export interface CodeSearchResult {
  total_count: number;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    html_url: string;
    repository: { full_name: string };
  }>;
}

export class GitHubMcpError extends Error {
  constructor(
    message: string,
    public code?: string,
    public data?: unknown
  ) {
    super(message);
    this.name = "GitHubMcpError";
  }
}

/**
 * GitHub MCP Client using the official github-mcp-server
 */
export class GitHubMcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private isReady = false;
  private readyPromise: Promise<void>;
  private config: GitHubConfig;

  private constructor(config: GitHubConfig) {
    super();
    this.config = config;
    this.readyPromise = this.initialize();
  }

  static async create(config: GitHubConfig): Promise<GitHubMcpClient> {
    const client = new GitHubMcpClient(config);
    await client.readyPromise;
    return client;
  }

  private async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Spawn the github-mcp-server
        // The server is installed via: npx @modelcontextprotocol/server-github
        this.process = spawn("npx", ["-y", "@modelcontextprotocol/server-github"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            GITHUB_TOKEN: this.config.token,
          },
        });

        let stdout = "";
        let stderr = "";

        this.process.stdout?.on("data", (data: Buffer) => {
          const text = data.toString();
          stdout += text;
          this.handleMessage(text);
        });

        this.process.stderr?.on("data", (data: Buffer) => {
          const text = data.toString();
          stderr += text;
          // MCP servers sometimes output debug info to stderr
          console.error("[github-mcp-server]", text.trim());
        });

        this.process.on("error", (error) => {
          this.emit("error", error);
          reject(error);
        });

        this.process.on("exit", (code, signal) => {
          if (code !== 0 && code !== null) {
            this.emit(
              "error",
              new Error(`github-mcp-server exited with code ${code}: ${stderr}`)
            );
          }
          this.emit("close", code, signal);
        });

        // Wait for ready notification (JSON-RPC result with null result + no id = notification)
        const timeout = setTimeout(() => {
          reject(new Error("GitHub MCP server initialization timeout"));
        }, 30000);

        this.once("ready", () => {
          clearTimeout(timeout);
          this.isReady = true;
          resolve();
        });

        // Fallback: assume ready after a short delay
        setTimeout(() => {
          if (!this.isReady) {
            this.isReady = true;
            resolve();
          }
        }, 5000);
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleMessage(data: string): void {
    const lines = data.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        this.processMessage(message);
      } catch {
        // Not JSON, might be debug output
      }
    }
  }

  private processMessage(message: {
    jsonrpc?: string;
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  }): void {
    // Handle notifications (no id)
    if (!message.id) {
      if (message.method === "notifications/initialized") {
        this.emit("ready");
      }
      return;
    }

    const id = String(message.id);
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    if (message.error) {
      pending.reject(
        new GitHubMcpError(
          message.error.message,
          String(message.error.code),
          message.error.data
        )
      );
    } else {
      pending.resolve(message.result);
    }
    this.pendingRequests.delete(id);
  }

  private async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (!this.process || this.process.killed) {
      throw new Error("GitHub MCP server not running");
    }

    const id = String(this.nextId++);
    const request = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const message = JSON.stringify(request) + "\n";
      const written = this.process!.stdin?.write(message);
      if (!written) {
        this.pendingRequests.delete(id);
        reject(new Error("Failed to write to MCP server stdin"));
        return;
      }

      // Timeout for this request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 60000);
    });
  }

  async listRepos(): Promise<Repository[]> {
    const result = (await this.request("github_repos_list")) as {
      repositories?: Repository[];
    };
    return result?.repositories ?? [];
  }

  async getRepo(owner: string, repo: string): Promise<Repository> {
    return (await this.request("github_repo_get", { owner, repo })) as Repository;
  }

  async listIssues(owner: string, repo: string, options?: { state?: "open" | "closed" | "all" }): Promise<Issue[]> {
    const result = (await this.request("github_issues_list", {
      owner,
      repo,
      ...options,
    })) as { issues?: Issue[] };
    return result?.issues ?? [];
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body?: string,
    labels?: string[]
  ): Promise<Issue> {
    return (await this.request("github_issues_create", {
      owner,
      repo,
      title,
      body,
      labels,
    })) as Issue;
  }

  async listPRs(
    owner: string,
    repo: string,
    options?: { state?: "open" | "closed" | "all" }
  ): Promise<PullRequest[]> {
    const result = (await this.request("github_pulls_list", {
      owner,
      repo,
      ...options,
    })) as { pull_requests?: PullRequest[] };
    return result?.pull_requests ?? [];
  }

  async getPR(owner: string, repo: string, pullNumber: number): Promise<PullRequest> {
    return (await this.request("github_pulls_get", {
      owner,
      repo,
      pull_number: pullNumber,
    })) as PullRequest;
  }

  async createPR(options: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    head: string;
    base: string;
  }): Promise<PullRequest> {
    return (await this.request("github_pulls_create", options)) as PullRequest;
  }

  async reviewPR(
    owner: string,
    repo: string,
    pullNumber: number,
    review: PullRequestReview
  ): Promise<void> {
    await this.request("github_pulls_review", {
      owner,
      repo,
      pull_number: pullNumber,
      body: review.body,
      event: review.event,
    });
  }

  async searchCode(query: string, options?: { owner?: string; repo?: string }): Promise<CodeSearchResult> {
    return (await this.request("github_code_search", { query, ...options })) as CodeSearchResult;
  }

  async getFile(owner: string, repo: string, path: string, ref?: string): Promise<{ content: string; sha: string }> {
    return (await this.request("github_file_get", { owner, repo, path, ref })) as { content: string; sha: string };
  }

  async createFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch?: string
  ): Promise<{ commit: { sha: string } }> {
    return (await this.request("github_file_create", {
      owner,
      repo,
      path,
      content,
      message,
      branch,
    })) as { commit: { sha: string } };
  }

  async updateFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    sha: string,
    branch?: string
  ): Promise<{ commit: { sha: string } }> {
    return (await this.request("github_file_update", {
      owner,
      repo,
      path,
      content,
      message,
      sha,
      branch,
    })) as { commit: { sha: string } };
  }

  async close(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.stdin?.end();
      this.process.kill();
    }
    this.process = null;
    this.isReady = false;
  }
}

/**
 * Factory function to create a GitHub MCP client from Convex integration config
 */
export async function createGitHubMcpClient(
  config: GitHubConfig
): Promise<GitHubMcpClient> {
  return GitHubMcpClient.create(config);
}

// Re-export for convenience
export { GitHubMcpClient as default };
