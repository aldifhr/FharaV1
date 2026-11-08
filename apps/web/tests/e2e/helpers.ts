import { expect, type Page } from "@playwright/test";

/** Routes that exist in the app, with the heading each one should settle on. */
export const ROUTES = [
  { path: "/", heading: "Overview" },
  { path: "/chats", heading: "Select a project" },
  { path: "/inbox", heading: "Inbox" },
  { path: "/search", heading: "Search" },
  // /hello is standalone (no IconRail); tested separately.
] as const;

/**
 * Navigate and wait until the app shell has rendered. Convex queries resolve
 * against the local deployment, so pages that gate on data need a real wait.
 * Some pages (/hello) have no <nav> — pass skipNavCheck to handle those.
 */
export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  // The icon rail is on most pages; wait for it, but fall back to body being present.
  const nav = page.getByRole("navigation").first();
  try {
    await nav.toBeVisible({ timeout: 8_000 });
  } catch {
    // Pages without IconRail (e.g. /hello) skip this check.
    await expect(page.locator("body")).toBeVisible();
  }
}

/** Next.js dev overlay marks runtime errors with this element. */
export async function expectNoRuntimeError(page: Page): Promise<void> {
  const overlay = page.locator("nextjs-portal, [data-nextjs-dialog], #nextjs__container_errors_label");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByText("Unhandled Runtime Error")).toHaveCount(0);
  await expect(page.getByText("This page couldn't load")).toHaveCount(0);
}

/** Wait for a Convex-backed page to finish its loading skeleton. */
export async function waitForData(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 });
}

/** Console/page errors collected during a test, for the no-errors assertions. */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  return errors;
}
