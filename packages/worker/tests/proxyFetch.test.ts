import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { proxyAwareFetch, proxyEnv } from "@/tools/proxyFetch";
import { openPullRequest } from "@/tools/githubPr";

describe("proxyEnv", () => {
  it("is null without a proxy and reads both cases, lower case first", () => {
    expect(proxyEnv({})).toBeNull();
    expect(proxyEnv({ NO_PROXY: "x" })).toBeNull();
    expect(proxyEnv({ HTTPS_PROXY: " http://p:1 ", NO_PROXY: "a.com" })).toEqual({
      httpProxy: undefined,
      httpsProxy: "http://p:1",
      noProxy: "a.com",
    });
    expect(proxyEnv({ https_proxy: "http://lower:1", HTTPS_PROXY: "http://upper:1" })?.httpsProxy).toBe("http://lower:1");
  });

  it("uses the plain global fetch when no proxy is set", async () => {
    expect(await proxyAwareFetch({})).toBe(fetch);
  });
});

/** Minimal forward proxy: absolute-form http requests and CONNECT tunnels. */
function createProxy(log: string[]): http.Server {
  const proxy = http.createServer((req, res) => {
    log.push(req.url ?? "");
    const url = new URL(req.url ?? "");
    const upstream = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    req.pipe(upstream);
  });
  // CONNECT tunnels: what undici's ProxyAgent uses (always for https).
  proxy.on("connect", (req, client, head) => {
    log.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return proxy;
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// Generous timeouts: the first undici import is slow on a loaded CI box.
describe("proxyAwareFetch routes through the proxy and honors NO_PROXY", { timeout: 30_000 }, () => {
  let target: http.Server;
  let targetUrl: string;
  const servers: http.Server[] = [];

  beforeAll(async () => {
    target = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    });
    targetUrl = await listen(target);
    // Warm the lazy undici import outside the timed tests.
    await proxyAwareFetch({ HTTP_PROXY: "http://127.0.0.1:9" });
  }, 30_000);

  afterAll(async () => {
    await Promise.all([target, ...servers].map(close));
  }, 30_000);

  it("sends requests through HTTP(S)_PROXY", async () => {
    const log: string[] = [];
    const proxy = createProxy(log);
    servers.push(proxy);
    const proxyUrl = await listen(proxy);
    const f = await proxyAwareFetch({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl });
    expect(f).not.toBe(fetch);
    const res = await f(`${targetUrl}/repos/o/r/pulls`);
    expect((await res.json()).path).toBe("/repos/o/r/pulls");
    // Forwarded (absolute-form) or tunneled (CONNECT), it went via the proxy.
    expect(log).toHaveLength(1);
    expect([`${targetUrl}/repos/o/r/pulls`, `CONNECT ${targetUrl.replace("http://", "")}`]).toContain(log[0]);
  });

  it("bypasses the proxy for NO_PROXY hosts", async () => {
    const log: string[] = [];
    const proxy = createProxy(log);
    servers.push(proxy);
    const proxyUrl = await listen(proxy);
    const f = await proxyAwareFetch({ HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" });
    const res = await f(`${targetUrl}/direct`);
    expect((await res.json()).path).toBe("/direct");
    expect(log).toEqual([]);
  });

  it("openPullRequest keeps working with an injected fetch (tests, mocks)", async () => {
    const calls: string[] = [];
    const pr = await openPullRequest({
      owner: "o",
      repo: "r",
      token: "t",
      head: "fhara/k/x",
      base: "main",
      title: "T",
      body: "B",
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ number: 7, html_url: "https://gh/pr/7", title: "T", state: "open", draft: true }), {
          status: 201,
        });
      },
    });
    expect(pr).toEqual({ number: 7, url: "https://gh/pr/7", title: "T", state: "draft" });
    expect(calls).toEqual(["https://api.github.com/repos/o/r/pulls"]);
  });
});
