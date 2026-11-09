/**
 * Bundle the MCP client core (`src/mcp/client.ts`) into a single file for
 * future shipping on user machines.
 *
 * Fhara currently has no MCP *server* of its own — it only spawns external
 * servers via `McpRegistry` — so there is nothing to ship yet. This script
 * proves the bundling pattern (esbuild, node runtime, single ESM file)
 * against the client core; point `entryPoints` at a real server entry when
 * one ships. do not add `electron-vite` for this: the Electron shell is a
 * 67-line launcher with no bundling need.
 */
import { build } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveTsFile(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return base;
}

const aliasPlugin = {
  name: "worker-aliases",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@\/api\// }, (args) => ({
      path: resolveTsFile(path.resolve(workerRoot, "../../apps/api", args.path.slice("@/api/".length))),
    }));
    buildApi.onResolve({ filter: /^@api\// }, (args) => ({
      path: resolveTsFile(path.resolve(workerRoot, "../../apps/api", args.path.slice("@api/".length))),
    }));
    buildApi.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveTsFile(path.resolve(workerRoot, "src", args.path.slice("@/".length))),
    }));
  },
};

await build({
  entryPoints: [path.join(workerRoot, "src/mcp/client.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(workerRoot, "dist/mcp-client.js"),
  target: "node18",
  logLevel: "info",
  plugins: [aliasPlugin],
});
