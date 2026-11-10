import { describe, expect, test } from "vitest";
import {
  WRAP_UP_MAX_LINES,
  WRAP_UP_SHORT_REPLY_MAX_WORDS,
  isShortReply,
  jaccard,
  sanitizeWrapUp,
  userNamedAgent,
  wrapUpSkipReason,
} from "./wrapUp";

const FRONTEND = { name: "Frontend", role: "frontend" };
const REVIEWER = { name: "Reviewer", role: "reviewer" };
const longReply = (n = WRAP_UP_SHORT_REPLY_MAX_WORDS + 40) =>
  Array.from({ length: 12 }, (_, i) => `Line ${i}: ` + Array.from({ length: Math.ceil(n / 12) }, (_, j) => `w${i}x${j}`).join(" ")).join("\n");

describe("userNamedAgent", () => {
  test.each([
    "can you ask frontend, what is html",
    "@Frontend what is html",
    "tanya frontend dong, html itu apa",
    "tanyain ke frontend soal html",
    "Frontend, what is html?",
    "please ask the frontend about html",
  ])("named: %s", (text) => {
    expect(userNamedAgent(text, FRONTEND)).toBe(true);
  });

  test("minta reviewer", () => {
    expect(userNamedAgent("minta reviewer cek fungsi parseConfig", REVIEWER)).toBe(true);
  });

  test.each(["what is html?", "is the frontend build broken?", "do we have frontend tests?"])("not named: %s", (text) => {
    expect(userNamedAgent(text, FRONTEND)).toBe(false);
  });
});

describe("wrapUpSkipReason", () => {
  test("skipped when the user named the specialist, even for a long reply", () => {
    expect(wrapUpSkipReason({ userText: "can you ask frontend, what is html", specialists: [{ agent: FRONTEND, reply: longReply() }] })).toBe(
      "user-named-agent"
    );
  });

  test("skipped for a single short reply", () => {
    expect(isShortReply("HTML is the markup language of the web. Want me to show an example?")).toBe(true);
    expect(
      wrapUpSkipReason({ userText: "what is html?", specialists: [{ agent: FRONTEND, reply: "HTML is the markup language of the web." }] })
    ).toBe("short-single-reply");
  });

  test("a long single reply may get a wrap-up", () => {
    expect(isShortReply(longReply())).toBe(false);
    expect(wrapUpSkipReason({ userText: "how is our UI structured?", specialists: [{ agent: FRONTEND, reply: longReply() }] })).toBeNull();
  });

  test("nothing said, nothing to wrap up", () => {
    expect(wrapUpSkipReason({ userText: "x", specialists: [{ agent: FRONTEND, reply: "  " }] })).toBe("no-reply");
  });
});

describe("sanitizeWrapUp", () => {
  const reply =
    "HTML (HyperText Markup Language) is the standard markup language for web pages.\nIt structures content with elements like headings and links.\nWant me to show a small example page?";

  test("empty or 'nothing to add' is dropped", () => {
    expect(sanitizeWrapUp("", [reply])).toBeNull();
    expect(sanitizeWrapUp("nothing to add.", [reply])).toBeNull();
    expect(sanitizeWrapUp("Tidak ada tambahan.", [reply])).toBeNull();
  });

  test("a near-duplicate of the specialist reply is dropped", () => {
    const dup =
      "HTML (HyperText Markup Language) is the standard markup language for web pages; it structures content with elements like headings and links. Want me to show a small example page?";
    expect(jaccard(dup, reply)).toBeGreaterThan(0.6);
    expect(sanitizeWrapUp(dup, [reply])).toBeNull();
  });

  test("a repeated offer and restated sentences are dropped, a next step is kept", () => {
    const out = sanitizeWrapUp(
      "HTML is the standard markup language for web pages.\nNext step: we keep the landing page in plain semantic HTML.\nWant me to show a small example page?",
      [reply]
    );
    expect(out).toBe("Next step: we keep the landing page in plain semantic HTML.");
  });

  test("capped at WRAP_UP_MAX_LINES lines", () => {
    const out = sanitizeWrapUp("Decision: ship the fix.\nNext: QA reruns e2e.\nThen: deploy Friday.\nAnd: notify users.", [longReply()]);
    expect(out?.split("\n")).toHaveLength(WRAP_UP_MAX_LINES);
  });
});
