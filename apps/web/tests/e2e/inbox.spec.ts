import { test, expect } from "@playwright/test";
import { gotoApp, expectNoRuntimeError, waitForData } from "./helpers";

test.describe("inbox", () => {
  test("renders the inbox heading and settles out of the loading skeleton", async ({ page }) => {
    await gotoApp(page, "/inbox");
    await expectNoRuntimeError(page);

    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await waitForData(page, /item\(s\) need your attention|Nothing is waiting for you\./);

    const empty = page.getByText("Inbox is empty. All approvals have been processed.");
    const approval = page.getByRole("heading", { name: /Needs approval \(/ });
    const task = page.getByRole("heading", { name: /Task needs attention \(/ });
    const agent = page.getByRole("heading", { name: /Agents waiting for you \(/ });

    await expect(empty.or(approval).or(task).or(agent).first()).toBeVisible();
  });
});
