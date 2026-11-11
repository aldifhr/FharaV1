/**
 * `show_options`: the role-agnostic options review tool (lib/optionsReview.ts).
 *
 * Adapted from threadbear's show_options tool (runner/src/threadbear-mcp.ts)
 * and its review creation (runner/src/runner/reviews.ts, review-media.ts),
 * MIT, Copyright (c) 2026 Mike Cann. Rewritten for Fhara: options are typed
 * html | image | markdown; html goes through the validator + sanitizer
 * (htmlPreview.ts) and a scripts-off PNG render (render.ts); the review is a
 * Convex row the subtask waits on in-process (like a run_command approval),
 * and the design files are kept in the worktree under .fhara/design/<key>/
 * (N.html + N.png + README.md, threadbear's docs/*-design pattern).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { wenv } from "@fhara/config/worker";
import type { Id } from "@/api/convex/_generated/dataModel";
import type { WorkerApi } from "@/workerApi";
import { resolveSandboxPath } from "@/tools/sandbox";
import { OPTIONS_REVIEW_LIMITS, isPurpose, type OptionsReviewPurpose } from "@/api/convex/lib/optionsReview";
import { MOCKUP_ASSET_MAX, formatFindings, prepareHtmlOption, type AssetResolver } from "./htmlPreview";
import { captureRoute, renderHtmlOption } from "./render";

export const SHOW_OPTIONS_TOOL_NAME = "show_options";

export const SHOW_OPTIONS_TOOL = {
  name: SHOW_OPTIONS_TOOL_NAME,
  description:
    'Ask the user to pick between options and WAIT for the answer (picks, a note per option, a reply). Arguments: {"title": what they choose, "note"?: short lead, "purpose"?: "design"|"architecture"|"schema"|"research"|"deploy"|"other", "route"?: app path the options are for, "recommended"?: option id, "options": [{"id":"A","title":"…","note":"trade-off","kind":"html"|"markdown"|"image","html"?: static HTML+CSS page (no scripts, no external URLs), "markdown"?: text/table, "path"?: image file in the workspace, "reference"?: true for context that cannot be picked}]}. 2-4 pickable options; a reference may also be {"kind":"route","reference":true} for a screenshot of today\'s screen.',
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      note: { type: "string" },
      purpose: { type: "string" },
      route: { type: "string" },
      recommended: { type: "string" },
      options: { type: "array" },
    },
    required: ["title", "options"],
  },
};

export const OPTIONS_REVIEW_TIMEOUT_MS = wenv("ORCHESTRATOR_OPTIONS_REVIEW_TIMEOUT_MS"); // read at module load
const POLL_MS = 2_000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export type ShowOptionsApi = Pick<
  WorkerApi,
  "optionReviewUploadUrl" | "createOptionReview" | "getOptionReview" | "cancelOptionReview"
>;

export interface ShowOptionsContext {
  api: ShowOptionsApi;
  taskId: string;
  projectId: string;
  subtaskKey: string;
  executionId?: string;
  agentId: string;
  role: string;
  workspaceRoot: string;
  /** Running app (loopback) for route references; absent = none. */
  qaBaseUrl?: string;
  signal?: AbortSignal;
  onPending?: (reviewId: string) => void;
  onWaiting?: () => void;
  holdClock?: () => () => void;
  /** Test seams. */
  render?: (html: string) => Promise<Buffer>;
  capture?: (baseUrl: string, route: string) => Promise<Buffer>;
  upload?: (png: Buffer, contentType: string) => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

export type ToolOutcome = { ok: boolean; text: string; isError: boolean; reviewId?: string };

type RawOption = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Default purpose by role: Designer reviews are design reviews. */
export function purposeFor(role: string, raw: unknown): OptionsReviewPurpose {
  if (isPurpose(raw)) return raw;
  const key = role.trim().toLowerCase();
  if (key === "designer" || key === "frontend") return "design";
  if (key === "cto") return "architecture";
  if (key === "backend") return "schema";
  if (key === "researcher") return "research";
  if (key === "devops") return "deploy";
  return "other";
}

