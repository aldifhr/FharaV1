import { describe, expect, test } from "vitest";
import { normalizeRoleMentions } from "./roleMentions";

describe("normalizeRoleMentions", () => {
  test("Indonesian handoff becomes a leading @role mention", () => {
    expect(
      normalizeRoleMentions(
        "Saya akan menambahkan komentar di `src/App.tsx`. Task sudah dibuat dan diserahkan ke Frontend."
      )
    ).toBe("@Frontend, tambahkan komentar di `src/App.tsx`.");
  });

  test("English handoff becomes a leading @role mention", () => {
    expect(normalizeRoleMentions("I added the plan. The task is with Backend.")).toBe(
      "@Backend, I added the plan."
    );
  });

  test("turns a leading self-narration into an instruction", () => {
    expect(
      normalizeRoleMentions(
        "@frontend, saya akan menambahkan komentar satu baris di index.html. Task sudah dibuat."
      )
    ).toBe("@Frontend, tambahkan komentar satu baris di index.html.");
    expect(normalizeRoleMentions("@qa, I will check the build.")).toBe("@QA, check the build.");
  });

  test("uses the task's route when the model names the wrong role", () => {
    expect(
      normalizeRoleMentions(
        "I'll add the section. I created the task and handed it to @frontend; update only that file.",
        "backend"
      )
    ).toBe("@Backend, add the section. I created the task; update only that file.");
  });

  test("strips false or unnecessary task-status claims", () => {
    expect(normalizeRoleMentions("@qa, Saya buat task untuk memeriksa preview dan laporkan hasilnya.")).toBe(
      "@QA, periksa preview dan laporkan hasilnya."
    );
    expect(
      normalizeRoleMentions(
        "@designer, Saya tidak membuat task karena permintaan ini hanya meminta analisis. Palet: abu dan hijau."
      )
    ).toBe("@Designer, Palet: abu dan hijau.");
    expect(normalizeRoleMentions("@backend, I created the task; update only README.md.")).toBe(
      "@Backend, update only README.md."
    );
  });

  test("strips the 'Sudah saya buat task-nya' variant", () => {
    expect(
      normalizeRoleMentions(
        "@QA, Sudah saya buat task-nya dan saya serahkan ke Frontend. @Designer, susun spesifikasi."
      )
    ).toBe("@QA, susun spesifikasi.");
  });

  test("keeps only one role mention per reply", () => {
    expect(normalizeRoleMentions("@qa, periksa preview. @frontend, laporkan hasilnya.")).toBe(
      "@QA, periksa preview. laporkan hasilnya."
    );
    expect(
      normalizeRoleMentions("@QA, @Designer, susun spesifikasi layout; @Backend, tambahkan README.")
    ).toBe("@QA, susun spesifikasi layout; tambahkan README.");
  });

  test("strips a bare task-created claim", () => {
    expect(normalizeRoleMentions("@Frontend, tambahkan komentar. Task sudah dibuat.")).toBe(
      "@Frontend, tambahkan komentar."
    );
  });

  test("strips prior-task chatter before the instruction", () => {
    expect(
      normalizeRoleMentions(
        "@Frontend, Sudah ada task sebelumnya untuk perubahan fitur status, tetapi permintaan komentar satu baris ini berbeda. tambahkan komentar tersebut di src/status.tsx."
      )
    ).toBe("@Frontend, tambahkan komentar tersebut di src/status.tsx.");
  });

  test("teammate replies also keep only one mention", () => {
    expect(
      normalizeRoleMentions("Task dibuat dengan cakupan @Designer, @Frontend, @Backend, @QA, dan @DevOps.")
    ).toBe("Task dibuat dengan cakupan @Designer.");
  });

  test("never adds a mention to a message that had none", () => {
    expect(normalizeRoleMentions("Desain halaman About dengan tiga bagian.", "frontend")).toBe(
      "Desain halaman About dengan tiga bagian."
    );
  });

  test("does not read an incidental 'with <role>' as a handoff", () => {
    const text = "Ada konflik with Backend soal init, tapi compatible with Frontend.";
    expect(normalizeRoleMentions(text)).toBe(text);
  });

  test("leaves unrelated content and file paths alone", () => {
    const text = "See @src/App.tsx and ask @qa to review";
    expect(normalizeRoleMentions(text)).toBe("See @src/App.tsx and ask @QA to review");
  });
});
