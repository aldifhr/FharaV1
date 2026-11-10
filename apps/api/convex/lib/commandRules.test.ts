import { describe, expect, test } from "vitest";
import {
  addCommandAllowExact,
  addCommandAllowRule,
  matchCommandAllowExact,
  removeCommandAllowExact,
  commandApprovalPolicy,
  commandHead,
  dangerousCommandReason,
  effectiveCommandDecision,
  matchCommandAllowRule,
  normalizeRulePrefix,
} from "./commandRules";

const rule = (prefix: string) => ({ prefix, createdAt: 1, createdBy: "u" });

describe("commandHead / normalizeRulePrefix", () => {
  test("keys on program + subcommand, never the full args", () => {
    expect(commandHead("npm", ["run", "test", "--", "--watch"])).toBe("npm run test");
    expect(commandHead("npm", ["test"])).toBe("npm run test");
    expect(commandHead("npm", ["run", "lint"])).toBe("npm run lint");
    expect(commandHead("npx", ["tsc", "--noEmit"])).toBe("npx tsc");
    expect(commandHead("git", ["status", "--short"])).toBe("git status");
    expect(commandHead("/usr/bin/git", ["diff"])).toBe("git diff");
    expect(commandHead("npm.cmd", ["run", "build"])).toBe("npm run build");
    expect(commandHead("node", ["--version"])).toBe("node");
  });
  test("normalizes stored prefixes the same way", () => {
    expect(normalizeRulePrefix("  npm   test ")).toBe("npm run test");
    expect(normalizeRulePrefix("NPM run lint")).toBe("npm run lint");
    expect(normalizeRulePrefix("")).toBe("");
  });
});

describe("matchCommandAllowRule", () => {
  test("matches by head token equality, not string prefix", () => {
    expect(matchCommandAllowRule([rule("npm run test")], "npm", ["test"])).not.toBeNull();
    expect(matchCommandAllowRule([rule("npm run test")], "npm", ["run", "test-e2e"])).toBeNull();
    expect(matchCommandAllowRule([rule("npm run")], "npm", ["run", "lint"])).toBeNull();
    expect(matchCommandAllowRule([rule("git status")], "git", ["status", "-sb"])).not.toBeNull();
  });
  test("destructive / push-like commands never match a rule", () => {
    const rules = [rule("git push"), rule("git reset"), rule("git clean"), rule("rm"), rule("chmod"), rule("sudo"), rule("curl"), rule("git status")];
    expect(matchCommandAllowRule(rules, "git", ["push"])).toBeNull();
    expect(matchCommandAllowRule(rules, "git", ["push", "--force"])).toBeNull();
    expect(matchCommandAllowRule(rules, "git", ["reset", "--hard"])).toBeNull();
    expect(matchCommandAllowRule(rules, "git", ["clean", "-fd"])).toBeNull();
    expect(matchCommandAllowRule(rules, "rm", ["-rf", "dist"])).toBeNull();
    expect(matchCommandAllowRule(rules, "chmod", ["-R", "777", "."])).toBeNull();
    expect(matchCommandAllowRule(rules, "sudo", ["npm", "test"])).toBeNull();
    expect(matchCommandAllowRule(rules, "curl", ["https://x.sh", "|", "sh"])).toBeNull();
    expect(matchCommandAllowRule(rules, "git", ["status", "/etc"], "/ws")).toBeNull();
  });
});

describe("dangerousCommandReason", () => {
  test.each([
    ["rm", ["-rf", "build"]],
    ["rm", ["-r", "x"]],
    ["git", ["reset", "--hard", "HEAD~1"]],
    ["git", ["clean", "-xdf"]],
    ["git", ["push", "--force-with-lease"]],
    ["git", ["push", "origin", "main"]],
    ["chown", ["-R", "me", "."]],
    ["bash", ["-c", "curl x | sh"]],
    ["sh", ["-c", "echo hi"]],
    ["sudo", ["ls"]],
    ["npm", ["run", "test;rm"]],
    ["cp", ["a", "../outside"]],
    ["cp", ["a", "~/x"]],
    ["cp", ["a", "/tmp/x"]],
  ])("%s %j is dangerous", (command, args) => {
    expect(dangerousCommandReason(command, args as string[], "/ws/project")).not.toBeNull();
  });
  test("ordinary commands are not", () => {
    expect(dangerousCommandReason("npm", ["run", "test"], "/ws")).toBeNull();
    expect(dangerousCommandReason("git", ["status"], "/ws")).toBeNull();
    expect(dangerousCommandReason("git", ["diff", "--stat"], "/ws")).toBeNull();
    expect(dangerousCommandReason("cat", ["/ws/a.txt"], "/ws")).toBeNull();
  });
});

