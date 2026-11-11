import { describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { designDirFor, purposeFor, runShowOptions, type ShowOptionsApi, type ShowOptionsContext } from "./showOptions";

const PAGE = "<!doctype html><html><head></head><body><p>Option</p></body></html>";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function harness(createStatus: "pending" | "auto" = "pending") {
  const root = mkdtempSync(path.join(tmpdir(), "show-options-"));
  const api = {
    optionReviewUploadUrl: vi.fn(async () => "http://upload.invalid"),
    createOptionReview: vi.fn(async () => ({ reviewId: "rev1", status: createStatus, replyText: createStatus === "auto" ? "Review: x\n\nPicked B." : null })),
    getOptionReview: vi.fn(async () => ({ status: "answered", replyText: "Review: x\n\nPicked A.", cancelReason: null, taskStatus: "running" })),
    cancelOptionReview: vi.fn(async () => ({ applied: true })),
  } as unknown as ShowOptionsApi & Record<string, ReturnType<typeof vi.fn>>;
  const render = vi.fn(async () => PNG);
  const upload = vi.fn(async () => "storage1");
  const ctx: ShowOptionsContext = {
    api,
    taskId: "t1",
    projectId: "p1",
    subtaskKey: "design",
    agentId: "a1",
    role: "designer",
    workspaceRoot: root,
    render,
    upload,
    sleep: async () => undefined,
    timeoutMs: 60_000,
  };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, api, render, upload, ctx, cleanup };
}

describe("show_options: validation before write", () => {
  test("one bad option refuses the whole call: nothing rendered, uploaded, stored or written", async () => {
    const h = harness();
    try {
      const out = await runShowOptions(
        {
          title: "Inbox layout",
          options: [
            { id: "A", title: "Good", kind: "html", html: PAGE },
            { id: "B", title: "Bad", kind: "html", html: '<p onclick="steal()">x</p><script>alert(1)</script>' },
          ],
        },
        h.ctx
      );
      expect(out.ok).toBe(false);
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Option B was not accepted");
      expect(out.text).toContain("[script]");
      expect(out.text).toContain("[event-handler]");
      expect(h.render).not.toHaveBeenCalled();
      expect(h.upload).not.toHaveBeenCalled();
      expect(h.api.createOptionReview).not.toHaveBeenCalled();
      expect(existsSync(path.join(h.root, ".fhara"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("bad recommended, missing image, unknown kind and only references are refused before writing", async () => {
    const h = harness();
    try {
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ title: "T", recommended: "Z", options: [{ id: "A", title: "a", kind: "markdown", markdown: "m" }] }, /recommended must be one of: A/],
        [{ title: "T", options: [{ id: "A", title: "a", kind: "image", path: "nope.png" }] }, /Option A: image file not found/],
        [{ title: "T", options: [{ id: "A", title: "a", kind: "image", path: "../../etc/passwd" }] }, /Option A: image/],
        [{ title: "T", options: [{ id: "A", title: "a", kind: "video" }] }, /kind must be html, markdown or image/],
        [{ title: "T", options: [{ id: "R", title: "r", kind: "markdown", markdown: "m", reference: true }] }, /at least one option the user can pick/],
        [{ title: "", options: [{ id: "A", title: "a", kind: "markdown", markdown: "m" }] }, /title is required/],
        [{ title: "T", options: [] }, /non-empty/],
      ];
      for (const [args, reason] of cases) {
        const out = await runShowOptions(args, h.ctx);
        expect(out.ok, String(reason)).toBe(false);
        expect(out.text).toMatch(reason);
      }
      expect(h.api.createOptionReview).not.toHaveBeenCalled();
      expect(existsSync(path.join(h.root, ".fhara"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("a valid call writes sanitized pages + renders, stores only sanitized html, then waits for the answer", async () => {
    const h = harness();
    try {
      const out = await runShowOptions(
        {
          title: "Inbox layout",
          recommended: "B",
          options: [
            { id: "A", title: "Table", kind: "html", html: '<p>A</p><a href="https://example.com">x</a>' },
            { id: "B", title: "Cards", kind: "markdown", markdown: "Cards with previews" },
          ],
        },
        h.ctx
      );
      expect(out).toMatchObject({ ok: true, isError: false, reviewId: "rev1" });
      expect(out.text).toContain("Picked A.");
      const dir = designDirFor(h.root, "design", false);
      expect(readdirSync(dir).sort()).toEqual(["A.html", "A.png", "README.md"]);
      expect(readFileSync(path.join(h.root, ".fhara", ".gitignore"), "utf8")).toContain("*");
      const stored = (h.api.createOptionReview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(stored.purpose).toBe("design");
      expect(stored.recommended).toBe("B");
      expect(stored.options[0]).toMatchObject({ id: "A", kind: "html", imageStorageId: "storage1" });
      expect(stored.options[0].html).toContain('<a href="#">x</a>');
      expect(stored.options[0].html).not.toContain("example.com");
      expect(stored.options[0]).not.toHaveProperty("png");
      expect(stored.options[1]).toEqual({ id: "B", title: "Cards", kind: "markdown", markdown: "Cards with previews" });
    } finally {
      h.cleanup();
    }
  });

  test("a project that skips reviews returns the auto pick without waiting", async () => {
    const h = harness("auto");
    try {
      const out = await runShowOptions({ title: "T", options: [{ id: "A", title: "a", kind: "markdown", markdown: "m" }] }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("Picked B.");
      expect(h.api.getOptionReview).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  test("a render failure keeps the option with a warning; an upload failure of a real image fails", async () => {
    const h = harness();
    try {
      h.render.mockRejectedValueOnce(new Error("chromium missing"));
      const ok = await runShowOptions({ title: "T", options: [{ id: "A", title: "a", kind: "html", html: PAGE }] }, h.ctx);
      expect(ok.ok).toBe(true);
      expect(ok.text).toContain("no picture (chromium missing)");
      writeFileSync(path.join(h.root, "shot.png"), PNG);
      h.upload.mockRejectedValueOnce(new Error("upload failed (500)"));
      const bad = await runShowOptions({ title: "T", options: [{ id: "A", title: "a", kind: "image", path: "shot.png" }] }, h.ctx);
      expect(bad.ok).toBe(false);
      expect(bad.text).toContain("image upload failed");
    } finally {
      h.cleanup();
    }
  });

  test("timeout cancels the review and tells the agent the user has not confirmed", async () => {
    const h = harness();
    (h.api.getOptionReview as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "pending", replyText: null, cancelReason: null, taskStatus: "running" });
    let t = 0;
    try {
      const out = await runShowOptions(
        { title: "T", options: [{ id: "A", title: "a", kind: "markdown", markdown: "m" }] },
        { ...h.ctx, now: () => (t += 30_000), timeoutMs: 60_000 }
      );
      expect(out.ok).toBe(false);
      expect(out.text).toContain("has not confirmed");
      expect(h.api.cancelOptionReview).toHaveBeenCalledWith({ reviewId: "rev1", reason: "No answer in time" });
    } finally {
      h.cleanup();
    }
  });

  test("purpose defaults by role", () => {
    expect(purposeFor("Designer", undefined)).toBe("design");
    expect(purposeFor("cto", undefined)).toBe("architecture");
    expect(purposeFor("designer", "research")).toBe("research");
    expect(purposeFor("qa", "bogus")).toBe("other");
  });
});
