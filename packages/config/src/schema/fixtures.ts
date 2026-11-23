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
    runtimes: ["runtime", "scripts"],
    group: "scripts",
    doc: "1 allows fixtures:seed / fixtures:wipe on a non-local FharaRuntime deployment (dev only; local and self-hosted need no flag).",
  },
  {
    name: "FHARA_DEPLOYMENT",
    type: "string",
    parse: "nullish",
    runtimes: ["scripts"],
    group: "scripts",
    doc: "FharaRuntime CLI deployment selector (\"local:…\", \"anonymous:…\", \"dev:…\"); fixtures:seed refuses a cloud one without FHARA_FIXTURES=1.",
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
