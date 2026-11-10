import { action, internalMutation, internalQuery, query, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertRegistryWriteAccess } from "./lib/authz";
import { recordAudit } from "./lib/recordAudit";
import { SKILL_STORED_MAX, validateSkillInput } from "./lib/skills";
import { normalizeSkillPermissions } from "./lib/skillGraph";
import { fitSkillBody, githubFileUrls, isSkillPath, parseSkillMarkdown } from "./lib/githubSkills";
import { GithubClient, GithubImportError, mapLimit } from "./lib/githubSkillsApi";
import {
  catalogKey,
  importedContentMatches,
  parseSkillIndex,
  type BundledCatalog,
  type CatalogEntry,
  type UpdateCheck,
} from "./lib/skillCatalog";
import bundledJson from "./lib/skillCatalog.json";

/**
 * Skill marketplace (Library → Browse). The catalog is the bundled
 * lib/skillCatalog.json (scripts/build-skill-catalog.ts), replaced per
 * index by a refreshed copy in `skillCatalogs` once "Refresh catalog"
 * has run. Installing goes through skills.previewGithubImport /
 * skills.importFromGithub; updating through skills.updateFromSource.
 */

const bundled = bundledJson as BundledCatalog;

/** Entries in each check are capped so one click stays a few dozen GitHub calls. */
const UPDATE_CHECK_MAX = 60;
const PREVIEW_MAX_CHARS = 200_000;

const entryValidator = v.object({
  name: v.string(),
  description: v.string(),
  category: v.string(),
  repo: v.string(),
  path: v.string(),
  ref: v.optional(v.string()),
  license: v.union(v.string(), v.null()),
  author: v.union(v.string(), v.null()),
});

export type CatalogView = {
  entries: Array<CatalogEntry & { source: string }>;
  sources: Array<{
    repo: string;
    attribution: string;
    license: string | null;
    sha: string | null;
    origin: "bundled" | "refreshed";
    fetchedAt: number | null;
  }>;
  bundledAt: string;
};

/** The catalog: refreshed copy per index where one is stored, else the bundled JSON. */
export const get = query({
  args: {},
  handler: async (ctx): Promise<CatalogView> => {
    const stored = await ctx.db.query("skillCatalogs").collect();
    const byRepo = new Map(stored.map((row) => [row.source.toLowerCase(), row]));
    const entries: CatalogView["entries"] = [];
    const sources: CatalogView["sources"] = [];
    const seen = new Set<string>();
    for (const source of bundled.sources) {
      const row = byRepo.get(source.repo.toLowerCase());
      const list: CatalogEntry[] = row ? row.entries : source.entries;
      for (const e of list) {
        const key = catalogKey(e.repo, e.path);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ ...e, source: source.repo });
      }
      sources.push({
        repo: source.repo,
        attribution: source.attribution,
        license: row ? (row.license ?? null) : source.license,
        sha: row ? row.sha : source.sha,
        origin: row ? "refreshed" : "bundled",
        fetchedAt: row ? row.fetchedAt : null,
      });
    }
    return { entries, sources, bundledAt: bundled.generatedAt };
  },
});

export const store = internalMutation({
  args: {
    source: v.string(),
    sha: v.string(),
    ref: v.string(),
    license: v.optional(v.string()),
    entries: v.array(entryValidator),
  },
  handler: async (ctx, args) => {
    await assertRegistryWriteAccess(ctx);
    const existing = await ctx.db
      .query("skillCatalogs")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .first();
    const row = { ...args, fetchedAt: Date.now() };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("skillCatalogs", row);
    await recordAudit(ctx, {
      action: "skill.catalog_refresh",
      tool: "github",
      target: args.source,
      details: { sha: args.sha, entries: args.entries.length },
    });
  },
});

async function githubClient(ctx: ActionCtx): Promise<GithubClient> {
  const token: string | null = await ctx.runQuery(internal.skills.githubTokenForImport, {});
  return new GithubClient(token ?? undefined);
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof GithubImportError || err instanceof Error ? err.message : fallback;
}

/**
 * "Refresh catalog": re-read every index at its default branch with the
 * account GitHub token (anonymous when none), store the parsed entries.
 * An index that fails or parses to nothing keeps its current copy.
 */
export const refresh = action({
  args: {},
  handler: async (
    ctx
  ): Promise<{ refreshed: Array<{ repo: string; sha: string; entries: number }>; failed: Array<{ repo: string; error: string }> }> => {
    const client = await githubClient(ctx);
    const refreshed: Array<{ repo: string; sha: string; entries: number }> = [];
    const failed: Array<{ repo: string; error: string }> = [];
    for (const source of bundled.sources) {
      try {
        const meta = await client.json<{ full_name: string; default_branch: string; private: boolean }>(
          `/repos/${source.repo}`,
          "Catalog repository"
        );
        const [owner, repo] = meta!.full_name.split("/");
        const ref = meta!.default_branch;
        const commit = await client.json<{ sha: string }>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, "Catalog branch");
        const lic = await client.json<{ license?: { spdx_id?: string } | null }>(`/repos/${owner}/${repo}/license`, "License", {
          allow404: true,
        });
        const spdx = lic?.license?.spdx_id;
        const license = spdx ? (spdx === "NOASSERTION" ? "Other" : spdx) : source.license;
        const text = await client.fileText(owner, repo, commit!.sha, source.file, meta!.private);
        // Per-skill license/author from the bundled copy (read from each
        // SKILL.md front matter at build time) when the entry is still there.
        const known = new Map(source.entries.map((e) => [catalogKey(e.repo, e.path), e]));
        const entries = parseSkillIndex(text, {
          indexRepo: source.repo,
          ref,
          section: source.section,
          category: source.category,
          license,
        }).map((e) => {
          const prior = known.get(catalogKey(e.repo, e.path));
          return {
            ...e,
            license: prior?.license ?? e.license,
            author: prior?.author ?? e.author,
            // An index without a license contributes facts only, not prose.
            description: license ? e.description : "",
          };
        });
        if (entries.length === 0) {
          failed.push({ repo: source.repo, error: `No skills found in ${source.file}; kept the current list` });
          continue;
        }
        await ctx.runMutation(internal.skillCatalog.store, {
          source: source.repo,
          sha: commit!.sha,
          ref,
          ...(license ? { license } : {}),
          entries,
        });
        refreshed.push({ repo: source.repo, sha: commit!.sha, entries: entries.length });
      } catch (err) {
        failed.push({ repo: source.repo, error: messageOf(err, "Could not read the catalog") });
      }
    }
    return { refreshed, failed };
  },
});

