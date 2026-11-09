import { describe, expect, test } from "vitest";
import {
  extractToolCalls,
  hasToolCallText,
  normalizeRepoToolArgs,
  noToolsFallback,
  resolveNoToolsReply,
  streamVisibleText,
} from "./toolCallText";
import {
  ONE_CALL_PER_REPLY,
  parseRepoToolCall,
  runRepoToolLoop,
  type RepoToolCall,
} from "./repoTools";
import { collectRepoEvidence, extractFileRefs, findUnverifiedRefs } from "./refCheck";
import { buildGroundingGuidance, buildRepoToolProtocol } from "../prompts/chat";

const LEAKED = '{"tool":"read_file","arguments":{"path":"apps/api/convex/schema.ts","maxLines":1000}}';

describe("extractToolCalls", () => {
  test("the live leak: one bare JSON call, aliases normalized", () => {
    expect(extractToolCalls(LEAKED)).toEqual({
      calls: [{ tool: "read_file", args: { path: "apps/api/convex/schema.ts", lines: 1000 } }],
      prose: "",
      malformed: 0,
    });
  });

  test("several calls plus an answer in one reply: every call found, prose kept without them", () => {
    const text = `${LEAKED}\n{"tool":"grep","arguments":{"query":"defineTable"}}\n\nSchema punya 28 tabel.`;
    const { calls, prose } = extractToolCalls(text);
    expect(calls.map((c) => c.tool)).toEqual(["read_file", "grep"]);
    expect(calls[1].args).toEqual({ pattern: "defineTable" });
    expect(prose).toBe("Schema punya 28 tabel.");
  });

  test("LongCat markup: JSON inside, name + arg_key/arg_value pairs, a stray closing tag, an unterminated tag", () => {
    expect(extractToolCalls(`<longcat_tool_call>${LEAKED}</longcat_tool_call>`).calls[0].tool).toBe("read_file");
    const pairs = extractToolCalls(
      "Cek dulu.<longcat_tool_call>grep\n<longcat_arg_key>regex</longcat_arg_key>\n<longcat_arg_value>defineTable</longcat_arg_value>\n</longcat_tool_call>"
    );
    expect(pairs).toEqual({ calls: [{ tool: "grep", args: { pattern: "defineTable" } }], prose: "Cek dulu.", malformed: 0 });
    expect(extractToolCalls(`${LEAKED}</longcat_tool_call>`)).toMatchObject({ prose: "", calls: [{ tool: "read_file" }] });
    expect(extractToolCalls(`<tool_call>${LEAKED}\nJawaban di sini.`)).toMatchObject({
      prose: "Jawaban di sini.",
      calls: [{ tool: "read_file" }],
    });
    // Unparseable markup is still stripped and still counts as a tool-call attempt.
    const broken = extractToolCalls("Saya lihat file.<longcat_tool_call>DevOps\n<longcat_arg_ke");
    expect(broken.prose).toBe("Saya lihat file.");
    expect(hasToolCallText("Saya lihat file.<longcat_tool_call>")).toBe(true);
  });

  test("fenced calls, OpenAI function shape and arrays", () => {
    expect(extractToolCalls("```json\n" + LEAKED + "\n```").calls).toHaveLength(1);
    expect(
      extractToolCalls('{"type":"function","function":{"name":"grep","arguments":"{\\"q\\":\\"x\\"}"}}').calls[0]
    ).toEqual({ tool: "grep", args: { pattern: "x" } });
    expect(extractToolCalls(`[${LEAKED}, {"tool":"list_files","arguments":{}}]`.replace("[", "```json\n[") + "\n```").calls).toHaveLength(2);
  });

  test("prose that only quotes JSON (inline, or a non-call object in a fence) is left alone", () => {
    expect(extractToolCalls('Here is the config: {"tool":"grep"}')).toMatchObject({ calls: [], prose: 'Here is the config: {"tool":"grep"}' });
    const fenced = 'Contoh:\n```json\n{"name":"fhara","version":"1.0.0"}\n```\nselesai';
    expect(extractToolCalls(fenced)).toMatchObject({ calls: [], prose: fenced });
    expect(hasToolCallText("schema.ts punya 1069 baris.")).toBe(false);
  });

  test("parseRepoToolCall stays strict: exactly one call and nothing else", () => {
    expect(parseRepoToolCall(LEAKED)?.args).toEqual({ path: "apps/api/convex/schema.ts", lines: 1000 });
    expect(parseRepoToolCall(`${LEAKED}\nJawaban`)).toBeNull();
    expect(parseRepoToolCall(`${LEAKED}\n${LEAKED}`)).toBeNull();
  });
});

