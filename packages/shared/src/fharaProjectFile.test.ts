import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { parseFharaProjectFile, FharaProjectFileFromJson } from "./fharaProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(FharaProjectFileFromJson);

describe("FharaProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });
});

describe("parseFharaProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseFharaProjectFile(`{
        /* See https://fhara.dev/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
