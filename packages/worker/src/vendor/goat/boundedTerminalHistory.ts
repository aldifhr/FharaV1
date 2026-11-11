// Adapted from GOAT (https://github.com/goat-si/goat) apps/server/src/terminal/BoundedTerminalHistory.ts @ 718f5b11,
// MIT License, Copyright (c) 2026 T3 Tools Inc. and goat-si contributors. See THIRD_PARTY_NOTICES.md.
//
// Copied verbatim for Fhara (GOAT G11): incremental terminal history capped by lines and UTF-8
// bytes, with surrogate-safe eviction. Used by tools/runPty.ts.

export const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_HISTORY_CHUNK_LENGTH = 16 * 1024;

interface TerminalHistoryChunk {
  data: string;
  byteLength: number;
  lineBreaks: number;
}

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<TerminalHistoryChunk | undefined> = [];
  private start = 0;
  // UTF-16 positions stay stable when a later chunk completes a split surrogate.
  private endPosition = 0;
  private retainedPosition = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  // Reading the old string's tail on each append can force chunk concatenation.
  private lastCodeUnit: number | undefined;
  private cachedValue: string | null = "";

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    const endPosition = this.endPosition + text.length;
    this.endPosition = endPosition;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      this.endPosition = endPosition;
      this.retainedPosition = endPosition;
      if (this.maxBytes > 0 && text.endsWith("\n")) {
        this.appendChunk("\n");
        this.retainedPosition -= 1;
      }
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
  }

  private appendChunk(data: string): void {
    const byteLength = Buffer.byteLength(data);
    let lineBreaks = 0;
    for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
      lineBreaks += 1;
    }
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start];
    if (!first) throw new Error("Terminal history chunk invariant");
    this.retainedPosition += first.data.length;
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.chunks[this.start++] = undefined;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start];
    if (!first) throw new Error("Terminal history chunk invariant");
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    this.retainedPosition += offset;
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
  }

  private trim(): void {
    const trailingNewline = this.lastCodeUnit === 10;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0) {
      const first = this.chunks[this.start];
      if (!first) throw new Error("Terminal history chunk invariant");
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start];
      if (!first) throw new Error("Terminal history chunk invariant");
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset);
        if (codePoint === undefined) throw new Error("Terminal history offset invariant");
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }
    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.endPosition = 0;
    this.retainedPosition = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.lastCodeUnit = undefined;
    this.cachedValue = "";
  }

  get position(): number {
    return this.endPosition;
  }

  read(position: number | undefined, maxBytes: number, finished: boolean) {
    let next = Math.max(position ?? this.retainedPosition, this.retainedPosition);
    let gap = position === undefined ? this.retainedPosition > 0 : position < this.retainedPosition;
    let chunkPosition = this.retainedPosition;
    let bytes = 0;
    const parts: string[] = [];
    for (let index = this.start; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      if (!chunk) throw new Error("Terminal history chunk invariant");
      const chunkEnd = chunkPosition + chunk.data.length;
      if (next >= chunkEnd) {
        chunkPosition = chunkEnd;
        continue;
      }
      let offset = next - chunkPosition;
      const codeUnit = chunk.data.charCodeAt(offset);
      const previous = chunk.data.charCodeAt(offset - 1);
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
        offset += 1;
        next += 1;
        gap = true;
      }
      const start = offset;
      while (offset < chunk.data.length) {
        const point = chunk.data.codePointAt(offset);
        if (point === undefined) throw new Error("Terminal history offset invariant");
        if (
          !finished &&
          point >= 0xd800 &&
          point <= 0xdbff &&
          chunkPosition + offset + 1 === this.endPosition
        )
          break;
        const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (bytes + size > maxBytes) break;
        bytes += size;
        offset += point <= 0xffff ? 1 : 2;
      }
      parts.push(chunk.data.slice(start, offset));
      next = chunkPosition + offset;
      if (offset < chunk.data.length) break;
      chunkPosition = chunkEnd;
    }
    return {
      data: parts.join(""),
      position: next,
      retainedStart: this.retainedPosition,
      gap,
      eof: next === this.endPosition,
    };
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    this.cachedValue = this.chunks
      .slice(this.start)
      .map((chunk) => {
        if (!chunk) throw new Error("Terminal history chunk invariant");
        return chunk.data;
      })
      .join("");
    return this.cachedValue;
  }
}
