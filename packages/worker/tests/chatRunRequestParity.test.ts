/**
 * Parity: the chat copy of run-request detection
 * (apps/api/convex/lib/chat/runRequest.ts — Convex cannot import worker code)
 * must agree with the worker classifier (detectRunCommands) and the command
 * allowlist (ALLOWED_ARGV). When this fails, update the api mirror.
 */
import { describe, expect, it } from "vitest";
import { detectRunCommands } from "../src/orchestrator/classifier";
import { ALLOWED_ARGV } from "../src/utils/commandAllowlist";
import { CHAT_ALLOWED_ARGV, detectChatRunCommands } from "../../../apps/api/convex/lib/chat/runRequest";

const CORPUS = [
  // run requests
  "jalankan tes",
  "tolong jalankan tes",
  "jalanin testnya dong",
  "Jalankan: test e2e login",
  "run npm test",
  "npm run test",
  "run the tests",
  "please run the unit tests again",
  "npx tsc --noEmit",
  "run tsc",
  "jalankan typecheck",
  "cek tipe dong, jalankan",
  "jalankan build lalu tes",
  "run typecheck and tests",
  "run npm run build",
  "git status",
  "git status --short",
  "git log --oneline -n 20",
  "node --version",
  "eksekusi npx tsc --noEmit",
  "bisa tolong run npm test?",
  "jalankan tes tanpa mengubah kode",
  "run the tests, don't change any code",
  // questions
  "kenapa npm test gagal?",
  "why does npm test fail?",
  "apakah tes sudah lulus?",
  "what does npm run build do",
  // mixed / change requests
  "run tests and fix the failures",
  "jalankan tes lalu perbaiki yang gagal",
  "tambah tes untuk login",
  "run the migration",
  "jalankan migrasi database",
  "refactor the header then run the build",
  // not commands
  "tes",
  "halo",
  "",
  "run rm -rf /",
  "npm install lodash",
  "git push origin main",
  "jalankan tes\n--- Conversation context ---\nfix the login and refactor",
];

describe("chat run-request detection matches the worker", () => {
  it("allowlist mirror is identical", () => {
    expect(CHAT_ALLOWED_ARGV).toEqual(ALLOWED_ARGV);
  });

  it.each(CORPUS.map((text) => [JSON.stringify(text), text]))("%s", (_label, text) => {
    expect(detectChatRunCommands(text)).toEqual(detectRunCommands(text));
  });
});
