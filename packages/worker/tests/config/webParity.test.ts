import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { schemaDefault } from "@fhara/config";
import { serverEnv, serverEnvRaw } from "@fhara/config/web-server";
import { isAllowedHost } from "../../../../apps/web/lib/requestGuard";
import { resolveWorkspaceBase } from "../../../../apps/web/lib/projectFilesPolicy";
import { b2Bool } from "./legacyEnv";

/**
 * Parity (E3): each web / electron read through @fhara/config returns what
 * the inline expression it replaced returned, for the same env.
 */
type Env = Record<string, string | undefined>;
const ENVS: Env[] = [
  {},
  { CONVEX_SERVICE_TOKEN: "" },
  { CONVEX_SERVICE_TOKEN: " tok " },
  { CONVEX_SITE_URL: "" },
  { CONVEX_SITE_URL: "https://x.convex.site/" },
  { FHARA_ALLOW_LOCAL_MCP: "1" },
  { FHARA_ALLOW_LOCAL_MCP: "true" },
  { FHARA_ALLOW_LOCAL_MCP: " 1" },
  { FHARA_ALLOW_LOCAL_MCP: "0" },
  { FHARA_HOST: "" },
  { FHARA_HOST: "  " },
  { FHARA_HOST: " 0.0.0.0 " },
  { DEV_SERVER_URL: "" },
  { DEV_SERVER_URL: " http://h:1 " },
  { WORKSPACE_ROOT: "" },
  { WORKSPACE_ROOT: "  /abs/ws " },
  { WORKSPACE_ROOT: "rel" },
  { CONVEX_URL: "http://legacy" },
];

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const manifest = createRequire(import.meta.url)(path.join(ROOT, "packages/config/env-manifest.json")) as {
  vars: Array<{ name: string; default: string | null }>;
};
const manifestDefault = (name: string) => manifest.vars.find((v) => v.name === name)?.default ?? undefined;

describe("web server reads (E3 parity)", () => {
  for (const env of ENVS) {
    const label = JSON.stringify(env);
    it(`route handler reads ${label}`, () => {
      expect(serverEnv("CONVEX_SERVICE_TOKEN", env)).toBe(env.CONVEX_SERVICE_TOKEN);
      // callback/route.ts: `if (process.env.CONVEX_SITE_URL) return …`
      expect(Boolean(serverEnv("CONVEX_SITE_URL", env))).toBe(Boolean(env.CONVEX_SITE_URL));
      expect(serverEnv("CONVEX_SITE_URL", env)).toBe(env.CONVEX_SITE_URL);
      // B2: the unified bool dialect (was === "1").
      expect(serverEnv("FHARA_ALLOW_LOCAL_MCP", env)).toBe(b2Bool(env.FHARA_ALLOW_LOCAL_MCP, false));
      // NEXT_PUBLIC_CONVEX_URL on the web side never falls back to CONVEX_URL.
      expect(serverEnvRaw("NEXT_PUBLIC_CONVEX_URL", env, { aliases: false })).toBe(env.NEXT_PUBLIC_CONVEX_URL);
    });

    it(`plain-node launchers ${label}`, () => {
      expect((env.FHARA_HOST ?? "").trim() || manifestDefault("FHARA_HOST")).toBe((env.FHARA_HOST ?? "").trim() || "127.0.0.1");
      expect(env.DEV_SERVER_URL || manifestDefault("DEV_SERVER_URL")).toBe(env.DEV_SERVER_URL || "http://localhost:3000");
    });

    it(`pure web libs agree with the schema ${label}`, () => {
      const root = serverEnv("WORKSPACE_ROOT", env);
      expect(resolveWorkspaceBase("p1", env, "/w")).toBe(path.resolve("/w", root, "p1"));
    });
  }

  it("FHARA_ALLOWED_HOSTS: requestGuard's csv split matches the schema value", () => {
    const env = { FHARA_ALLOWED_HOSTS: " Box.ts.net , 100.64.0.1:3000 ," };
    const hosts = String(serverEnv("FHARA_ALLOWED_HOSTS", env)).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    expect(hosts).toEqual(["box.ts.net", "100.64.0.1:3000"]);
    for (const h of hosts) expect(isAllowedHost(h, env)).toBe(true);
    expect(isAllowedHost("evil.example", env)).toBe(false);
    expect(schemaDefault("FHARA_ALLOWED_HOSTS")).toBe("");
  });

  it("manifest defaults equal the schema defaults", () => {
    expect(manifestDefault("FHARA_HOST")).toBe(schemaDefault("FHARA_HOST"));
    expect(manifestDefault("DEV_SERVER_URL")).toBe(schemaDefault("DEV_SERVER_URL"));
    expect(manifestDefault("WORKSPACE_ROOT")).toBe("./workspaces");
  });
});
