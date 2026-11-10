/**
 * Run-command requests in chat ("jalankan tes", "run npm test").
 *
 * MIRROR of `detectRunCommands` in packages/worker/src/orchestrator/classifier.ts
 * and of the allowlist in packages/worker/src/utils/commandAllowlist.ts —
 * Convex code cannot import worker code. Keep the two in step:
 * packages/worker/tests/chatRunRequestParity.test.ts runs both over the same
 * corpus and fails when they drift.
 *
 * Pure (no Convex or Node APIs).
 */

/** Mirror of ALLOWED_ARGV (packages/worker/src/utils/commandAllowlist.ts). */
export const CHAT_ALLOWED_ARGV: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
  npm: [["run", "test"], ["run", "build"], ["run", "typecheck"]],
  npx: [["tsc", "--noEmit"]],
  git: [
    ["status"],
    ["status", "--short"],
    ["status", "-sb"],
    ["branch", "--show-current"],
    ["diff"],
    ["diff", "--no-color"],
    ["diff", "--stat"],
    ["log", "--oneline", "-n", "20"],
    ["fetch"],
    ["pull"],
    ["pull", "--ff-only"],
    ["pull", "--rebase"],
  ],
  node: [["--version"]],
};

function allowedCommandLines(): string[] {
  return Object.entries(CHAT_ALLOWED_ARGV).flatMap(([command, variants]) =>
    variants.map((args) => [command, ...args].join(" "))
  );
}

// Same patterns as the worker classifier (see header).
const ID_SUFFIX = "(?:kan|lah|in|nya|kanlah)?";
const CHANGE_VERB = new RegExp(
  "\\b(add|create|build|implement|make|update|edit|fix|change|refactor|refaktor|remove|delete|rename|move|style|redesign|" +
    `(?:tambah|buat|bikin|ubah|perbaiki|perbaik|hapus|pasang|sesuaikan|ganti|pindah|pisah|rapi|perbarui)${ID_SUFFIX}|` +
    "migrate|convert|scaffold|porting|port|setup|install|konversi|switch|ganti ke|pindah ke|too slow|should switch|switch to|postgres)\\b",
  "i"
);
const NO_CODE_NEGATION = new RegExp(
  "\\b(?:jangan|tanpa|tidak (?:perlu|usah)|nggak usah|gak usah|ga usah|ngga usah|tak perlu)\\s+" +
    "(?:(?:meng|di)?ubah|(?:meng|di)?edit|menyentuh|(?:di)?sentuh|(?:me|di)?modifikasi|(?:meng|di)?ganti|menulis|(?:di)?tulis|bikin|buat)\\w*\\s+" +
    "(?:(?:apa|apapun|apa pun|satu)\\s+)?(?:kode|code|kodenya|file|berkas|source|repo)\\w*" +
    "|\\b(?:do not|don'?t|dont|never|without|no need to)\\s+(?:change|changing|modify|modifying|edit|editing|touch|touching|write|writing)\\s+" +
    "(?:(?:any|the|a)\\s+)?(?:code|files?|source|repo)\\b" +
    "|\\bno code changes?\\b",
  "i"
);
const RESEARCH_ONLY =
  /\b(?:research[- ]only|riset saja|riset aja|analisa saja|analisa aja|analisis saja|analisis aja|hanya (?:riset|analisa|analisis)|cuma (?:riset|analisa|analisis)|just (?:research|analy[sz]e))\b/i;
const QUESTION_START =
  /^(kenapa|mengapa|apa|apakah|bagaimana|gimana|gmn|kapan|dimana|di mana|why|how come|what|when|where)\b/i;
const REQUEST_MARKER =
  /\b(tolong|please|pls|coba|minta|bisa(kah)? (kamu|tolong|bantu)|bantu|can you|could you|would you|can we|could we|shall we|bisakah|bisa nggak|bisa gak|silakan)\b/i;
const RUN_VERB =
  /\b(?:run|re-?run|execute|exec|jalankan|jalanin|jalankanlah|jalan(?:kan)?in|eksekusi(?:kan)?|lakukan)\b/gi;
const RUN_TARGETS: Array<{ pattern: RegExp; line: string }> = [
  { pattern: /\bnpx\s+tsc(?:\s+--noemit)?\b|\btsc(?:\s+--noemit)?\b/gi, line: "npx tsc --noEmit" },
  { pattern: /\bnpm\s+(?:run\s+)?typecheck\b|\btype[- ]?check(?:s|ing|nya)?\b|\bcek\s+tipe\b|\bpengecekan\s+tipe\b/gi, line: "npm run typecheck" },
  { pattern: /\bnpm\s+run\s+build\b|\bbuild(?:nya)?\b/gi, line: "npm run build" },
  {
    pattern:
      /\bnpm\s+(?:run\s+)?test\b|\bnpm\s+t\b|\b(?:the\s+)?(?:unit\s+)?(?:tests?|testing|testnya|tes|tesnya|test\s*suite|pengujian|ujinya|uji\s+unit)\b/gi,
    line: "npm run test",
  },
];
const NPM_ALIAS = /\bnpm\s+(?:run\s+)?(?:test|build|typecheck)\b|\bnpm\s+t\b|\bnpx\s+tsc\b/i;
const RUN_FILLER =
  /\b(?:tolong|please|pls|coba|dong|ya|yah|aja|saja|sekarang|now|again|lagi|semua|seluruh|all|the|whole|full|project|proyek|repo|repository|di|in|for|untuk|on|and|dan|lalu|then|kasih|tahu|tau|hasil(?:nya)?|results?|report|laporkan|show|me|tunjukkan|lihat|cek|check|can|could|you|kamu|bisa|bantu|minta|it|them|itu|ini|this|with|pakai|pake|using|via|npm|npx|command|perintah|sekali|once|first|dulu|terus)\b/gi;

