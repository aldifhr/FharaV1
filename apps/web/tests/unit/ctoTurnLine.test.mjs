import { test } from "node:test";
import assert from "node:assert/strict";
import { answerSummary, ctoTurnLine, ctoTurnTickMs, timeLeft } from "../../lib/ctoTurnLine.ts";

const now = 1_000_000;

test("an open turn waits on the CTO with the time left", () => {
  assert.equal(ctoTurnLine({ status: "open", expiresAt: now + 9 * 60_000 - 5_000 }, now), "Waiting on CTO · expires in 9m");
  assert.equal(ctoTurnLine({ status: "open", expiresAt: now + 30_000 }, now), "Waiting on CTO · expires in under a minute");
  assert.equal(ctoTurnLine({ status: "open", expiresAt: now - 1 }, now), "Waiting on CTO · expiring");
  assert.equal(timeLeft(65 * 60_000), "1h 5m");
});

test("an answered turn shows the answer summary, the chosen option first", () => {
  const line = ctoTurnLine({ status: "answered", expiresAt: now, chosenOption: "Allow the dependency", answer: "Zod is small.\nMore detail." }, now);
  assert.equal(line, "CTO answered · Allow the dependency: Zod is small.");
  assert.equal(answerSummary({ answer: "x".repeat(300) }).length, 140);
  assert.equal(ctoTurnLine({ status: "answered", expiresAt: now, answer: "" }, now), "CTO answered");
});

test("expired and declined turns went to the user; no @name ever", () => {
  assert.equal(ctoTurnLine({ status: "expired", expiresAt: now }, now), "Sent to you");
  assert.equal(ctoTurnLine({ status: "escalated", expiresAt: now }, now), "Sent to you");
  assert.equal(ctoTurnLine({ status: "answered", expiresAt: now, answer: "Ask @Backend to add it" }, now), "CTO answered · Ask Backend to add it");
  assert.equal(ctoTurnLine(null, now), null);
});

test("only an open turn ticks", () => {
  assert.equal(ctoTurnTickMs({ status: "open", expiresAt: now }), 15_000);
  assert.equal(ctoTurnTickMs({ status: "answered", expiresAt: now }), null);
  assert.equal(ctoTurnTickMs(undefined), null);
});
