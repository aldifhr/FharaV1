import { test, expect } from "@playwright/test";
import { ROUTES, gotoApp, expectNoRuntimeError } from "./helpers";

test.describe("routes", () => {
  for (const route of ROUTES) {
    test(`${route.path} renders`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await gotoApp(page, route.path);
      await expectNoRuntimeError(page);

      await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible({ timeout: 20_000 });

      expect(errors, `page errors on ${route.path}`).toEqual([]);
    });
  }
});
