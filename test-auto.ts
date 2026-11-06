import { ConvexHttpClient } from "convex/browser";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

async function main() {
  const projectId = "jn7fknch11dw58a978381khkvn8hmpmx" as any;
  const command = "add // AUTHOR: Test at top of apps/web/app/hello/page.tsx";

  const taskId = await client.mutation("tasks:createFromCommand" as any, {
    projectId,
    command,
    title: command.slice(0, 80),
  } as any);
  console.log("Created task:", taskId);
}

main().catch((e) => { console.error(e); process.exit(1); });
