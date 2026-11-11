import path from "node:path";
import { defineConfig } from "vitest/config";

const root = path.resolve(import.meta.dirname);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/api\//, replacement: path.resolve(root, "../../apps/api") + "/" },
      { find: /^@api\//, replacement: path.resolve(root, "../../apps/api") + "/" },
      { find: /^@\//, replacement: path.resolve(root, "./src") + "/" },
      { find: /^@$/, replacement: path.resolve(root, "./src") },
    ],
  },
  test: {
    globals: true,
    // D6: the command sandbox is off in tests unless a test sets SANDBOX_MODE
    // (tests/osSandbox*.test.ts); a host without bwrap would refuse every spawn.
    setupFiles: ["./tests/setup/sandboxOff.ts"],
  },
});
