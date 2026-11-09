#!/usr/bin/env node
// Generate apps/api/convex/_generated/* WITHOUT a Convex deployment or deploy key.
//
// Why: `_generated/` is gitignored, and `convex codegen` normally needs a
// deployment (cloud or local backend) because component-aware codegen pushes
// the app to evaluate `convex.config.ts`. CI has no deployment and no secrets.
//
// How:
//   1. Run the Convex CLI's own non-component ("legacy") codegen path, which is
//      purely local: `convex codegen --system-udfs --typecheck disable`. It
//      writes api.{js,d.ts}, server.{js,d.ts} and dataModel.d.ts from the
//      source tree and schema.ts using the CLI's real templates.
//   2. That path does not know about components, so we add the `components`
//      export ourselves, reading `app.use(...)` calls from convex.config.ts.
//      Each installed component package ships its typed
//      `<pkg>/_generated/component.js` ComponentApi, which is exactly what
//      component-aware codegen references.
//
// Usage: node scripts/convex-codegen-offline.mjs
//
// Known difference vs. deployment codegen: `env` from _generated/server is
// typed Record<string, string | undefined> instead of the typed Env object.
// Nothing in apps/api imports it today.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(repoRoot, "apps/api");
const convexDir = join(apiDir, "convex");
const genDir = join(convexDir, "_generated");

const require = createRequire(join(apiDir, "package.json"));
const convexPkgJson = require.resolve("convex/package.json");
const convexCli = join(dirname(convexPkgJson), "bin/main.js");

// Never let a developer's deployment env leak in: this must be offline.
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (k.startsWith("CONVEX_")) delete env[k];
}
// Keep the CLI's temp dir on the same filesystem as the project (gitignored).
env.CONVEX_TMPDIR = join(apiDir, ".convex", "codegen-tmp");
mkdirSync(env.CONVEX_TMPDIR, { recursive: true });

const res = spawnSync(
  process.execPath,
  [convexCli, "codegen", "--system-udfs", "--typecheck", "disable"],
  { cwd: apiDir, env, stdio: "inherit" },
);
if (res.status !== 0) {
  console.error(`[convex-codegen-offline] convex codegen exited with ${res.status}`);
  process.exit(res.status ?? 1);
}

for (const f of ["api.js", "api.d.ts", "server.js", "server.d.ts", "dataModel.d.ts"]) {
  if (!existsSync(join(genDir, f))) {
    console.error(`[convex-codegen-offline] missing ${f} after codegen`);
    process.exit(1);
  }
}

// --- components -----------------------------------------------------------
const configPath = join(convexDir, "convex.config.ts");
const components = [];
if (existsSync(configPath)) {
  const src = readFileSync(configPath, "utf8");
  const imports = new Map();
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+)\/convex\.config(?:\.js)?["']/g)) {
    imports.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/\.use\(\s*(\w+)\s*(?:,\s*\{([^}]*)\})?\s*\)/g)) {
    const pkg = imports.get(m[1]);
    if (!pkg) {
      console.error(`[convex-codegen-offline] cannot resolve component '${m[1]}' in convex.config.ts`);
      process.exit(1);
    }
    const nameMatch = m[2]?.match(/name\s*:\s*["']([^"']+)["']/);
    let name = nameMatch?.[1];
    if (!name) {
      // Default component name comes from the package's defineComponent("<name>").
      const cfgFile = require.resolve(`${pkg}/convex.config`);
      const cfgSrc = readFileSync(cfgFile, "utf8");
      name = cfgSrc.match(/defineComponent\(\s*["']([^"']+)["']/)?.[1];
      if (!name) {
        console.error(`[convex-codegen-offline] cannot find defineComponent name in ${cfgFile}`);
        process.exit(1);
      }
    }
    components.push({ name, pkg });
  }
}

const apiDts = join(genDir, "api.d.ts");
const apiJs = join(genDir, "api.js");
let dts = readFileSync(apiDts, "utf8");
let js = readFileSync(apiJs, "utf8");

const decl =
  "\nexport declare const components: {\n" +
  components
    .map((c) => `  ${/^[A-Za-z_$][\w$]*$/.test(c.name) ? c.name : JSON.stringify(c.name)}: import("${c.pkg}/_generated/component.js").ComponentApi<${JSON.stringify(c.name)}>;\n`)
    .join("") +
  "};\n";
if (!/export declare const components/.test(dts)) dts = dts.trimEnd() + "\n" + decl;

if (!/export const components/.test(js)) {
  js = js.replace(/import \{ anyApi \} from "convex\/server";/, 'import { anyApi, componentsGeneric } from "convex/server";');
  if (!/componentsGeneric/.test(js)) {
    console.error("[convex-codegen-offline] unexpected api.js shape; cannot add components export");
    process.exit(1);
  }
  js = js.trimEnd() + "\nexport const components = componentsGeneric();\n";
}

writeFileSync(apiDts, dts);
writeFileSync(apiJs, js);
console.log(
  `[convex-codegen-offline] generated ${genDir} (components: ${components.map((c) => c.name).join(", ") || "none"})`,
);
