import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveOrder,
  formForPreset,
  hostOf,
  moveItem,
  providerFormError,
  providerPayload,
  sameOrder,
} from "../../lib/llmModelList.ts";

const anthropic = {
  id: "anthropic",
  label: "Anthropic",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  needsKey: true,
};
const ollama = {
  id: "ollama",
  label: "Ollama (local)",
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  apiKeyEnv: "OLLAMA_API_KEY",
  needsKey: false,
};

test("moveItem moves up and down and ignores the edges", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 1, 1), ["a", "c", "b"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 1), ["a", "b", "c"]);
});

test("effectiveOrder keeps a pending order only while it matches the server rows", () => {
  assert.deepEqual(effectiveOrder(["a", "b"], null), ["a", "b"]);
  assert.deepEqual(effectiveOrder(["a", "b"], ["b", "a"]), ["b", "a"]);
  // A model was added or removed meanwhile: the server order wins.
  assert.deepEqual(effectiveOrder(["a", "b", "c"], ["b", "a"]), ["a", "b", "c"]);
  assert.equal(sameOrder(["a", "b"], ["a", "b"]), true);
  assert.equal(sameOrder(["a", "b"], ["b", "a"]), false);
});

test("a preset fills everything but the key", () => {
  const form = formForPreset(anthropic);
  assert.equal(form.name, "Anthropic");
  assert.equal(form.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(form.provider, "anthropic");
  assert.equal(form.apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.equal(form.apiKey, "");
  assert.equal(formForPreset(ollama, { apiKey: "kept" }).apiKey, "kept");
});

test("form validation: key needed for vendors, optional for local servers and edits", () => {
  assert.equal(providerFormError(formForPreset(anthropic), anthropic, false), "Paste the API key.");
  assert.equal(providerFormError({ ...formForPreset(anthropic), apiKey: "sk" }, anthropic, false), null);
  assert.equal(providerFormError(formForPreset(ollama), ollama, false), null);
  assert.equal(providerFormError(formForPreset(anthropic), anthropic, true), null);
  assert.match(providerFormError({ ...formForPreset(ollama), baseUrl: "" }, ollama, false), /base URL/);
  assert.match(providerFormError({ ...formForPreset(ollama), name: " " }, ollama, false), /name/);
});

test("payload: key only when typed, patterns split, preset id kept", () => {
  const payload = providerPayload({ ...formForPreset(anthropic), modelPatterns: "claude-*, , gpt-4*" });
  assert.equal("apiKey" in payload, false);
  assert.deepEqual(payload.modelPatterns, ["claude-*", "gpt-4*"]);
  assert.equal(payload.presetId, "anthropic");
  assert.equal(providerPayload({ ...formForPreset(anthropic), apiKey: " sk " }).apiKey, "sk");
});

test("hostOf", () => {
  assert.equal(hostOf("https://api.anthropic.com/v1"), "api.anthropic.com");
  assert.equal(hostOf("not a url"), "not a url");
});
