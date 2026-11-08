import { test, expect } from "@playwright/test";
import { gotoApp, expectNoRuntimeError, waitForData } from "./helpers";

test.describe("overview", () => {
  test("shows the stat cards and project section once data lands", async ({ page }) => {
    await gotoApp(page, "/");
    await expectNoRuntimeError(page);

    await waitForData(page, "Overview of all projects and agents.");

    for (const label of ["Project", "Agent", "Running tasks", "Needs approval", "Failed tasks", "Total task"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    await expect(page.getByRole("heading", { name: "Project", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent tasks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Team \(/ })).toBeVisible();
  });

  test("project section renders either a list or its empty state", async ({ page }) => {
    await gotoApp(page, "/");
    await waitForData(page, "Overview of all projects and agents.");

    const emptyState = page.getByText("No projects yet. Add a project folder with the + Project button.");
    const projectLink = page.locator("a[href^='/chats/']").first();

    await expect(emptyState.or(projectLink).first()).toBeVisible();
  });

  test("new project button opens the dialog", async ({ page }) => {
    await gotoApp(page, "/");
    await waitForData(page, "Overview of all projects and agents.");

    await page.getByRole("button", { name: "+ Project" }).click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
  });
});
