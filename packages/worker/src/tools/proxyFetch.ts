/**
 * fetch that honors HTTPS_PROXY / HTTP_PROXY / NO_PROXY.
 *
 * Node's built-in fetch ignores the proxy env vars (unless the process was
 * started with NODE_USE_ENV_PROXY=1), so behind a corporate or sandbox
 * proxy the worker's GitHub API calls (opening the PR) failed while the
 * `git push` next to them, which does read HTTPS_PROXY, worked. When a
 * proxy var is set we route through undici's EnvHttpProxyAgent, which
 * applies NO_PROXY per request; with no proxy var set the plain global fetch
 * is used and undici is never loaded.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type Env = Record<string, string | undefined>;

export interface ProxyEnv {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

function pick(env: Env, name: string): string | undefined {
  // Lower case wins, matching curl, git and undici.
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The proxy settings in `env`, or null when no proxy is configured. */
export function proxyEnv(env: Env = process.env): ProxyEnv | null {
  const httpProxy = pick(env, "HTTP_PROXY");
  const httpsProxy = pick(env, "HTTPS_PROXY");
  if (!httpProxy && !httpsProxy) return null;
  return { httpProxy, httpsProxy, noProxy: pick(env, "NO_PROXY") };
}

let cached: { key: string; fetch: FetchLike } | null = null;

/**
 * A fetch for outbound API calls: global fetch when no proxy is set,
 * otherwise undici's fetch through an EnvHttpProxyAgent built from `env`.
 * The agent is reused while the proxy settings stay the same.
 */
export async function proxyAwareFetch(env: Env = process.env): Promise<FetchLike> {
  const settings = proxyEnv(env);
  if (!settings) return fetch as FetchLike;
  const key = JSON.stringify(settings);
  if (cached?.key === key) return cached.fetch;
  const undici = await import("undici");
  const dispatcher = new undici.EnvHttpProxyAgent({
    // Explicit values (empty string = unset) so undici never falls back to
    // a process.env that differs from the `env` we were given.
    httpProxy: settings.httpProxy ?? "",
    httpsProxy: settings.httpsProxy ?? "", // unset: undici reuses the HTTP proxy
    noProxy: settings.noProxy ?? "",
  });
  const proxied: FetchLike = async (url, init) =>
    (await undici.fetch(url, {
      ...(init as Record<string, unknown>),
      dispatcher,
    } as Parameters<typeof undici.fetch>[1])) as unknown as Response;
  cached = { key, fetch: proxied };
  return proxied;
}
