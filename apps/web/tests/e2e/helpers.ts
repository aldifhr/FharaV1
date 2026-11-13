import { expect, type Page } from "@playwright/test";

/** Routes that exist in the app, with the heading each one should settle on. */
export const ROUTES = [
  { path: "/", heading: "Overview" },
  { path: "/chats", heading: "Select a project" },
  { path: "/inbox", heading: "Inbox" },
  { path: "/search", heading: "Search" },
] as const;

/**
 * Navigate and wait until the app shell has rendered. Convex queries resolve
 * against the local deployment, so pages that gate on data need a real wait.
 */
export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  // The icon rail is on most pages; wait for it, but fall back to body being present.
  const nav = page.getByRole("navigation").first();
  try {
    await nav.toBeVisible({ timeout: 8_000 });
  } catch {
    // Pages without IconRail skip this check.
    await expect(page.locator("body")).toBeVisible();
  }
}

/**
 * Next.js 16 dev always mounts an empty <nextjs-portal> in the document, so
 * "portal exists" is not an error signal. The overlay only fills that portal
 * (and renders the error dialog + label) when a real runtime error fires, so
 * assert on the portal's children instead of its presence.
 */
export async function expectNoRuntimeError(page: Page): Promise<void> {
  await expect(page.locator("nextjs-portal > *")).toHaveCount(0);
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
  await expect(page.locator("#nextjs__container_errors_label")).toHaveCount(0);
  await expect(page.getByText("Unhandled Runtime Error")).toHaveCount(0);
  await expect(page.getByText("This page couldn't load")).toHaveCount(0);
}

/** Wait for a Convex-backed page to finish its loading skeleton. */
export async function waitForData(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 });
}
