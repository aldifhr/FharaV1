import { afterEach, describe, expect, it } from "vitest";
import {
  redactDeep,
  redactText,
  registerEnvSecrets,
  registerSecretValues,
  resetKnownSecretsForTests,
} from "@/utils/redact";
import { StreamRedactor, holdIndex } from "@/utils/redactStream";
import { LiveOutputCoalescer } from "@/services/runner/liveOutput";
import { redactSecrets } from "@/api/convex/lib/contextSnapshot";

const KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const OPAQUE = "zq81-opaque-provider-key-7731"; // no known shape: only known-value masking catches it

afterEach(() => resetKnownSecretsForTests());

describe("L2 redactText", () => {
  it("masks a registered value of any shape and secret-shaped text", () => {
    registerSecretValues([OPAQUE]);
    const out = redactText(`using ${OPAQUE} and ${KEY}`);
    expect(out).not.toContain(OPAQUE);
    expect(out).not.toContain("ABCDEFGHIJKLMNOP");
  });

  it("masks apiKey=<ANSI>VALUE", () => {
    const out = redactText("apiKey=\x1b[0mSuperSecretValue123 done");
    expect(out).not.toContain("SuperSecretValue123");
    const out2 = redactText("apiKey\x1b[31m=\x1b[0mSuperSecretValue123");
    expect(out2).not.toContain("SuperSecretValue123");
  });

  it("leaves ANSI colour alone when nothing is secret", () => {
    expect(redactText("\x1b[32mok\x1b[0m")).toBe("\x1b[32mok\x1b[0m");
  });

  it("picks up sensitive env values, not ports or flags", () => {
    registerEnvSecrets({ OPENAI_API_KEY: "plain-provider-value-1", PORT: "30000000", DEBUG_TOKEN: "true", NODE_ENV: "production" });
    expect(redactText("k=plain-provider-value-1")).not.toContain("plain-provider-value-1");
    expect(redactText("listening on 30000000 production")).toBe("listening on 30000000 production");
  });

  it("walks objects without cutting them", () => {
    registerSecretValues([OPAQUE]);
    const out = redactDeep({ a: [`x ${OPAQUE}`], b: { c: 3, d: OPAQUE }, id: "k57abc" });
    expect(out).toEqual({ a: ["x [REDACTED]"], b: { c: 3, d: "[REDACTED]" }, id: "k57abc" });
  });

  it("context-snapshot redaction still masks the same shapes", () => {
    expect(redactSecrets(`token ${KEY}`)).not.toContain("ABCDEFGHIJ");
    expect(redactSecrets('"password": "hunter22"')).toBe('"password": "[REDACTED]"');
  });
});

describe("L2 StreamRedactor", () => {
  it("masks a known key split across two chunks", () => {
    registerSecretValues([KEY]);
    const r = new StreamRedactor();
    const out = r.push("key is sk-proj-AB") + r.push("CDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ok\n") + r.end();
    expect(out).not.toContain("ABCDEFGH");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("ok");
  });

  it("masks an opaque registered value split mid-way even with whitespace in between chunks", () => {
    registerSecretValues(["two words secret"]);
    const r = new StreamRedactor();
    const out = r.push("value: two wor") + r.push("ds secret end ") + r.end();
    expect(out).not.toContain("two words secret");
  });

  it("holds a key name with its value", () => {
    const r = new StreamRedactor();
    const first = r.push("config password: ");
    expect(first).not.toContain("password");
    const out = first + r.push("hunter2hunter2 next ") + r.end();
    expect(out).not.toContain("hunter2hunter2");
  });

  it("holds an open private-key block until its end line", () => {
    const r = new StreamRedactor();
    const a = r.push("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA");
    expect(a).toBe("x\n");
    const b = r.push("BBBB\n-----END OPENSSH PRIVATE KEY-----\n");
    expect(b).not.toContain("AAAA");
  });

  it("releases past the 64 KiB cap", () => {
    const r = new StreamRedactor({ cap: 100 });
    expect(r.push("a".repeat(150)).length).toBe(150);
  });

  it("holdIndex holds only the last word", () => {
    expect(holdIndex("hello world", [])).toBe(6);
    expect(holdIndex("hello world ", [])).toBe(12);
  });
});

describe("L2 live output", () => {
  it("never writes a split key unmasked", async () => {
    registerSecretValues([KEY]);
    const writes: string[] = [];
    let fire: (() => void) | undefined;
    const live = new LiveOutputCoalescer(
      { write: async (t) => void writes.push(t), clear: async () => undefined },
      { setTimer: (fn) => ((fire = fn), 1), clearTimer: () => undefined, flushChars: 1_000_000 }
    );
    live.push("Here: sk-proj-AB");
    fire?.();
    await live.flush();
    live.push("CDEFGHIJKLMNOPQRSTUVWXYZ0123456789 done");
    await live.flush();
    for (const w of writes) {
      expect(w).not.toContain("sk-proj-AB");
      expect(w).not.toContain("CDEFGHIJ");
    }
    expect(writes.at(-1)).toContain("[REDACTED]");
  });
});
