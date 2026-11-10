/**
 * Builds apps/api/convex/lib/skillCatalog.json, the bundled catalog the
 * Library "Browse" tab falls back to when no refreshed copy is stored.
 *
 *   npm run catalog:build                      # read every index from GitHub
 *   npm run catalog:build -- --local khasky/awesome-agent-skills=../ref/awesome-agent-skills
 *
 * --local reads an index (and its SKILL.md front matter, for license and
 * author) from a clone instead of the network. GITHUB_TOKEN is used for
 * the API calls when set.
 *
 * Catalog metadata follows each index's own license: entries from an
 * index without a license keep only name, repo and path (no copied
 * description). Attribution lives in THIRD_PARTY_NOTICES.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontMatter } from "../apps/api/convex/lib/githubSkills";
import { parseSkillIndex, type BundledCatalog, type CatalogEntry, type CatalogSource } from "../apps/api/convex/lib/skillCatalog";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps/api/convex/lib/skillCatalog.json");

const SOURCES: CatalogSource[] = [
  {
    repo: "khasky/awesome-agent-skills",
    file: "README.md",
    section: "Skills",
    license: "MIT",
    attribution: "Awesome Agent Skills by Khasky (MIT)",
  },
  {
    repo: "huanngzh/oh-my-skills",
    file: "README.md",
    section: "Skills",
    category: "Workflow",
    license: null,
    attribution: "oh-my-skills by huanngzh (no license; names and paths only)",
  },
];

function argLocal(): Map<string, string> {
  const map = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--local") continue;
    const [repo, dir] = (argv[++i] ?? "").split("=");
    if (repo && dir) map.set(repo.toLowerCase(), resolve(dir));
  }
  return map;
}

async function github<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "Fhara-skill-catalog" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return (await res.json()) as T;
}

async function rawText(repo: string, sha: string, path: string): Promise<string | null> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`);
  return res.ok ? await res.text() : null;
}

/** license / author from a SKILL.md front matter (`metadata.author` is nested, kept raw by the parser). */
function frontMatterMeta(text: string | null): { license?: string; author?: string } {
  if (!text) return {};
  const { data } = parseFrontMatter(text);
  const license = data.license?.trim();
  const author = data.author?.trim() || /(?:^|\n)\s*author:\s*["']?([^"'\n]+)/.exec(data.metadata ?? "")?.[1]?.trim();
  return { ...(license ? { license } : {}), ...(author ? { author } : {}) };
}

async function main() {
  const local = argLocal();
  const sources: BundledCatalog["sources"] = [];
  let total = 0;
  for (const source of SOURCES) {
    const dir = local.get(source.repo.toLowerCase());
    let readme: string;
    let sha: string | null = null;
    let ref: string | undefined;
    let readSkill: (path: string) => Promise<string | null>;
    if (dir) {
      readme = readFileSync(join(dir, source.file), "utf8");
      try {
        sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const head = execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
          encoding: "utf8",
        }).trim();
        ref = head.replace(/^origin\//, "") || undefined;
      } catch {
        // Not a git clone (or no origin/HEAD): sha / ref stay unknown.
      }
      readSkill = async (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null);
    } else {
      const meta = await github<{ default_branch: string }>(`/repos/${source.repo}`);
      ref = meta.default_branch;
      sha = (await github<{ sha: string }>(`/repos/${source.repo}/commits/${encodeURIComponent(ref)}`)).sha;
      const text = await rawText(source.repo, sha, source.file);
      if (text === null) throw new Error(`${source.repo}/${source.file} not found`);
      readme = text;
      readSkill = (path) => rawText(source.repo, sha!, path);
    }
    const parsed = parseSkillIndex(readme, {
      indexRepo: source.repo,
      ref,
      section: source.section,
      category: source.category,
      license: source.license,
    });
    const entries: CatalogEntry[] = [];
    for (const entry of parsed) {
      if (entry.repo.toLowerCase() === source.repo.toLowerCase()) {
        const meta = frontMatterMeta(await readSkill(entry.path));
        if (meta.license) entry.license = meta.license;
        if (meta.author) entry.author = meta.author;
      }
      // No license on the index: keep facts only, not its prose.
      if (!source.license) entry.description = "";
      entries.push(entry);
    }
    sources.push({ ...source, sha, entries });
    total += entries.length;
    console.log(`${source.repo}: ${parsed.length} skills${sha ? ` at ${sha.slice(0, 7)}` : ""}`);
  }
  const catalog: BundledCatalog = { generatedAt: new Date().toISOString().slice(0, 10), sources };
  writeFileSync(OUT, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`wrote ${total} entries to ${OUT.slice(ROOT.length + 1)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
