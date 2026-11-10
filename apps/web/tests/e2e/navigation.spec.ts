import { test, expect } from "@playwright/test";
import { gotoApp, expectNoRuntimeError } from "./helpers";

test.describe("navigation", () => {
  test("icon rail moves between sections", async ({ page }) => {
    await gotoApp(page, "/");
    await expectNoRuntimeError(page);

    const rail = page.getByRole("navigation").first();

    await rail.getByRole("link", { name: "Chats" }).click();
    await expect(page).toHaveURL(/\/chats$/);
    await expect(page.getByText("Select a project").first()).toBeVisible();

    await rail.getByRole("link", { name: "Inbox" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

    await rail.getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  test("command menu opens with the search button", async ({ page }) => {
    await gotoApp(page, "/");
    await expectNoRuntimeError(page);

    const rail = page.getByRole("navigation").first();
    await rail.getByRole("button", { name: "Search" }).click();
    // The dialog title is sr-only and gets aria-hidden once the modal opens,
    // so assert on the palette input — that is the real "it opened" signal.
    await expect(page.getByPlaceholder("Search projects, tasks, agents…")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Search projects, tasks, and agents")).toBeVisible();
  });

  test("unknown route renders the not-found page", async ({ page }) => {
    await page.goto("/this-route-does-not-exist");
    await expect(page.getByText("404")).toBeVisible();
  });
});
