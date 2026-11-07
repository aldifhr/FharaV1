import { defineConfig } from "vitest/config";

// Backend (Convex) tests run under convex-test, which executes function
// code in an edge-runtime VM — hence the environment. Kept separate from
// the worker suite (packages/worker), which has its own vitest setup.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
  },
});
