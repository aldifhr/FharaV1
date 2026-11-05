import * as fs from "node:fs/promises";
import { resolveSandboxPathAsync } from "./sandbox";
import { validateFilePath } from "../governance/tools";

export async function readFile(workspaceRoot: string, filePath: string): Promise<string> {
  const validation = validateFilePath(filePath);
  if (!validation.ok) {
    throw new Error(`Read blocked (${validation.reason}): ${filePath}`);
  }
  const resolved = await resolveSandboxPathAsync(workspaceRoot, filePath);
  try {
    return await fs.readFile(resolved, "utf-8");
  } catch (err: any) {
    throw new Error(`read_file failed for ${filePath}: ${err?.message ?? err}`);
  }
}