/** SKILL.md text for the Browse detail panel, read at the entry's branch (default branch when unset). */
export const readSkillFile = action({
  args: { repo: v.string(), path: v.string(), ref: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ text: string; truncated: boolean; url: string }> => {
    const [owner, repo, extra] = args.repo.split("/");
    if (!owner || !repo || extra !== undefined || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error("Use owner/repo");
    }
    if (!isSkillPath(args.path)) throw new Error("Not a SKILL.md path");
    const ref = args.ref && /^[A-Za-z0-9_./-]+$/.test(args.ref) && !args.ref.includes("..") ? args.ref : "HEAD";
    const client = await githubClient(ctx);
    const text = await client.fileText(owner, repo, ref, args.path, false);
    return {
      text: text.slice(0, PREVIEW_MAX_CHARS),
      truncated: text.length > PREVIEW_MAX_CHARS,
      url: githubFileUrls(owner, repo, ref, args.path).html,
    };
  },
});

type SourcedRow = {
  _id: Id<"skills">;
  repo: string;
  path: string;
  sha: string;
  instructions: string;
  description: string;
  permissions: string[];
};

export const sourcedSkills = internalQuery({
  args: { skillIds: v.array(v.id("skills")) },
  handler: async (ctx, args): Promise<SourcedRow[]> => {
    const rows: SourcedRow[] = [];
    for (const id of args.skillIds) {
      const skill = await ctx.db.get(id);
      if (!skill || skill.source?.kind !== "github") continue;
      rows.push({
        _id: skill._id,
        repo: skill.source.repo,
        path: skill.source.path,
        sha: skill.source.sha,
        instructions: skill.instructions,
        description: skill.description,
        permissions: skill.permissions ?? [],
      });
    }
    return rows;
  },
});

/**
 * Update check for imported skills: per repo, the default-branch commit;
 * a skill whose stored commit differs is read again and compared the way
 * applyGithubImport decides "unchanged" (content, ignoring the commit).
 * "update" means updateFromSource would write a new version.
 */
export const checkUpdates = action({
  args: { skillIds: v.array(v.id("skills")) },
  handler: async (ctx, args): Promise<Record<string, UpdateCheck>> => {
    const ids = Array.from(new Set(args.skillIds)).slice(0, UPDATE_CHECK_MAX);
    const rows: SourcedRow[] = await ctx.runQuery(internal.skillCatalog.sourcedSkills, { skillIds: ids });
    const client = await githubClient(ctx);
    const byRepo = new Map<string, SourcedRow[]>();
    for (const row of rows) {
      const key = row.repo.toLowerCase();
      byRepo.set(key, [...(byRepo.get(key) ?? []), row]);
    }
    const out: Record<string, UpdateCheck> = {};
    for (const list of byRepo.values()) {
      let head: { owner: string; repo: string; sha: string; isPrivate: boolean };
      try {
        const meta = await client.json<{ full_name: string; default_branch: string; private: boolean }>(
          `/repos/${list[0].repo}`,
          "Repository"
        );
        const [owner, repo] = meta!.full_name.split("/");
        const commit = await client.json<{ sha: string }>(
          `/repos/${owner}/${repo}/commits/${encodeURIComponent(meta!.default_branch)}`,
          "Default branch"
        );
        head = { owner, repo, sha: commit!.sha, isPrivate: meta!.private };
      } catch {
        for (const row of list) out[row._id] = "error";
        continue;
      }
      await mapLimit(list, 6, async (row) => {
        if (row.sha === head.sha) {
          out[row._id] = "current";
          return;
        }
        let text: string;
        try {
          text = await client.fileText(head.owner, head.repo, head.sha, row.path, head.isPrivate);
        } catch (err) {
          out[row._id] = err instanceof GithubImportError && err.code === "not_found" ? "missing" : "error";
          return;
        }
        const parsed = parseSkillMarkdown(text, row.path, head.repo);
        const url = githubFileUrls(head.owner, head.repo, head.sha, row.path).html;
        let clean: ReturnType<typeof validateSkillInput>;
        try {
          clean = validateSkillInput(
            { description: parsed.description, instructions: fitSkillBody(parsed.body, SKILL_STORED_MAX, url).text },
            { instructionsMax: SKILL_STORED_MAX }
          );
        } catch {
          out[row._id] = "error";
          return;
        }
        const same = importedContentMatches(
          row,
          {
            sha: head.sha,
            instructions: clean.instructions!,
            description: clean.description ?? "",
            permissions: normalizeSkillPermissions(parsed.permissions),
          },
          { ignoreSha: true }
        );
        out[row._id] = same ? "current" : "update";
      });
    }
    return out;
  },
});
