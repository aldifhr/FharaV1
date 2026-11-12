import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { sidebarNavLinks } from "../../components/sidebar/navLinks.ts";

// Pages removed on purpose; they must not come back through a route, the sidebar or ⌘K
// (⌘K lists the same `sidebarNavLinks`).
const BANNED = ["/playground"];

test("banned pages have no route and no nav entry", () => {
  for (const href of BANNED) {
    assert.equal(existsSync(new URL(`../../app${href}`, import.meta.url)), false, `${href} route exists`);
  }
  const { build, development, observe } = sidebarNavLinks({ pathname: "/" });
  const hrefs = [...build, ...development, ...observe].map((l) => (l.href ?? "").split("?")[0]);
  for (const href of BANNED) assert.equal(hrefs.includes(href), false, `${href} is in the sidebar/⌘K`);
});
