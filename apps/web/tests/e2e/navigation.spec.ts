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
    // Close any stale dialog from a previous test.
    await page.keyboard.press("Escape").catch(() => {});
    const rail = page.getByRole("navigation").first();
    await rail.getByRole("button", { name: "Search" }).click();
    // Wait for the Radix dialog title to appear inside the dialog portal.
    await expect(page.getByRole("heading", { name: "Command menu", exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("workspace routes redirect", async ({ page }) => {
    await page.goto("/workspace");
    await expect(page).toHaveURL(/\/$/);

    await page.goto("/workspace/some-project-id");
    await expect(page).toHaveURL(/\/chats\/some-project-id$/);
  });

  test("unknown route renders the not-found page", async ({ page }) => {
    await page.goto("/this-route-does-not-exist");
    await expect(page.getByText("404")).toBeVisible();
  });
});
