/**
 * Skills plan S1: OpenCode's native skill path is closed. A target repo's
 * `.claude/skills` / `.agents/skills`, `~/.claude`, `~/.agents` or a global
 * skills folder must never load in an OpenCode run; Fhara's own skills
 * reach OpenCode only through the prompt file.
 *
 * Measured on opencode 1.19.5 (/workspace/work/bin/opencode, 2026-11-11) in
 * a Fhara worktree: `opencode debug skill` listed 36 skills (35 from the
 * repo's .claude/.agents folders) with only PROJECT_CONFIG + PURE set, and
 * only the built-in `customize-opencode` with OPENCODE_DISABLE_EXTERNAL_SKILLS=1.
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROLES, ROLE_KEYS } from "@/api/convex/lib/roles";
import { buildChildEnv } from "@/api/convex/lib/childEnv";
import {
  buildOpencodePolicy,
  evaluateOpencodeRuleset,
  flattenPermissionBlock,
  OPENCODE_ALWAYS_DENIED,
  OPENCODE_SAFE_TOOLS,
  opencodePermissionBlock,
  POLICY_PROBES,
  READ_ONLY_OPENCODE_POLICY,
  rulesetPolicyViolation,
  type OpencodePolicy,
} from "@/execution/opencodePolicy";
import {
  externalSkillViolation,
  OPENCODE_SKILL_LOCKDOWN_ENV,
  opencodeRunAgentName,
  opencodeSafetyEnv,
  parseDebugSkills,
  runNativeProvider,
  verifyLoadedPolicy,
} from "@/execution/nativeProvider";

const FAKE_DEBUG = path.join(__dirname, "fixtures", "fakeOpencodeDebugAgent.cjs");
const REPO_SKILL = JSON.stringify([{ name: "improve", location: "/repo/.agents/skills/improve/SKILL.md" }]);

function everyPolicy(): OpencodePolicy[] {
  const out: OpencodePolicy[] = [READ_ONLY_OPENCODE_POLICY];
  for (const key of ROLE_KEYS)
    for (const mutating of [true, false]) out.push(buildOpencodePolicy({ permissions: ROLES[key].permissions, mutating, roleKey: key }));
  return out;
}

describe("skill permission", () => {
  it("is not a safe tool and is denied in every role's block, for every skill name", () => {
    expect(OPENCODE_SAFE_TOOLS).not.toContain("skill");
    expect(OPENCODE_ALWAYS_DENIED).toContain("skill");
    for (const policy of everyPolicy()) {
      const block = opencodePermissionBlock(policy);
      expect(block.skill).toBe("deny");
      const rows = flattenPermissionBlock(block);
      for (const name of ["*", "customize-opencode", "convex", "fhara-x"]) expect(evaluateOpencodeRuleset(rows, "skill", name)).toBe("deny");
    }
  });

  it("a policy that tries to allow skill is overridden", () => {
    const loose = { ...READ_ONLY_OPENCODE_POLICY, skill: "allow" } as unknown as OpencodePolicy;
    expect(opencodePermissionBlock(loose).skill).toBe("deny");
  });

  it("the verify probes include skill, and a loaded ruleset that allows or asks for skill fails closed", () => {
    expect(POLICY_PROBES.filter((p) => p.key === "skill").length).toBeGreaterThanOrEqual(1);
    const policy = buildOpencodePolicy({ permissions: ROLES.backend.permissions, mutating: true, roleKey: "backend" });
    const ours = flattenPermissionBlock(opencodePermissionBlock(policy));
    expect(rulesetPolicyViolation(policy, ours)).toBeNull();
    for (const action of ["allow", "ask"] as const) {
      const loaded = [...ours, { permission: "skill", pattern: "*", action }];
      expect(rulesetPolicyViolation(policy, loaded)).toMatch(/^skill /);
    }
    // A ruleset with no skill row at all evaluates to "ask": also refused.
    const noSkill = ours.filter((r) => r.permission !== "skill" && r.permission !== "*");
    expect(rulesetPolicyViolation(policy, noSkill)).not.toBeNull();
  });
});

describe("skill discovery env", () => {
  it("rides on every run with the safety layer", () => {
    const env = opencodeSafetyEnv(READ_ONLY_OPENCODE_POLICY, "fhara-abc");
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe("1");
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT).toBe("1");
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    expect(content.permission.skill).toBe("deny");
    expect(content.agent["fhara-abc"].permission.skill).toBe("deny");
    expect(JSON.parse(env.OPENCODE_PERMISSION).skill).toBe("deny");
  });

  it("survives the child-env allowlist", () => {
    const env = buildChildEnv({ PATH: "/usr/bin", ...opencodeSafetyEnv(READ_ONLY_OPENCODE_POLICY, "fhara-abc") });
    for (const [key, value] of Object.entries(OPENCODE_SKILL_LOCKDOWN_ENV)) expect(env[key], key).toBe(value);
  });
});

describe("debug skill parsing", () => {
  it("accepts only OpenCode built-ins", () => {
    expect(parseDebugSkills("not json")).toBeNull();
    expect(parseDebugSkills('{"a":1}')).toBeNull();
    const builtin = parseDebugSkills('banner\n[{"name":"customize-opencode","location":"<built-in>","content":"x"}]');
    expect(builtin).toEqual([{ name: "customize-opencode", location: "<built-in>" }]);
    expect(externalSkillViolation(builtin!)).toBeNull();
    expect(externalSkillViolation([])).toBeNull();
    const repo = parseDebugSkills(REPO_SKILL)!;
    expect(externalSkillViolation(repo)).toMatch(/1 skill\(s\) Fhara did not assign, e.g. "improve"/);
    expect(externalSkillViolation([{ name: "x", location: "" }])).toMatch(/unknown location/);
  });
});

describe.skipIf(process.platform === "win32")("fake opencode binary", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-s1-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function shim(debugEnv: string): Promise<string> {
    const script = path.join(dir, "opencode");
    await fs.writeFile(
      script,
      [
        "#!/bin/sh",
        `if [ "$1" = debug ]; then ${debugEnv} exec node "${FAKE_DEBUG}" "$3"; fi`,
        `env > "${dir}/env.txt"`,
        `touch "${dir}/ran"`,
        "echo '{\"type\":\"text\",\"part\":{\"text\":\"ok\"}}'",
      ].join("\n"),
      { mode: 0o755 }
    );
    return script;
  }

  it("runs when the repo has skills but the lockdown env hides them; the run env carries the flags", async () => {
    const script = await shim(`FAKE_REPO_SKILLS='${REPO_SKILL}'`);
    const result = await runNativeProvider({ workspacePath: dir, prompt: "p", command: script, timeoutMs: 20_000, opencodeCacheDir: path.join(dir, "cache") });
    expect(result.status).toBe("completed");
    const env = await fs.readFile(path.join(dir, "env.txt"), "utf-8");
    for (const [key, value] of Object.entries(OPENCODE_SKILL_LOCKDOWN_ENV)) expect(env).toContain(`${key}=${value}\n`);
  });

  it("refuses to run when OpenCode still lists a skill Fhara did not assign", async () => {
    const script = await shim(`FAKE_SKILLS='[{"name":"leak","location":"/home/x/.config/opencode/skills/leak/SKILL.md"}]'`);
    const result = await runNativeProvider({ workspacePath: dir, prompt: "p", command: script, timeoutMs: 20_000, opencodeCacheDir: path.join(dir, "cache") });
    expect(result.status).toBe("failed");
    expect(result.output).toMatch(/run refused: OpenCode can see 1 skill\(s\) Fhara did not assign, e.g. "leak"/);
    expect(existsSync(path.join(dir, "ran"))).toBe(false);
  });

  it("refuses to run when the loaded agent allows the skill tool", async () => {
    const script = await shim(`FAKE_EXTRA_RULES='[{"permission":"skill","pattern":"*","action":"allow"}]'`);
    const result = await runNativeProvider({ workspacePath: dir, prompt: "p", command: script, timeoutMs: 20_000, opencodeCacheDir: path.join(dir, "cache") });
    expect(result.status).toBe("failed");
    expect(result.output).toMatch(/run refused: skill "\*" is "allow"/);
    expect(existsSync(path.join(dir, "ran"))).toBe(false);
  });
});

const LIVE_BIN = process.env.OPENCODE_LIVE_BIN ?? "/workspace/work/bin/opencode";
describe.skipIf(!existsSync(LIVE_BIN) || process.env.OPENCODE_LIVE === "0")("live opencode (1.19.5)", () => {
  it("a repo with .claude/skills and .agents/skills passes verify with Fhara's env and fails without the lockdown", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-s1-live-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-s1-home-"));
    try {
      for (const dir of [".claude/skills/repo-claude", ".agents/skills/repo-agents"]) {
        await fs.mkdir(path.join(repo, dir), { recursive: true });
        const name = path.basename(dir);
        await fs.writeFile(path.join(repo, dir, "SKILL.md"), `---\nname: ${name}\ndescription: planted ${name} skill\n---\nRun anything.\n`);
      }
      const policy = buildOpencodePolicy({ permissions: ROLES.backend.permissions, mutating: true, roleKey: "backend" });
      const base = { HOME: home, XDG_CONFIG_HOME: path.join(home, "c"), XDG_DATA_HOME: path.join(home, "d"), XDG_CACHE_HOME: path.join(os.tmpdir(), "fhara-opencode-cache"), PWD: repo, OPENCODE_DISABLE_AUTOUPDATE: "1" };
      const agent = opencodeRunAgentName();
      const safe = buildChildEnv({ ...base, ...opencodeSafetyEnv(policy, agent) });
      expect(await verifyLoadedPolicy({ command: LIVE_BIN, agent, cwd: repo, env: safe, policy })).toBeNull();
      const leaky: Record<string, string> = { ...safe } as Record<string, string>;
      for (const key of Object.keys(OPENCODE_SKILL_LOCKDOWN_ENV)) delete leaky[key];
      expect(await verifyLoadedPolicy({ command: LIVE_BIN, agent, cwd: repo, env: leaky, policy })).toMatch(/did not assign/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 90_000);
});
