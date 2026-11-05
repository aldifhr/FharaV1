import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveSandboxPathAsync } from "./sandbox";

export async function writeFile(
  workspaceRoot: string,
  filePath: string,
  content: string
): Promise<void> {
  const resolved = await resolveSandboxPathAsync(workspaceRoot, filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf-8");
}
