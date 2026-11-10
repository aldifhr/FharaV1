import { describe, expect, it } from "vitest";
import { explicitTaskCommand, findOfferedTask, hasAskShape, isGoReply, isPastedContent } from "./intent";

// Contract: chat never starts a task by itself. A task starts only from the
// Create task button, an explicit command, or a bare go reply to a CTO offer.
const roles: Record<string, string> = { cto: "cto", be: "backend", qa: "qa" };
const roleOf = (id?: string) => (id ? roles[id] : undefined);
const offer = (userAsk: string) => [
  { authorType: "user", content: userAsk },
  {
    authorType: "agent",
    agentId: "cto",
    content: "Rencananya: @Backend tambah toggle tema, @QA cek tampilannya. To execute this plan, klik Create task — saya akan delegasikan ke agent yang sesuai.",
  },
];

describe("explicit task commands", () => {
  const paste =
    "kata AI Agent saya, bug JSON bocor itu karena tool call tidak di-strip. Perbaikannya kugabung ke fix JSON bocor.";

  it("the pasted 'kata AI Agent saya …' message is chat, no task", () => {
    expect(isPastedContent(paste)).toBe(true);
    expect(explicitTaskCommand(paste)).toBeNull();
    expect(isGoReply(paste)).toBe(false);
  });
  it("multi-line paste with a go word is never a command", () => {
    expect(explicitTaskCommand("kerjakan ini:\n- fix JSON bocor\n- tambah test")).toBeNull();
    expect(explicitTaskCommand("dia bilang kerjakan dark mode")).toBeNull();
    expect(explicitTaskCommand("> kerjakan tambah dark mode")).toBeNull();
  });
  it("'buat project ini kedepannya kan…' is chat", () => {
    const text = "buat project ini kedepannya kan bakal dipakai tim lain juga";
    expect(explicitTaskCommand(text)).toBeNull();
    expect(isGoReply(text)).toBe(false);
    expect(hasAskShape(text)).toBe(true);
  });
  it("'/task tambah dark mode' is a task", () => {
    expect(explicitTaskCommand("/task tambah dark mode")).toBe("tambah dark mode");
    expect(explicitTaskCommand("/task")).toBeNull();
  });
  it("'kerjakan tambah dark mode' is a task", () => {
    expect(explicitTaskCommand("kerjakan tambah dark mode")).toBe("tambah dark mode");
    // A run order keeps its verb so the worker plans a shell task (detectRunCommands).
    expect(explicitTaskCommand("Jalankan: test e2e login")).toBe("Jalankan: test e2e login");
    expect(explicitTaskCommand("jalankan migrasi database")).toBe("migrasi database");
    expect(explicitTaskCommand("eksekusi migrasi schema users")).toBe("migrasi schema users");
    expect(explicitTaskCommand("do it: add a dark mode toggle")).toBe("add a dark mode toggle");
    expect(explicitTaskCommand("run this refactor of the header")).toBe("refactor of the header");
  });
  it("a question ending in '?' with 'kerjakan' in it is chat", () => {
    expect(explicitTaskCommand("kerjakan dark mode dulu atau login dulu?")).toBeNull();
    expect(explicitTaskCommand("menurutmu siapa yang kerjakan dark mode?")).toBeNull();
  });
  it("change words alone never start a task", () => {
    for (const text of ["fix JSON bocor", "tambah dark mode", "perbaikan login", "gabung PR ini", "buat halaman about"]) {
      expect(explicitTaskCommand(text)).toBeNull();
    }
  });
  it("go words must open the message", () => {
    expect(explicitTaskCommand("kerjakannya nanti saja")).toBeNull();
    expect(explicitTaskCommand("tolong kerjakan dark mode")).toBeNull();
  });
});

describe("go reply after a CTO Create task offer", () => {
  it("recognises bare go replies only", () => {
    for (const t of ["gas", "Gas!", "lanjut", "ok kerjakan", "go", "yes do it", "oke gas", "lanjutkan aja"]) expect(isGoReply(t)).toBe(true);
    for (const t of ["gas tambah dark mode sekalian refactor", "lanjut ke topik lain dong?", "kata dia gas"]) expect(isGoReply(t)).toBe(false);
  });
  it("'gas' after a CTO offer starts the offered task", () => {
    const got = findOfferedTask([...offer("tambah dark mode"), { authorType: "user", content: "gas" }], roleOf);
    expect(got).not.toBeNull();
    expect(got!.command).toBe(`tambah dark mode\n\n${offer("x")[1].content}`);
    expect(got!.index).toBe(1);
  });
  it("teammates pulled in after the offer do not hide it", () => {
    const history = [...offer("tambah dark mode"), { authorType: "agent", agentId: "be", content: "Bisa, toggle di header." }, { authorType: "user", content: "gas" }];
    expect(findOfferedTask(history, roleOf)?.index).toBe(1);
  });
  it("an option pick offer composes like the button", () => {
    const history = [
      { authorType: "user", content: "I choose B: Sidebar layout" },
      { authorType: "agent", agentId: "cto", content: "I agree. @Backend builds it." },
      { authorType: "user", content: "lanjut" },
    ];
    const got = findOfferedTask(history, roleOf);
    expect(got?.command).toBe("Chosen option: Sidebar layout\n\nI agree. @Backend builds it.");
    expect(got?.title).toBe("Implement Sidebar layout");
  });
  it("'gas' with no prior offer is chat", () => {
    expect(findOfferedTask([{ authorType: "user", content: "gas" }], roleOf)).toBeNull();
    expect(
      findOfferedTask(
        [
          { authorType: "user", content: "apa itu dark mode" },
          { authorType: "agent", agentId: "cto", content: "Dark mode adalah tema gelap." },
          { authorType: "user", content: "gas" },
        ],
        roleOf
      )
    ).toBeNull();
    // A non-CTO reply that mentions create task is not an offer.
    expect(
      findOfferedTask([{ authorType: "user", content: "x" }, { authorType: "agent", agentId: "be", content: "buat task aja" }, { authorType: "user", content: "gas" }], roleOf)
    ).toBeNull();
  });
  it("a second 'gas' does not re-start the offer", () => {
    const history = [...offer("tambah dark mode"), { authorType: "user", content: "gas" }, { authorType: "user", content: "gas" }];
    expect(findOfferedTask(history, roleOf)).toBeNull();
  });
});