function requestText(command: string): string {
  return command.split(/\n\s*(?:---\s*Conversation context\s*---|Attached file context:|---\s*File:)/i)[0] ?? command;
}

function withoutNoCodePhrases(text: string): string {
  return text.replace(new RegExp(NO_CODE_NEGATION.source, "gi"), " ").replace(new RegExp(RESEARCH_ONLY.source, "gi"), " ");
}

function isPureQuestion(text: string): boolean {
  if (REQUEST_MARKER.test(text)) return false;
  const trimmed = text.trim();
  const endsWithQuestion = trimmed.endsWith("?");
  const innerQuestion = trimmed.slice(0, -1).includes("?");
  if (innerQuestion) return false;
  return endsWithQuestion || QUESTION_START.test(trimmed);
}

function allowlistedLineMatches(text: string): Array<{ index: number; line: string; length: number }> {
  const hits: Array<{ index: number; line: string; length: number }> = [];
  const lines = allowedCommandLines().sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  for (const line of lines) {
    let from = 0;
    const needle = line.toLowerCase();
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      const before = at === 0 ? " " : lower[at - 1];
      const after = lower[at + needle.length] ?? " ";
      const overlapped = hits.some((hit) => at < hit.index + hit.length && hit.index < at + needle.length);
      if (/[\s"'`(]/.test(before) && /[\s"'`).,;!?]/.test(after) && !overlapped) {
        hits.push({ index: at, line, length: needle.length });
      }
      from = at + needle.length;
    }
  }
  return hits;
}

/**
 * The allowlisted command lines a plain "run …" request asks for, in request
 * order, or null (see the worker's detectRunCommands for the rules).
 */
export function detectChatRunCommands(command: string): string[] | null {
  const text = requestText(command).trim();
  if (!text) return null;
  if (isPureQuestion(text)) return null;

  const literal = allowlistedLineMatches(text);
  let rest = text;
  const found: Array<{ index: number; line: string }> = literal.map((hit) => ({ index: hit.index, line: hit.line }));
  for (const hit of literal) rest = rest.slice(0, hit.index) + " ".repeat(hit.length) + rest.slice(hit.index + hit.length);

  const hasRunVerb = new RegExp(RUN_VERB.source, "i").test(rest);
  const hasCommandAlias = NPM_ALIAS.test(rest);
  if (hasRunVerb || hasCommandAlias) {
    for (const target of RUN_TARGETS) {
      rest = rest.replace(new RegExp(target.pattern.source, "gi"), (match, ...groups) => {
        const index = groups[groups.length - 2] as number;
        found.push({ index, line: target.line });
        return " ".repeat(match.length);
      });
    }
  }
  if (found.length === 0) return null;
  if (literal.length === 0 && !hasRunVerb && !hasCommandAlias) return null;

  const leftover = withoutNoCodePhrases(rest).replace(RUN_VERB, " ").replace(RUN_FILLER, " ");
  if (CHANGE_VERB.test(leftover)) return null;
  const words = leftover.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  if (words.length > 2) return null;

  const lines: string[] = [];
  for (const hit of found.sort((a, b) => a.index - b.index)) {
    const [binary, ...args] = hit.line.split(" ");
    const allowed = (CHAT_ALLOWED_ARGV[binary] ?? []).some(
      (candidate) => candidate.length === args.length && candidate.every((value, i) => value === args[i])
    );
    if (allowed && !lines.includes(hit.line)) lines.push(hit.line);
  }
  return lines.length > 0 ? lines : null;
}

/** A message that OPENS with a run verb in English ("run npm test", "execute the build"). */
const LEADING_EN_RUN = /^(?:run|re-?run|execute)\b/i;

/**
 * A chat message that is itself an explicit run order: it opens with a run
 * verb (jalankan/jalanin/eksekusi, or the English run/execute) and the whole
 * message is a plain run request for allowlisted commands. Questions ("…?")
 * never count. The full message is the task command, so the worker's
 * classifier still sees the run verb ("jalankan tes", not just "tes").
 */
export function explicitRunCommand(text: string): string | null {
  const t = text.trim();
  if (!t || /\n/.test(t) || /\?\s*$/.test(t)) return null;
  const leadingId = /^(?:jalankan|jalanin|jalankanlah|eksekusi(?:kan)?)\b/i.test(t);
  if (!leadingId && !LEADING_EN_RUN.test(t)) return null;
  return detectChatRunCommands(t) ? t : null;
}