/** `.fhara/design/<key>`; the folder ignores itself so it never reaches a diff. */
export function designDirFor(workspaceRoot: string, subtaskKey: string, create = true): string {
  const safe = subtaskKey.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60) || "review";
  const root = path.join(workspaceRoot, ".fhara");
  if (!create) return path.join(root, "design", safe);
  mkdirSync(path.join(root, "design", safe), { recursive: true });
  const ignore = path.join(root, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "# Fhara working files (design reviews); never committed.\n*\n");
  return path.join(root, "design", safe);
}

/** Files from the review's design folder only, inlined as data: URIs. */
export function designAssetResolver(designDir: string): AssetResolver {
  return (relative) => {
    const clean = relative.replace(/^\.\//, "");
    if (!clean || clean.includes("..") || path.isAbsolute(clean) || clean.includes("\\")) return { error: "only files inside the design folder" };
    const file = path.join(designDir, clean);
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()] ?? (path.extname(file).toLowerCase() === ".svg" ? "image/svg+xml" : undefined);
    if (!type) return { error: "not an image (png, jpeg, gif, webp, svg)" };
    if (!existsSync(file)) return { error: "file not found in the design folder" };
    const size = statSync(file).size;
    if (size > MOCKUP_ASSET_MAX) return { error: `larger than ${Math.round(MOCKUP_ASSET_MAX / 1000)} KB` };
    return { dataUri: `data:${type};base64,${readFileSync(file).toString("base64")}` };
  };
}

async function uploadWith(api: ShowOptionsApi, png: Buffer, contentType: string): Promise<string> {
  const url = await api.optionReviewUploadUrl();
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body: new Uint8Array(png) });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const json = (await res.json()) as { storageId?: string };
  if (!json.storageId) throw new Error("upload returned no storage id");
  return json.storageId;
}

type PreparedOption = {
  id: string;
  title: string;
  note?: string;
  reference?: boolean;
  kind: "html" | "image" | "markdown";
  html?: string;
  markdown?: string;
  imageStorageId?: Id<"_storage">;
  findings?: string[];
};

/**
 * Validate, sanitize, render and upload every option, store the review and
 * wait for the user's answer. Never throws: every problem is a tool result
 * the agent can act on.
 */
