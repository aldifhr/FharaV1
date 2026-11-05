export function extractJson(content: string): unknown {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const character = content[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
      } else if (character === "\"") {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(content.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export interface DraftFile {
  filePath: string;
  newContent: string;
}

export function parseDraft(content: string): { files: DraftFile[] } | null {
  const parsed = extractJson(content);
  const candidates: unknown[] = [];
  if (parsed && typeof parsed === "object") {
    const value = parsed as Record<string, unknown>;
    candidates.push(value);
    if (Array.isArray(value.files)) candidates.push(...value.files);
  }
  const files: DraftFile[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    if (typeof value.filePath === "string" && typeof value.newContent === "string") {
      files.push({ filePath: value.filePath, newContent: value.newContent });
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        if (typeof entry.filePath === "string" && typeof entry.newContent === "string") {
          files.push({ filePath: entry.filePath, newContent: entry.newContent });
        }
      }
    }
  }
  const unique = new Map<string, DraftFile>();
  for (const file of files) unique.set(file.filePath, file);
  if (unique.size === 0) return null;
  return { files: Array.from(unique.values()) };
}

export type ReviewFinding = {
  severity: "critical" | "high" | "medium" | "low";
  filePath: string;
  description: string;
  suggestion: string;
};

export type ReviewResult = {
  verdict: "approved" | "changes_requested";
  findings: ReviewFinding[];
};

export function parseReview(content: string): ReviewResult | null {
  const parsed = extractJson(content);
  if (!parsed || typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { verdict?: unknown; findings?: unknown };
  if (candidate.verdict !== "approved" && candidate.verdict !== "changes_requested") return null;
  if (!Array.isArray(candidate.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const finding of candidate.findings) {
    if (typeof finding !== "object" || finding === null) return null;
    const value = finding as Record<string, unknown>;
    if (
      !["critical", "high", "medium", "low"].includes(String(value.severity)) ||
      typeof value.filePath !== "string" ||
      typeof value.description !== "string" ||
      typeof value.suggestion !== "string"
    ) {
      return null;
    }
    findings.push({
      severity: value.severity as ReviewFinding["severity"],
      filePath: value.filePath,
      description: value.description,
      suggestion: value.suggestion,
    });
  }
  return { verdict: candidate.verdict, findings };
}

export function extractFileHint(command: string): string | null {
  const match = command.match(/[\w./-]+\.(tsx?|jsx?|css|html|json|md)/i);
  return match ? match[0] : null;
}
