import { test, expect } from "@playwright/test";
import { gotoApp, expectNoRuntimeError } from "./helpers";

/**
 * D12 stress run, opt-in: skipped unless FHARA_STRESS=1. Point
 * FHARA_STRESS_PATH at a chat (or a page with a task thread open) that holds
 * a long seeded history, e.g. 3,000 messages:
 *
 *   FHARA_STRESS_PATH=/chats/<projectId> npm run --workspace=@fhara/web test:stress
 *
 * It pages back to the first message with "Load earlier", then jumps to the
 * first turn from the outline, and fails on a runtime error or a page that
 * takes longer than PAGE_TIMEOUT_MS to land.
 */
const STRESS = process.env.FHARA_STRESS === "1";
const STRESS_PATH = process.env.FHARA_STRESS_PATH ?? "";
const PAGES_MAX = 40;
const PAGE_TIMEOUT_MS = 5_000;

test.describe("history stress (opt-in)", () => {
  test.skip(!STRESS, "Set FHARA_STRESS=1 and FHARA_STRESS_PATH to run the history stress spec.");

  test("a long thread pages back to its first message and jumps to a turn", async ({ page }) => {
    test.setTimeout(PAGES_MAX * PAGE_TIMEOUT_MS + 60_000);
    expect(STRESS_PATH, "FHARA_STRESS_PATH is required").not.toBe("");
    await gotoApp(page, STRESS_PATH);
    await expectNoRuntimeError(page);

    const loadEarlier = page.getByRole("button", { name: "Load earlier" });
    await expect(loadEarlier).toBeVisible({ timeout: 15_000 });
    for (let pages = 0; pages < PAGES_MAX && (await loadEarlier.isVisible()); pages++) {
      await loadEarlier.click();
      await expect(page.getByText("Loading earlier messages…")).toHaveCount(0, { timeout: PAGE_TIMEOUT_MS });
    }
    await expect(page.getByText("Start of the conversation")).toBeVisible();
    await expectNoRuntimeError(page);

    await page.getByRole("button", { name: "Jump to a turn" }).click();
    const outline = page.getByRole("navigation", { name: "Conversation turns" });
    const firstTurn = outline.getByRole("button").first();
    await expect(firstTurn).toBeVisible({ timeout: PAGE_TIMEOUT_MS });
    await firstTurn.click();
    await expectNoRuntimeError(page);
  });
});
