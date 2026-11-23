import { defineConfig } from "vitest/config";

// Backend (FharaRuntime) tests run under local-test, which executes function
// code in an edge-runtime VM — hence the environment. Kept separate from
// the worker suite (packages/worker), which has its own vitest setup.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["functions/**/*.test.ts"],
  },
});
