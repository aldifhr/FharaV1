#!/usr/bin/env node
// Run `next dev` / `next start` bound to 127.0.0.1 unless FHARA_HOST says
// otherwise (release audit P0-4: Next listens on every interface by
// default, which puts the unauthenticated /api routes on the LAN).
//
//   FHARA_HOST=0.0.0.0 npm run dev   # deliberately expose (also set FHARA_ALLOWED_HOSTS)
//   FHARA_BIND_TAILSCALE=1 npm run dev   # also listen on this machine's Tailscale
//                                         # address (phone over the tailnet; no login)
//
// FHARA_HOST is read from the environment or the repo-root .env, the same
// file next.config.mjs loads.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import nextEnv from "@next/env";
import { detectTailscaleDnsName, detectTailscaleIPv4, nextPort, wantsTailscale, withAllowedHosts } from "./tailnet.mjs";

const [mode, ...rest] = process.argv.slice(2);
if (mode !== "dev" && mode !== "start") {
  console.error("usage: node scripts/next.mjs <dev|start> [next args]");
  process.exit(2);
}

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webDir, "../..");
nextEnv.loadEnvConfig(repoRoot, mode === "dev");

const hasHostFlag = rest.some((arg) => arg === "-H" || arg === "--hostname" || arg.startsWith("--hostname="));
const require = createRequire(import.meta.url);
// The default comes from @fhara/config's generated manifest (plain node
// cannot import the TypeScript package).
const ENV_MANIFEST = require("../../../packages/config/env-manifest.json");
const envDefault = (name) => ENV_MANIFEST.vars.find((v) => v.name === name)?.default ?? undefined;
const host = (process.env.FHARA_HOST ?? "").trim() || envDefault("FHARA_HOST");
const args = [mode, ...(hasHostFlag ? [] : ["-H", host]), ...rest];

// O6: Next listens on 127.0.0.1 as before; a plain TCP relay listens on the
// Tailscale address only. Never 0.0.0.0: without a Tailscale address the
// server refuses to start instead of widening the bind.
let tailnet = null;
if (wantsTailscale(process.env)) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`[fhara] FHARA_BIND_TAILSCALE needs Next on 127.0.0.1 (FHARA_HOST is ${host}). Unset FHARA_HOST.`);
    process.exit(2);
  }
  const ip = detectTailscaleIPv4();
  if (!ip) {
    console.error("[fhara] FHARA_BIND_TAILSCALE is on but no Tailscale address was found. Start Tailscale (tailscale up) or unset FHARA_BIND_TAILSCALE.");
    process.exit(2);
  }
  const port = nextPort(rest, process.env);
  const dns = detectTailscaleDnsName();
  process.env.FHARA_ALLOWED_HOSTS = withAllowedHosts(process.env.FHARA_ALLOWED_HOSTS, [ip, `${ip}:${port}`, ...(dns ? [dns, `${dns}:${port}`] : [])]);
  tailnet = { ip, port, dns };
}

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, ...args], { cwd: webDir, stdio: "inherit", env: process.env });

if (tailnet) {
  const relay = net.createServer((socket) => {
    const upstream = net.connect(tailnet.port, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", close);
    upstream.on("error", close);
  });
  relay.on("error", (err) => console.error(`[fhara] Tailscale listener failed: ${err.message}`));
  relay.listen(tailnet.port, tailnet.ip, () => {
    console.log(`[fhara] Also on your tailnet: http://${tailnet.dns ?? tailnet.ip}:${tailnet.port} (no login; only devices on your tailnet can reach it)`);
  });
  child.on("exit", () => relay.close());
}
const forward = (signal) => () => child.kill(signal);
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
