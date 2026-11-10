import { test, expect } from "@playwright/test";
import { ROUTES, gotoApp, expectNoRuntimeError } from "./helpers";

test.describe("routes", () => {
  for (const route of ROUTES) {
    test(`${route.path} renders`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await gotoApp(page, route.path);
      await expectNoRuntimeError(page);

      // "Select a project" on /chats is a TextMorph <p>, not an <h1> — use getByText.
      const headingLocator =
        route.path === "/chats"
          ? page.getByText(route.heading).first()
          : page.getByRole("heading", { name: route.heading }).first();

      await expect(headingLocator).toBeVisible({ timeout: 20_000 });

      expect(errors, `page errors on ${route.path}`).toEqual([]);
    });
  }
});
