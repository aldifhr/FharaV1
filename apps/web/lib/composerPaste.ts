// Composer paste and text attachments (GOAT G14, idea #14).
//
// Pattern from GOAT's composer (https://github.com/goat-si/goat, docs/user/composer.md),
// MIT License, Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 goat-si contributors.
// Written for Fhara, 2026-11; no code copied. See THIRD_PARTY_NOTICES.md (## GOAT).
//
// A large paste lands as a text attachment instead of flooding the input: it
// shows as one row the user can remove, and its text joins the message only on
// send, fenced like an attached file. The typed text is capped at
// COMPOSER_MAX_CHARS; a paste that would push it past the cap also becomes an
// attachment rather than being cut.

/** A paste of this many UTF-8 bytes or more becomes an attachment. */
export const PASTE_ATTACH_BYTES = 32 * 1024;
/** The most characters the composer's own text box holds. */
export const COMPOSER_MAX_CHARS = 120_000;
/** The largest single text attachment, pasted or picked from disk. */
export const ATTACH_MAX_BYTES = 200_000;

export type TextAttachment = { id: string; name: string; text: string; bytes: number };

export type PasteAction = "inline" | "attach" | "too_large";

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * What a paste of `pasted` does to a draft of `draftChars` characters, where
 * `selectedChars` of them are replaced by the paste.
 */
export function pasteAction(pasted: string, draftChars: number, selectedChars = 0): PasteAction {
  const bytes = utf8Bytes(pasted);
  if (bytes > ATTACH_MAX_BYTES) return "too_large";
  if (bytes >= PASTE_ATTACH_BYTES) return "attach";
  if (draftChars - selectedChars + pasted.length > COMPOSER_MAX_CHARS) return "attach";
  return "inline";
}

/** "Pasted text 2.txt" for the second paste, skipping names already taken. */
export function pastedName(taken: readonly TextAttachment[]): string {
  const names = new Set(taken.map((a) => a.name));
  for (let n = 1; ; n += 1) {
    const name = `Pasted text ${n}.txt`;
    if (!names.has(name)) return name;
  }
}

/** Rejects binary content read as text (NUL bytes or many replacement characters). */
export const looksBinary = (text: string): boolean => text.includes("\u0000") || (text.match(/\uFFFD/g)?.length ?? 0) > 8;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

// A fence one backtick longer than any run inside the text, so the text
// can't close it.
function fenceFor(text: string): string {
  let longest = 2;
  for (const run of text.match(/`{3,}/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(longest + 1);
}

const language = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return /^[a-z0-9+#-]{1,16}$/.test(ext) ? ext : "";
};

/** One attachment as message text: the name, then the text fenced. */
export function attachmentBlock(attachment: Pick<TextAttachment, "name" | "text">): string {
  const fence = fenceFor(attachment.text);
  const lang = attachment.name.startsWith("Pasted text ") ? "text" : language(attachment.name);
  return `\`${attachment.name}\`:\n${fence}${lang}\n${attachment.text.replace(/\s+$/, "")}\n${fence}`;
}

/** The message sent: the typed text, then each attachment in order. Never cut. */
export function composeMessage(draft: string, attachments: readonly Pick<TextAttachment, "name" | "text">[]): string {
  const parts = [draft.trim(), ...attachments.map(attachmentBlock)].filter(Boolean);
  return parts.join("\n\n");
}
