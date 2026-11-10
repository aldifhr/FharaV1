import { test } from "node:test";
import assert from "node:assert/strict";
import { isOfferUsed, offersCreateTask } from "../../lib/taskOffer.ts";

test("a server-detected run request shows Create task whatever the reply says", () => {
  assert.equal(
    offersCreateTask({ content: "Saya tidak punya akses shell, jalankan npm test di terminal Anda.", taskOffer: { kind: "testing", commands: ["npm run test"] } }),
    true
  );
});

test("no offer and no wording: no button", () => {
  assert.equal(offersCreateTask({ content: "Tesnya ada di tests/." }), false);
  assert.equal(offersCreateTask({ content: "", taskOffer: null }), false);
});

test("legacy wording still offers it", () => {
  assert.equal(offersCreateTask({ content: "Klik Create task untuk mulai." }), true);
});

test("live test 4: a used offer never shows Create task again", () => {
  const used = { kind: "implementation", usedTaskId: "t1", usedAt: 1 };
  assert.equal(isOfferUsed(used), true);
  assert.equal(offersCreateTask({ content: "Klik Create task untuk mulai.", taskOffer: used }), false);
  assert.equal(isOfferUsed({ kind: "implementation" }), false);
  assert.equal(isOfferUsed(null), false);
});
