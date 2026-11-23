import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const runtimeDir = path.join(root, "apps", "api", "functions");
const runtimeServer = path.join(here, "..", "src", "runtime", "server.ts");
const entryFile = path.join(runtimeDir, "__local_entry.ts");
const outFile = path.join(here, "..", "dist", "functions.mjs");

const skip = new Set(["schema.ts", "crons.ts", "http.ts", "runtime.config.ts", "cardTypes.ts"]);
const modules = fs
  .readdirSync(runtimeDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !skip.has(name))
  .map((name) => name.slice(0, -3))
  .sort();

const lines = modules.map((name, index) => `import * as m${index} from "./${name}";`);
lines.push(`export const modules = { ${modules.map((name, index) => `${JSON.stringify(name)}: m${index}`).join(", ")} };`);
fs.writeFileSync(entryFile, lines.join("\n"), "utf8");

try {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    sourcemap: true,
    logLevel: "info",
    plugins: [
      {
        name: "local-runtime-server",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /(^|\/)_generated\/server$/ }, () => ({
            path: runtimeServer,
          }));
          pluginBuild.onResolve({ filter: /^@\/api\// }, (args) => ({
            path: path.join(root, "apps", "api", args.path.slice(3)),
          }));
          pluginBuild.onResolve({ filter: /^@\// }, (args) => ({
            path: path.join(runtimeDir, args.path.slice(2)),
          }));
        },
      },
    ],
  });
  fs.writeFileSync(
    path.join(path.dirname(outFile), "functions.d.mts"),
    "export declare const modules: Record<string, unknown>;\n",
    "utf8"
  );
  console.log(`[local] bundled ${modules.length} function modules`);
} finally {
  fs.rmSync(entryFile, { force: true });
}
