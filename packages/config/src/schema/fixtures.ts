import type { EnvVar } from "./types";

/**
 * Mock fixtures and the mock LLM (docs/mock-fixtures.md). Dev-only: nothing
 * here is read on a production path. Kept in its own file so other lanes'
 * schema edits do not collide with it.
 */
export const FIXTURE_VARS = [
  {
    name: "FHARA_FIXTURES",
    type: "bool",
    parse: "bool",
    default: false,
    runtimes: ["convex", "scripts"],
    group: "scripts",
    doc: "1 allows fixtures:seed / fixtures:wipe on a non-local Convex deployment (dev only; local and self-hosted need no flag).",
  },
  {
    name: "CONVEX_CLOUD_URL",
    type: "url",
    parse: "nullish",
    runtimes: ["convex"],
    group: "core",
    doc: "The deployment's own URL; a Convex system var. The fixtures guard reads it to tell a local/self-hosted backend from Convex cloud.",
    convexSystem: true,
  },
  {
    name: "CONVEX_SELF_HOSTED_URL",
    type: "url",
    parse: "nullish",
    runtimes: ["scripts"],
    group: "scripts",
    doc: "Self-hosted Convex backend URL used by the Convex CLI (fixtures:seed targets it when set).",
  },
  {
    name: "CONVEX_DEPLOYMENT",
    type: "string",
    parse: "nullish",
    runtimes: ["scripts"],
    group: "scripts",
    doc: "Convex CLI deployment selector (\"local:…\", \"anonymous:…\", \"dev:…\"); fixtures:seed refuses a cloud one without FHARA_FIXTURES=1.",
  },
  {
    name: "MOCK_LLM_PORT",
    type: "int",
    parse: "atLeast",
    min: 0,
    floor: true,
    default: 3399,
    runtimes: ["scripts"],
    group: "scripts",
    doc: "Port of npm run mock:llm (0 = any free port).",
  },
  {
    name: "MOCK_LLM_SPEED",
    type: "int",
    parse: "atLeast",
    min: 0,
    default: 1,
    runtimes: ["scripts"],
    group: "scripts",
    doc: "Replay speed of the mock LLM stream: 1 = 30 Hz chunks, 10 = ten times faster, 0 = no delay.",
  },
  {
    name: "MOCK_LLM_SCRIPT",
    type: "string",
    parse: "nullish",
    runtimes: ["scripts"],
    group: "scripts",
    doc: "Path of the mock LLM script (JSON rules); default scripts/mock-llm/scripts/default.json.",
  },
] as const satisfies readonly EnvVar[];
