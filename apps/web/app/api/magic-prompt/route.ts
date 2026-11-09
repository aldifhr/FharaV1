import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/api/convex/_generated/api";
import { rejectUnsafeRequest } from "@/lib/apiGuard";
import { readJsonObject } from "@/lib/proxyArgs";

/**
 * Prompt enhancement through the backend's provider pool. Release audit
 * P0-3/P0-4: same-origin only (lib/requestGuard.ts), and only a bounded
 * `prompt` string travels next to the service token.
 */
const MAX_PROMPT = 8_000;

export async function POST(request: NextRequest) {
  const rejected = rejectUnsafeRequest(request);
  if (rejected) return rejected;

  const token = process.env.CONVEX_SERVICE_TOKEN;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!token) {
    return NextResponse.json(
      { error: "CONVEX_SERVICE_TOKEN is not configured on the web server." },
      { status: 500 }
    );
  }
  if (!convexUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_CONVEX_URL is not configured." },
      { status: 500 }
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT) {
    return NextResponse.json({ error: `Prompt is too long (max ${MAX_PROMPT} characters)` }, { status: 400 });
  }

  const client = new ConvexHttpClient(convexUrl);
  try {
    const enhanced = await client.action(api.llmProvidersNode.enhancePrompt, {
      token,
      prompt,
    });
    return NextResponse.json({ enhanced });
  } catch (error) {
    console.error("Magic prompt enhancement failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Enhancement failed" },
      { status: 500 }
    );
  }
}
