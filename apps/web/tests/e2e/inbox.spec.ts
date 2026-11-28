import { test, expect } from "@playwright/test";
import { gotoApp, expectNoRuntimeError, waitForData } from "./helpers";

test.describe("inbox", () => {
  test("renders the inbox heading and settles out of the loading skeleton", async ({ page }) => {
    await gotoApp(page, "/inbox");
    await expectNoRuntimeError(page);

    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await waitForData(page, /All clear|\d+ waiting/);

    const empty = page.getByText("You're all caught up.");
    const section = page.getByRole("heading", {
      name: /Approvals|Questions|Options to review|Ready to push|From GitHub issues|Task drafts|Drafts to review|Pull requests|Recent failures/,
    });

    await expect(empty.or(section).first()).toBeVisible();
  });
});