describe("argument aliases", () => {
  test("maxLines/max_lines/limit → lines, file/filepath → path, query/regex → pattern, startLine → start", () => {
    for (const key of ["maxLines", "max_lines", "limit"]) expect(normalizeRepoToolArgs({ [key]: 5 })).toEqual({ lines: 5 });
    for (const key of ["file", "filepath", "file_path"]) expect(normalizeRepoToolArgs({ [key]: "a.ts" })).toEqual({ path: "a.ts" });
    for (const key of ["query", "regex"]) expect(normalizeRepoToolArgs({ [key]: "x" })).toEqual({ pattern: "x" });
    expect(normalizeRepoToolArgs({ startLine: 9, ignore_case: "true" })).toEqual({ start: 9, ignoreCase: true });
    // The canonical name wins over its alias.
    expect(normalizeRepoToolArgs({ path: "a.ts", file: "b.ts" })).toEqual({ path: "a.ts" });
  });
});

describe("streaming", () => {
  test("a reply that starts as a call shows nothing; a call after prose is held back until it is gone", () => {
    expect(streamVisibleText('{"tool":"rea')).toBe("");
    expect(streamVisibleText("<longcat_tool_call>gr")).toBe("");
    expect(streamVisibleText('Saya cek dulu.\n{"tool":"read_file","argu')).toBe("Saya cek dulu.");
    expect(streamVisibleText(`Saya cek dulu.\n${LEAKED}\nSchema`)).toBe("Saya cek dulu.\n\nSchema");
    expect(streamVisibleText("Saya cek <longcat_tool_call>{")).toBe("Saya cek");
    expect(streamVisibleText("Sudah saya cek")).toBe("Sudah saya cek");
  });
});

