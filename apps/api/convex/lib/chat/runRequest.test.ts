import { describe, expect, it } from "vitest";
import { detectChatRunCommands, explicitRunCommand } from "./runRequest";

describe("detectChatRunCommands", () => {
  it.each([
    ["jalankan tes", ["npm run test"]],
    ["tolong jalankan tes", ["npm run test"]],
    ["jalanin testnya dong", ["npm run test"]],
    ["run npm test", ["npm run test"]],
    ["npm run test", ["npm run test"]],
    ["run the tests", ["npm run test"]],
    ["npx tsc --noEmit", ["npx tsc --noEmit"]],
    ["run tsc", ["npx tsc --noEmit"]],
    ["jalankan build lalu tes", ["npm run build", "npm run test"]],
    ["run typecheck and tests", ["npm run typecheck", "npm run test"]],
    ["git status", ["git status"]],
    ["please run npm run build", ["npm run build"]],
  ])("%s → %j", (text, lines) => {
    expect(detectChatRunCommands(text)).toEqual(lines);
  });

  it.each([
    "kenapa npm test gagal?",
    "why does npm test fail?",
    "apakah tes sudah lulus?",
    "run tests and fix the failures",
    "jalankan tes lalu perbaiki yang gagal",
    "run the migration",
    "tambah tes untuk login",
    "tes",
    "",
    "run rm -rf /",
  ])("%s → null", (text) => {
    expect(detectChatRunCommands(text)).toBeNull();
  });

  it("ignores attached conversation context", () => {
    expect(detectChatRunCommands("jalankan tes\n--- Conversation context ---\nfix the login and refactor")).toEqual([
      "npm run test",
    ]);
  });
});

describe("explicitRunCommand", () => {
  it.each(["jalankan tes", "Jalankan: test e2e login", "run npm test", "execute the build", "eksekusi npx tsc --noEmit"])(
    "%s is an explicit run order",
    (text) => {
      expect(explicitRunCommand(text)).toBe(text.trim());
    }
  );
  it.each([
    "tolong jalankan tes", // request, not a leading order
    "npm run test", // no run verb up front
    "jalankan tes?",
    "run tests and fix",
    "jalankan migrasi database",
    "jalankan tes\nlalu cek",
  ])("%s is not", (text) => {
    expect(explicitRunCommand(text)).toBeNull();
  });
});
