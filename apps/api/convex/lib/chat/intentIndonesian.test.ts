import { describe, expect, it } from "vitest";
import { classifyChatIntent, hasAskShape } from "./intent";

describe("Indonesian question shapes stay chat", () => {
  const asks = [
    "@Researcher bandingkan zustand vs jotai untuk state management di Next.js, mana yang cocok buat project ini?",
    "@QA menurutmu bagian mana dari app ini yang paling rawan bug?",
    "kenapa build-nya gagal?",
    "jelaskan alur login",
  ];
  for (const text of asks) {
    it(text, () => {
      expect(hasAskShape(text)).toBe(true);
      expect(classifyChatIntent(text).kind).toBe("chat");
    });
  }
  const tasks = [
    "tambahkan fungsi formatRupiah(angka) di utils beserta tesnya",
    "buat halaman /about yang berisi nama project",
    "buat fitur todo list: tambah, centang selesai, hapus, simpan di localStorage",
  ];
  for (const text of tasks) {
    it(text, () => {
      expect(hasAskShape(text)).toBe(false);
      expect(classifyChatIntent(text).kind).toBe("task");
    });
  }
});
