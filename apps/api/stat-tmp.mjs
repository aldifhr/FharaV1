import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";
const client = new ConvexClient("http://127.0.0.1:3210");
const t = await client.query(api.tasks.get, { taskId: "n571fprds6526j4fz09zkdcvcd8htt08" });
console.log("STATUS", t?.status, "| planVer", t?.planVersion, "| err", t?.errorMessage ?? "-");
const ev = await client.query(api.taskEvents.listByTask, { taskId: "n571fprds6526j4fz09zkdcvcd8htt08" });
console.log("EVN", (ev || []).map((e) => e.type).join(" | "));
for (const e of ev || []) {
  if (e.type.includes("task.failed") || e.type === "task.error" || e.type === "review") {
    console.log(e.type, JSON.stringify(e.payload || {}).slice(0, 700));
  }
}
client.close();
