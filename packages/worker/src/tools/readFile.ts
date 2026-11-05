import * as fs from "node:fs/promises";
import { resolveSandboxPath } from "./sandbox";

export async function readFile(workspaceRoot: string, filePath: string): Promise<string> {
  const resolved = resolveSandboxPath(workspaceRoot, filePath);
  try {
    return await fs.readFile(resolved, "utf-8");
  } catch (err: any) {
    throw new Error(`read_file failed for ${filePath}: ${err?.message ?? err}`);
  }
}
