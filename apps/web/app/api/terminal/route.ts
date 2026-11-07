import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 50 * 1024;

function isAllowedBinary(binary: string): boolean {
  if (!binary || binary.includes("\0") || binary.includes("/") || binary.includes("\\")) return false;
  return true;
}

export async function POST(request: NextRequest) {
  try {
    const { workspacePath, command } = (await request.json()) as {
      workspacePath: string;
      command: string;
    };
    if (!workspacePath || !command?.trim()) {
      return NextResponse.json({ error: "workspacePath and command are required" }, { status: 400 });
    }
    if (workspacePath.includes("\0") || command.includes("\0")) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const parts = command.trim().split(/\s+/);
    const binary = parts[0];
    const args = parts.slice(1);
    if (!isAllowedBinary(binary)) {
      return NextResponse.json({ error: `Command blocked: ${binary}` }, { status: 400 });
    }

    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd: workspacePath,
      timeout: 120_000,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    }).catch(async (err: any) => {
      // execFile throws on non-zero exit; surface stdout/stderr instead of 500.
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? String(err) };
    });

    return NextResponse.json({ stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Terminal failed" },
      { status: 400 },
    );
  }
}
