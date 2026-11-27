/**
 * Role handoffs in CTO/Lead replies are rendered as chat mentions. The model
 * often writes "diserahkan ke Frontend" or "handed to Backend" instead, so
 * normalize those phrases into a leading `@role` before the message is
 * stored. Only role handoff phrases are touched; file paths and code stay
 * untouched.
 */

const ROLE = "frontend|backend|qa|designer|devops|lead|cto";

/** Canonical casing for mention tokens; `roleKeyForMention` still lowercases for lookup. */
const ROLE_TOKEN: Readonly<Record<string, string>> = {
  frontend: "Frontend",
  backend: "Backend",
  qa: "QA",
  designer: "Designer",
  devops: "DevOps",
  lead: "Lead",
  cto: "CTO",
};

const roleToken = (role: string) => ROLE_TOKEN[role.toLowerCase()] ?? role;

const HANDOFF_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:\\s+dan\\s+)?(?:diserahkan|ditugaskan|diberikan)\\s+ke\\s+(?:@)?(${ROLE})\\b`, "gi"),
  new RegExp(`(?:\\s+and\\s+)?(?:handed(?:\\s+(?:it|the task))?|assigned|sent)\\s+to\\s+(?:@)?(${ROLE})\\b`, "gi"),
  new RegExp(`(?:\\s+untuk\\s+)?(?:the task is with|task\\s+is\\s+with)\\s+(?:@)?(${ROLE})\\b`, "gi"),
  new RegExp(`\\bwith\\s+(?:@)?(${ROLE})\\b`, "gi"),
];

/** Turn "saya akan menambahkan" / "I will add" into a direct instruction. */
const IMPERATIVE: Readonly<Record<string, string>> = {
  menambahkan: "tambahkan",
  menambah: "tambahkan",
  mengubah: "ubah",
  mengganti: "ganti",
  membuat: "buat",
  memeriksa: "periksa",
  menjalankan: "jalankan",
  menulis: "tulis",
  menghapus: "hapus",
  memperbaiki: "perbaiki",
  menyesuaikan: "sesuaikan",
  mengomentari: "komentari",
};

const TASK_CLAIM_PATTERNS: readonly RegExp[] = [
  /^task\s+sudah\s+dibuat\s*[.,;:]?\s*/i,
  /^sudah\s+(?:saya|aku)\s+(?:membuat|buat)\s+task[- ]?nya(?:\s+dan\s+(?:saya|aku)\s+serahkan\s+ke\s+(?:@)?[\w-]+)?\s*[.,;:]?\s*/i,
  /^sudah\s+ada\s+task\s+(?:sebelumnya|yang\s+sama|dengan\s+cakupan\s+yang\s+sama)[^.!?]*[.,;:]?\s*(?:tetap|tapi|tetapi)?\s*/i,
  /^(?:saya|aku)\s+tidak\s+(?:membuat|buat)\s+task\b[^.]*\.\s*/i,
  /^i\s+(?:did\s+not|didn't)\s+create\s+(?:a\s+)?task\b[^.]*\.\s*/i,
  /^(?:saya|aku)\s+(?:sudah\s+)?(?:membuat|buat)\s+task\s*(?:untuk|yang|bahwa|karena)?\s*/i,
  /^i\s+(?:have\s+)?created\s+(?:a|the)?\s*task\s*(?:to|that|for)?\s*/i,
];

function asInstruction(text: string): string {
  let out = text;
  for (const pattern of TASK_CLAIM_PATTERNS) out = out.replace(pattern, "");
  out = out
    .replace(/^(?:saya|aku)\s+akan\s+/i, "")
    .replace(/^i\s+(?:will|am\s+going\s+to)\s+/i, "")
    .replace(/^i['’]ll\s+/i, "");
  out = out.replace(/^([A-Za-z][\w-]*)/, (word) => IMPERATIVE[word.toLowerCase()] ?? word);
  return out.replace(/^[.,;:]\s*/, "");
}

/** Keep the first role mention in canonical casing and drop the rest. */
function canonicalizeMentions(value: string): string {
  let seen = false;
  return value
    .replace(/@(frontend|backend|qa|designer|devops|lead|cto)\b/gi, (_match, found: string) => {
      if (seen) return "";
      seen = true;
      return `@${roleToken(found)}`;
    })
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([,.;:])\s*[,.;:]+/g, "$1")
    .replace(/,\s*(?:dan|and)\s*(?=[,.;:]|$)/gi, "");
}

export function normalizeRoleMentions(content: string, roleOverride?: string): string {
  let role: string | undefined;
  let text = content;
  const leading = text.match(/^\s*@([A-Za-z][\w-]*)\b\s*[,:]?\s*([\s\S]*)$/);
  if (leading && new RegExp(`^(${ROLE})$`, "i").test(leading[1])) {
    role ??= leading[1].toLowerCase();
    text = leading[2];
  } else {
    for (const pattern of HANDOFF_PATTERNS) {
      text = text.replace(pattern, (_match, found: string) => {
        role ??= found.toLowerCase();
        return "";
      });
    }
  }
  // A message with no role handoff must not gain one just because it sits on
  // a task routed elsewhere. That would poison task offers created from it.
  if (!role) return canonicalizeMentions(asInstruction(text));
  role = roleOverride?.replace(/^@/, "").toLowerCase() ?? role;
  text = text
    .replace(/\s+[,;.]?\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[.,;:]\s*/, "");
  text = asInstruction(text);
  text = text.replace(/[.!?]\s+task sudah dibuat\s*[.,;:]*\s*$/i, ".");
  const token = roleToken(role);
  if (!text) return `@${token}`;
  return canonicalizeMentions(`@${token}, ${text}`);
}
