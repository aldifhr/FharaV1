/**
 * GOAT G12a: `McpReadSource` over the token-gated Convex queries in
 * apps/api/convex/mcpRead.ts, through the worker's WorkerApi client (its
 * `args()` adds the service token), and (G12b) the token-gated write
 * mutations in apps/api/convex/mcpWrite.ts.
 */
import { api } from "@/api/convex/_generated/api";
import type { WorkerApi } from "@/workerApi";
import type { McpSource } from "./types";

export function convexMcpSource(workerApi: WorkerApi): McpSource {
  return {
    taskStatus: (input) => workerApi.client.query(api.mcpRead.taskStatus, workerApi.args(input)),
    taskList: (input) => workerApi.client.query(api.mcpRead.taskList, workerApi.args(input)),
    memorySearch: (input) => workerApi.client.query(api.mcpRead.memorySearch, workerApi.args(input)),
    // G12b writes: token-gated mutations in apps/api/convex/mcpWrite.ts.
    taskCreate: (input) => workerApi.client.mutation(api.mcpWrite.taskCreate, workerApi.args(input)),
    threadSend: (input) => workerApi.client.mutation(api.mcpWrite.threadSend, workerApi.args(input)),
    runReportResult: (input) => workerApi.client.mutation(api.mcpWrite.runReportResult, workerApi.args(input)),
    questionAsk: (input) => workerApi.client.mutation(api.mcpWrite.questionAsk, workerApi.args(input)),
  };
}
