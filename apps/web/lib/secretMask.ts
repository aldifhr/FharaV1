/**
 * Mask API keys and tokens that a user pasted into a chat message, for
 * display only. The stored message keeps the real text; copying a masked
 * message gives the real text back (see `unmaskText`).
 *
 * A match keeps its first VISIBLE characters and replaces the rest with a
 * fixed run of asterisks, so the length of the secret is not revealed:
 *   sk-abcdefgh12345 → sk-abcde*****
 */

const VISIBLE = 8;
const STARS = "*****";

/** Token shapes with a recognisable prefix. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/, // OpenAI, Anthropic (sk-ant-…) and most OpenAI-compatible keys
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/, // Stripe
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained tokens
  /glpat-[A-Za-z0-9_-]{20,}/, // GitLab
  /xox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /AIza[0-9A-Za-z_-]{35}/, // Google API key
  /hf_[A-Za-z0-9]{20,}/, // Hugging Face
  /gsk_[A-Za-z0-9]{20,}/, // Groq
  /r8_[A-Za-z0-9]{20,}/, // Replicate
];

// One alternation, bounded so a match never starts or ends inside a longer word.
const SECRET_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${SECRET_PATTERNS.map((re) => re.source).join("|")})(?![A-Za-z0-9_-])`,
  "g",
);

// Fenced blocks and inline code: markdown escapes do not apply inside them.
const CODE_SPLIT_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

export type SecretMask = { masked: string; original: string };

export type MaskedText = {
  /** The text to render. */
  text: string;
  /** Each masked secret, in order of appearance. Empty when nothing was masked. */
  masks: SecretMask[];
};

export function maskSecret(secret: string): string {
  return `${secret.slice(0, VISIBLE)}${STARS}`;
}

/**
 * Mask every secret in `content`. With `markdown`, the asterisks outside
 * code are backslash-escaped so the renderer shows them literally instead
 * of reading them as emphasis; `masks[].masked` is always the text as seen.
 */
export function maskSecrets(content: string, options: { markdown?: boolean } = {}): MaskedText {
  const masks: SecretMask[] = [];
  const maskPart = (part: string, escape: boolean) =>
    part.replace(SECRET_RE, (original) => {
      const masked = maskSecret(original);
      masks.push({ masked, original });
      return escape ? masked.replace(/\*/g, "\\*") : masked;
    });
  const source = content ?? "";
  const text = options.markdown
    ? source
        .split(CODE_SPLIT_RE)
        .map((part, index) => maskPart(part, index % 2 === 0))
        .join("")
    : maskPart(source, false);
  return { text, masks };
}

/**
 * Put the real secrets back into copied text. Masked tokens are restored in
 * order, so two keys with the same visible prefix each get their own value
 * back. A selection that cuts a masked token in half has nothing to restore
 * and is returned as selected.
 */
export function unmaskText(selected: string, masks: SecretMask[]): string {
  if (!selected || masks.length === 0) return selected;
  let out = "";
  let rest = selected;
  let next = 0;
  while (rest.length > 0) {
    let best: { at: number; index: number } | null = null;
    for (let i = next; i < masks.length; i++) {
      const at = rest.indexOf(masks[i].masked);
      if (at !== -1 && (best === null || at < best.at)) best = { at, index: i };
      if (at === 0) break;
    }
    if (!best) break;
    const mask = masks[best.index];
    out += rest.slice(0, best.at) + mask.original;
    rest = rest.slice(best.at + mask.masked.length);
    next = best.index + 1;
  }
  return out + rest;
}
