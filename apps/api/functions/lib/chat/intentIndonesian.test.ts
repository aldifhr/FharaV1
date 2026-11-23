import { describe, expect, it } from "vitest";
import { classifyChatIntent, explicitTaskCommand, hasAskShape } from "./intent";

describe("Indonesian question shapes stay chat", () => {
  const asks = [
    "@Researcher bandingkan zustand vs jotai untuk state management di Next.js, mana yang cocok buat project ini?",
    "@QA menurutmu bagian mana dari app ini yang paling rawan bug?",
    "kenapa build-nya gagal?",
    "jelaskan alur login",
    "kan ga cuma buat project ini kedepannya",
    "emang iya",
    "bukannya backend udah handle itu",
    "saya cuma tanya kok tiba tiba bikin task",
    "tambah role PM bagus ga?",
  ];
  for (const text of asks) {
    it(text, () => {
      expect(hasAskShape(text)).toBe(true);
      expect(classifyChatIntent(text).kind).toBe("chat");
      expect(explicitTaskCommand(text)).toBeNull();
    });
  }
  // Work requests are a SUGGESTION (plan + Create task button), never a
  // task started by chat itself.
  const tasks = [
    "tambahkan fungsi formatRupiah(angka) di utils beserta tesnya",
    "buat halaman /about yang berisi nama project",
    "buat fitur todo list: tambah, centang selesai, hapus, simpan di localStorage",
    "buat endpoint /health buat project ini",
    "tolong perbaiki bug login",
  ];
  for (const text of tasks) {
    it(text, () => {
      expect(hasAskShape(text)).toBe(false);
      expect(classifyChatIntent(text).kind).toBe("task");
      expect(explicitTaskCommand(text)).toBeNull();
    });
  }
  const prepositionOnly = ["ini cuma buat kamu aja", "itu buat ke depannya nanti"];
  for (const text of prepositionOnly) {
    it(`preposition only: ${text}`, () => {
      expect(classifyChatIntent(text).kind).toBe("chat");
    });
  }
});
