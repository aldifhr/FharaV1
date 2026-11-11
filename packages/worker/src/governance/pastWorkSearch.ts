/**
 * D11: binds the governed `search_past_work` tool to the Convex API
 * (`pastWork.forWorker`, service-token authenticated). Pass the result as
 * `ToolContext.searchPastWork`.
 */
import { api } from "@/api/convex/_generated/api";
import type { WorkerApi } from "@/workerApi";
import type { PastWorkSearchFn } from "./tools";

export function workerPastWorkSearch(workerApi: Pick<WorkerApi, "client" | "args">): PastWorkSearchFn {
  return async ({ projectId, query, limit, excludeTaskId }) =>
    await workerApi.client.action(
      api.pastWork.forWorker,
      workerApi.args({ projectId, query, ...(limit !== undefined ? { limit } : {}), ...(excludeTaskId ? { excludeTaskId } : {}) })
    );
}