export async function runShowOptions(args: Record<string, unknown>, ctx: ShowOptionsContext): Promise<ToolOutcome> {
  const L = OPTIONS_REVIEW_LIMITS;
  const fail = (text: string): ToolOutcome => ({ ok: false, isError: true, text });
  const title = str(args.title);
  if (!title) return fail("title is required");
  const rawOptions = Array.isArray(args.options) ? (args.options as RawOption[]) : [];
  if (rawOptions.length === 0) return fail("options must be a non-empty list");
  if (rawOptions.length > L.optionsMax + L.referencesMax) return fail(`At most ${L.optionsMax} options plus ${L.referencesMax} references`);
  const route = str(args.route);
  const purpose = purposeFor(ctx.role, args.purpose);
  // Path only: nothing is written until every option passed validation.
  const designDir = designDirFor(ctx.workspaceRoot, ctx.subtaskKey, false);
  const resolveAsset = designAssetResolver(designDir);
  const render = ctx.render ?? ((html: string) => renderHtmlOption(html, { signal: ctx.signal }));
  const capture = ctx.capture ?? ((base: string, r: string) => captureRoute(base, r, { signal: ctx.signal }));
  const upload = ctx.upload ?? ((png: Buffer, type: string) => uploadWith(ctx.api, png, type));

  // Pass 1: validate everything first, so a bad last option leaves no review.
  const problems: string[] = [];
  const prepared: Array<PreparedOption & { png?: Buffer; imagePath?: string; captureRoute?: string }> = [];
  for (const [i, raw] of rawOptions.entries()) {
    if (!raw || typeof raw !== "object") {
      problems.push(`options[${i}] must be an object`);
      continue;
    }
    const id = str(raw.id) ?? String.fromCharCode(65 + i);
    const optionTitle = str(raw.title) ?? `Option ${id}`;
    const note = str(raw.note);
    const reference = raw.reference === true;
    const kind = str(raw.kind) ?? (raw.html ? "html" : raw.markdown ? "markdown" : raw.path ? "image" : "");
    const base = { id, title: optionTitle, ...(note ? { note } : {}), ...(reference ? { reference: true } : {}) };
    if (kind === "html") {
      const result = prepareHtmlOption(typeof raw.html === "string" ? raw.html : "", { resolveAsset });
      if (!result.ok) {
        problems.push(formatFindings(id, result.findings));
        continue;
      }
      prepared.push({ ...base, kind: "html", html: result.html, ...(result.warnings.length ? { findings: result.warnings } : {}) });
    } else if (kind === "markdown") {
      const markdown = str(raw.markdown);
      if (!markdown) problems.push(`Option ${id}: markdown is empty`);
      else if (markdown.length > L.markdownMax) problems.push(`Option ${id}: markdown is over ${L.markdownMax} characters`);
      else prepared.push({ ...base, kind: "markdown", markdown });
    } else if (kind === "image") {
      try {
        const file = resolveSandboxPath(ctx.workspaceRoot, String(raw.path ?? ""));
        const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
        if (!type) throw new Error("must be a PNG, JPEG, GIF or WebP file");
        if (!existsSync(file)) throw new Error("file not found");
        if (statSync(file).size > IMAGE_MAX_BYTES) throw new Error("larger than 5 MB");
        prepared.push({ ...base, kind: "image", imagePath: file });
      } catch (error) {
        problems.push(`Option ${id}: image ${error instanceof Error ? error.message : "is not readable"}`);
      }
    } else if (kind === "route" && reference) {
      if (!ctx.qaBaseUrl) continue; // no running app: the reference is skipped, not an error
      prepared.push({ ...base, kind: "image", captureRoute: str(raw.route) ?? route ?? "/" });
    } else {
      problems.push(`Option ${id}: kind must be html, markdown or image${reference ? " (or route for a reference)" : ""}`);
    }
  }
  if (problems.length) return fail(problems.join("\n\n"));
  const pickable = prepared.filter((o) => !o.reference);
  if (pickable.length === 0) return fail("Give at least one option the user can pick");
  if (pickable.length > L.optionsMax) return fail(`At most ${L.optionsMax} options`);
  const recommended = str(args.recommended);
  if (recommended && !pickable.some((o) => o.id === recommended)) return fail(`recommended must be one of: ${pickable.map((o) => o.id).join(", ")}`);

  // Pass 2: write the design files, render and upload pictures.
  designDirFor(ctx.workspaceRoot, ctx.subtaskKey);
  const warnings: string[] = [];
  for (const option of prepared) {
    try {
      if (option.kind === "html" && option.html) {
        writeFileSync(path.join(designDir, `${option.id}.html`), option.html);
        option.png = await render(option.html);
        writeFileSync(path.join(designDir, `${option.id}.png`), option.png);
      } else if (option.imagePath) {
        option.png = readFileSync(option.imagePath);
      } else if (option.captureRoute && ctx.qaBaseUrl) {
        option.png = await capture(ctx.qaBaseUrl, option.captureRoute);
        writeFileSync(path.join(designDir, `${option.id}.png`), option.png);
      }
      if (option.png) {
        const type = option.imagePath ? IMAGE_TYPES[path.extname(option.imagePath).toLowerCase()] : "image/png";
        option.imageStorageId = (await upload(option.png, type)) as Id<"_storage">;
      }
    } catch (error) {
      if (ctx.signal?.aborted) return fail("Task stopped while the options were prepared");
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      if (option.kind === "image" && !option.captureRoute) return fail(`Option ${option.id}: image upload failed (${reason})`);
      warnings.push(`Option ${option.id}: no picture (${reason}); the card shows the live sandboxed preview instead`);
    }
  }
  const usable = prepared.filter((o) => o.kind !== "image" || o.imageStorageId);
  writeFileSync(
    path.join(designDir, "README.md"),
    [
      `# ${title}`,
      "",
      `Options review (${purpose}) for subtask ${ctx.subtaskKey}${route ? `, route ${route}` : ""}.`,
      "Sanitized pages and their renders; written by Fhara, ignored by git.",
      "",
      ...usable.map((o) => `- ${o.id}${o.reference ? " (reference)" : ""}${o.id === recommended ? " (recommended)" : ""}: ${o.title}${o.note ? ` — ${o.note}` : ""}`),
      "",
    ].join("\n")
  );

  let created: Awaited<ReturnType<ShowOptionsApi["createOptionReview"]>>;
  try {
    created = await ctx.api.createOptionReview({
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      subtaskKey: ctx.subtaskKey,
      ...(ctx.executionId ? { executionId: ctx.executionId } : {}),
      agentId: ctx.agentId,
      role: ctx.role,
      purpose,
      title,
      ...(str(args.note) ? { note: str(args.note) } : {}),
      ...(route ? { route } : {}),
      ...(recommended ? { recommended } : {}),
      options: usable.map(({ png: _png, imagePath: _p, captureRoute: _c, ...o }) => o),
    });
  } catch (error) {
    return fail(`The review could not be stored: ${error instanceof Error ? error.message : String(error)}`);
  }
  const suffix = warnings.length ? `\n\nNotes from Fhara:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
  if (created.status === "auto") return { ok: true, isError: false, reviewId: created.reviewId, text: `${created.replyText ?? "Recommended option picked automatically."}${suffix}` };
  ctx.onPending?.(created.reviewId);
  const release = ctx.holdClock?.();
  try {
    const answer = await waitForAnswer(ctx, created.reviewId);
    return { ...answer, reviewId: created.reviewId, text: `${answer.text}${suffix}` };
  } finally {
    release?.();
  }
}

async function waitForAnswer(ctx: ShowOptionsContext, reviewId: string): Promise<ToolOutcome> {
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? defaultSleep;
  const timeoutMs = ctx.timeoutMs ?? OPTIONS_REVIEW_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const giveUp = async (reason: string, text: string): Promise<ToolOutcome> => {
    await ctx.api.cancelOptionReview({ reviewId, reason }).catch(() => undefined);
    return { ok: false, isError: true, text };
  };
  for (;;) {
    if (ctx.signal?.aborted) return giveUp("Task stopped", "The task was stopped while the review waited for the user.");
    if (now() >= deadline) {
      return giveUp(
        "No answer in time",
        `The user did not answer within ${Math.round(timeoutMs / 60_000)} min. Write your result for the recommended option, and say plainly that the user has not confirmed it.`
      );
    }
    let row: Awaited<ReturnType<ShowOptionsApi["getOptionReview"]>> = null;
    try {
      row = await ctx.api.getOptionReview({ reviewId });
    } catch {
      row = null; // transient
    }
    if (row) {
      if ((row.status === "answered" || row.status === "auto") && row.replyText) return { ok: true, isError: false, text: row.replyText };
      if (row.status === "cancelled") return { ok: false, isError: true, text: `The review was cancelled (${row.cancelReason ?? "no reason"}).` };
      if (row.taskStatus && ["done", "failed", "rejected", "cancelled"].includes(row.taskStatus)) {
        return giveUp(`Task is ${row.taskStatus}`, `The task is ${row.taskStatus}.`);
      }
    }
    ctx.onWaiting?.();
    await sleep(POLL_MS, ctx.signal);
  }
}
