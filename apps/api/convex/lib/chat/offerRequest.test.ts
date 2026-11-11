import { describe, expect, test } from "vitest";
import { composeOfferedTask, requestAnsweredByOffer } from "./intent";

/**
 * E2E mock round 2 (2026-11-11), flow a: the Create task button built its
 * command from an earlier "/research 3 …" turn (it shared the word "small"
 * with the CTO's offer) instead of the latest "Add a footer…" request.
 */
const OFFER =
  "This is a small, self-contained change. Press Create task to start it: I will plan it and hand it to the right teammate, and you can follow the run from the task card.";
const history = [
  { authorType: "user", content: "/research 3 Which background job runner fits a small Node app?" },
  { authorType: "agent", content: "Research started: 3 angles." },
  { authorType: "agent", content: "Synthesis: BullMQ for a small Node app with Redis; otherwise a cron loop." },
  { authorType: "user", content: "Add a footer to index.html that says Built with Fhara." },
  { authorType: "agent", content: OFFER },
];

describe("the request a Create task offer answers", () => {
  test("the latest user turn right before the offer wins over an earlier turn with more word overlap", () => {
    expect(requestAnsweredByOffer(history, 4)).toBe("Add a footer to index.html that says Built with Fhara.");
    const { command, title } = composeOfferedTask(history, 4);
    expect(title).toBe("Add a footer to index.html that says Built with Fhara.");
    expect(command).toBe(`Add a footer to index.html that says Built with Fhara.\n\n${OFFER}`);
    expect(command).not.toContain("/research");
  });

  test("a slash command is never the request, even when it is the nearest user turn", () => {
    const h = [
      { authorType: "user", content: "tambah dark mode" },
      { authorType: "agent", content: "Bisa." },
      { authorType: "user", content: "/research 2 dark mode libraries" },
      { authorType: "agent", content: "Saya sarankan @Frontend menambah dark mode. Klik Create task." },
    ];
    expect(requestAnsweredByOffer(h, 3)).toBe("tambah dark mode");
  });

  test("an already answered request still gives way to overlap after a meta follow-up", () => {
    const h = [
      { authorType: "user", content: "buat halaman FAQ" },
      { authorType: "agent", content: "Rencana: halaman FAQ. Klik Create task." },
      { authorType: "user", content: "tambahkan pencarian di halaman about" },
      { authorType: "agent", content: "Belum perlu." },
      { authorType: "user", content: "kok bikin task?" },
      { authorType: "agent", content: "Saya panggil @Frontend untuk halaman FAQ-nya. Pilih Create task." },
    ];
    expect(requestAnsweredByOffer(h, 5)).toBe("buat halaman FAQ");
  });
});