describe("no-tools retry outcome", () => {
  test("prose wins, a stray call next to a real answer is dropped, a bare call becomes the fallback", () => {
    expect(resolveNoToolsReply("Belum saya cek.", "berapa baris")).toBe("Belum saya cek.");
    const long = "Belum saya cek isinya, tapi dari struktur folder schema ada di apps/api/convex. Untuk angka pastinya perlu dibaca.";
    expect(resolveNoToolsReply(`${long}\n${LEAKED}`, "berapa baris")).toBe(long);
    expect(resolveNoToolsReply(LEAKED, "berapa baris tabel apa saja")).toBe(noToolsFallback("berapa baris"));
    expect(noToolsFallback("berapa baris")).toMatch(/^Belum saya cek — repo tidak bisa dibaca dari chat sekarang/);
    expect(noToolsFallback("how many lines?")).toMatch(/^I haven't checked that yet/);
  });
});

describe("repo tool loop: several calls in one step", () => {
  test("only the first call runs, the rest and the prose are discarded, and the model is told", async () => {
    const replies = [
      `${LEAKED}\n{"tool":"grep","arguments":{"pattern":"defineTable"}}\nSchema punya 1068 baris dan 28 tabel.`,
      "Sudah saya cek: schema.ts 900 baris.",
    ];
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const ran: RepoToolCall[] = [];
    const result = await runRepoToolLoop({
      messages: [{ role: "user", content: "berapa baris schema.ts?" }],
      step: async (messages) => {
        seen.push(messages);
        return { content: replies[seen.length - 1] };
      },
      callTool: async (call) => {
        ran.push(call);
        return { ok: true, text: "apps/api/convex/schema.ts: 41230 bytes, 900 lines total\n1: import", files: ["apps/api/convex/schema.ts"] };
      },
    });
    expect(ran).toEqual([{ tool: "read_file", args: { path: "apps/api/convex/schema.ts", lines: 1000 } }]);
    expect(result.answer).toBe("Sudah saya cek: schema.ts 900 baris.");
    expect(seen[1].at(-1)?.content).toContain(ONE_CALL_PER_REPLY);
    // The assistant turn fed back is the single call that ran, not the whole reply.
    expect(seen[1].at(-2)?.content).toBe(JSON.stringify({ tool: "read_file", arguments: { path: "apps/api/convex/schema.ts", lines: 1000 } }));
    expect(result.results).toHaveLength(1);
  });

  test("an answer with a trailing stray call is returned without it; budget-exhausted calls leave no text", async () => {
    const withStray = await runRepoToolLoop({
      messages: [{ role: "user", content: "q" }],
      step: async () => ({ content: "Jawaban.\n" + LEAKED }),
      callTool: async () => ({ ok: true, text: "x" }),
      maxCalls: 0,
    });
    expect(withStray.answer).toBe("Jawaban.");
    const onlyCalls = await runRepoToolLoop({
      messages: [{ role: "user", content: "q" }],
      step: async () => ({ content: LEAKED }),
      callTool: async () => ({ ok: true, text: "x" }),
      maxCalls: 2,
    });
    expect(onlyCalls.answer).toBe("");
    expect(onlyCalls.calls).toHaveLength(2);
  });
});

describe("post-answer reference check", () => {
  const evidence = collectRepoEvidence([
    {
      label: 'grep "normalizeRole"',
      text: '2 match(es) for "normalizeRole" in . (whole repository):\npackages/worker/src/orchestrator/roles.ts:102: export function normalizeRole(role: string) {\napps/web/lib/x.ts:7: normalizeRole(r)',
    },
    {
      label: "read_file apps/api/convex/schema.ts",
      text: "apps/api/convex/schema.ts: 41230 bytes, 900 lines total\ntruncated: lines 1-3 of 900; read again with start=4\n1: import { defineSchema } from \"convex/server\";\n2: \n3: export default defineSchema({",
      files: ["apps/api/convex/schema.ts"],
    },
    { label: 'grep "commitAndPush" in apps', text: '0 matches for "commitAndPush" in apps. Not found there.' },
  ]);

  test("refs are pulled out with their line numbers in common spellings", () => {
    expect(
      extractFileRefs("di `roles.ts:102`, apps/api/convex/roleRegistry.ts line 58, chat.ts#L9, schema.ts (baris 3), Next.js, ctx.db.query").map(
        (r) => r.ref
      )
    ).toEqual(["roles.ts:102", "apps/api/convex/roleRegistry.ts:58", "chat.ts:9", "schema.ts:3"]);
  });

  test("seen paths and lines pass; invented files and lines are unverified", () => {
    const answer = [
      "normalizeRole ada di packages/worker/src/orchestrator/roles.ts:102 (juga roles.ts:102).",
      "Bukan di apps/api/convex/roleRegistry.ts line 58.",
      "schema.ts baris 3 membuka defineSchema; tabel workspaces ada di apps/api/convex/schema.ts:640.",
      "commitAndPush tidak ketemu di apps; runShell ada di packages/worker/src/shell.ts.",
    ].join("\n");
    expect(findUnverifiedRefs(answer, evidence)).toEqual([
      "apps/api/convex/roleRegistry.ts:58",
      "apps/api/convex/schema.ts:640",
      "packages/worker/src/shell.ts",
    ]);
  });

  test("a bare path in the repo snapshot counts as seen; nothing cited, nothing flagged", () => {
    const snapshot = "apps/\n  api/\n    convex/\n      chat.ts (30000b)\n";
    expect(findUnverifiedRefs("Lihat apps/api/convex/chat.ts.", collectRepoEvidence([]), snapshot)).toEqual([]);
    expect(findUnverifiedRefs("Lihat chat.ts:12.", collectRepoEvidence([]), snapshot)).toEqual(["chat.ts:12"]);
    expect(findUnverifiedRefs("Belum saya cek.", collectRepoEvidence([]))).toEqual([]);
  });
});

describe("grounding prompt", () => {
  test("tools on: one call per reply, paging/grep for whole-file facts, not-found is not-found, cite only seen file:line", () => {
    const protocol = buildRepoToolProtocol(6);
    expect(protocol).toMatch(/one call per reply/);
    expect(protocol).toMatch(/truncated: lines X-Y of N/);
    expect(protocol).toMatch(/"start"/);
    expect(protocol).toMatch(/defineTable/);
    expect(protocol).toMatch(/Omit "path" to search the whole repository/);
    expect(protocol).toMatch(/0 matches" means not found/);
    expect(protocol).toMatch(/Cite a file:line only exactly as a tool result in this reply shows it/);
    expect(buildGroundingGuidance(true).join("\n")).toMatch(/never cite a file:line that is not in a tool result in this reply/);
  });

  test("tools off: never output a tool call", () => {
    expect(buildGroundingGuidance(false).join("\n")).toMatch(/never output a tool call or JSON/);
  });
});