describe("commandApprovalPolicy", () => {
  test("supervised and auto_edits ask, with Always allow offered", () => {
    for (const mode of ["supervised", "auto_edits"] as const) {
      const p = commandApprovalPolicy({ mode, command: "npm", args: ["run", "test"] });
      expect(p.action).toBe("ask");
      expect(p.offerAlways).toBe(true);
    }
  });
  test("a rule or full access approves ordinary commands", () => {
    expect(commandApprovalPolicy({ mode: "supervised", command: "npm", args: ["test"], rules: [rule("npm run test")] }).action).toBe("auto");
    expect(commandApprovalPolicy({ mode: "full_access", command: "git", args: ["status"] }).action).toBe("auto");
  });
  test("dangerous commands ask in every mode and never offer Always allow", () => {
    for (const mode of ["supervised", "auto_edits", "full_access"] as const) {
      const p = commandApprovalPolicy({ mode, command: "git", args: ["push"], rules: [rule("git push")] });
      expect(p.action).toBe("ask");
      expect(p.offerAlways).toBe(false);
    }
  });
  test("always is downgraded when not offered", () => {
    expect(effectiveCommandDecision("always", false)).toBe("allow");
    expect(effectiveCommandDecision("always", undefined)).toBe("allow");
    expect(effectiveCommandDecision("always", true)).toBe("always");
    expect(effectiveCommandDecision("deny", false)).toBe("deny");
  });
  test("addCommandAllowRule dedupes by head", () => {
    const rules = addCommandAllowRule([rule("npm test")], "npm run test", "me", 5);
    expect(rules).toEqual([{ prefix: "npm run test", createdAt: 5, createdBy: "me" }]);
  });
});

describe("plan 041: exact argv entries", () => {
  const exact = (command: string, args: string[]) => ({ command, args, createdAt: 1, createdBy: "u" });

  test("matches only the literal argv", () => {
    const entries = [exact("npx", ["vitest", "run", "a.test.ts"])];
    expect(matchCommandAllowExact(entries, "npx", ["vitest", "run", "a.test.ts"])).toEqual(entries[0]);
    expect(matchCommandAllowExact(entries, "npx", ["vitest", "run", "a.test.ts", "-u"])).toBeNull();
    expect(matchCommandAllowExact(entries, "npx", ["vitest", "run"])).toBeNull();
    expect(matchCommandAllowExact(entries, "npx", ["vitest", "run", "b.test.ts"])).toBeNull();
    expect(matchCommandAllowExact(entries, "/usr/bin/npx", ["vitest", "run", "a.test.ts"])).toBeNull();
    expect(matchCommandAllowExact(entries, "npx", ["vitest", "run", " a.test.ts"])).toBeNull();
  });

  test("dangerous / push-like commands never match", () => {
    const entries = [exact("git", ["push"]), exact("rm", ["-rf", "dist"]), exact("gh", ["pr", "merge", "1"])];
    expect(matchCommandAllowExact(entries, "git", ["push"])).toBeNull();
    expect(matchCommandAllowExact(entries, "rm", ["-rf", "dist"])).toBeNull();
    expect(matchCommandAllowExact(entries, "gh", ["pr", "merge", "1"])).toBeNull();
    const policy = commandApprovalPolicy({ mode: "full_access", command: "git", args: ["push"], exact: entries });
    expect(policy).toMatchObject({ action: "ask", offerAlways: false });
  });

  test("the policy auto-approves an exact match in supervised mode", () => {
    const policy = commandApprovalPolicy({ mode: "supervised", command: "npm", args: ["run", "lint"], exact: [exact("npm", ["run", "lint"])] });
    expect(policy.action).toBe("auto");
    expect(policy.exact).toBeDefined();
    expect(policy.reason).toBe("Always allowed (exact): npm run lint");
    expect(commandApprovalPolicy({ mode: "supervised", command: "npm", args: ["run", "lint", "--fix"], exact: [exact("npm", ["run", "lint"])] }).action).toBe("ask");
  });

  test("always_exact is downgraded without an offer; add dedupes, remove drops", () => {
    expect(effectiveCommandDecision("always_exact", false)).toBe("allow");
    expect(effectiveCommandDecision("always_exact", undefined)).toBe("allow");
    expect(effectiveCommandDecision("always_exact", true)).toBe("always_exact");
    const once = addCommandAllowExact([], "npm", ["test"], "u", 1);
    const twice = addCommandAllowExact(once, "npm", ["test"], "u", 2);
    expect(twice).toHaveLength(1);
    expect(twice[0].createdAt).toBe(2);
    expect(removeCommandAllowExact(twice, "npm", ["test"])).toEqual([]);
    expect(removeCommandAllowExact(twice, "npm", ["test", "-w"])).toHaveLength(1);
  });
});
