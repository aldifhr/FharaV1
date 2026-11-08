import { test, expect } from "@playwright/test";
import { gotoApp, expectNoRuntimeError } from "./helpers";

test.describe("search", () => {
  test("shows the search prompt, fills the input, and shows results or empty state", async ({ page }) => {
    await gotoApp(page, "/search");
    await expectNoRuntimeError(page);

    await expect(page.getByText("Start typing to search.")).toBeVisible();

    const input = page.getByPlaceholder("Search for a project, task, or agent…");
    await input.click();
    await input.fill("playwright-nonexistent-query-xyz");

    // After filling, either results appear (a section heading) or the empty-state copy.
    await expect(
      page
        .getByRole("heading", { name: "Project", exact: true })
        .or(page.getByRole("heading", { name: "Task", exact: true }))
        .or(page.getByRole("heading", { name: "Agent", exact: true }))
        .or(page.getByText(/No results for/))
        .first()
    ).toBeVisible({ timeout: 20_000 });
  });
});
