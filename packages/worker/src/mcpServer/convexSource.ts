/**
 * GOAT G12a: `McpReadSource` over the token-gated Convex queries in
 * apps/api/convex/mcpRead.ts, through the worker's WorkerApi client (its
 * `args()` adds the service token). Read-only: no mutation is reachable
 * from here.
 */
import { api } from "@/api/convex/_generated/api";
import type { WorkerApi } from "@/workerApi";
import type { McpReadSource } from "./types";

export function convexMcpSource(workerApi: WorkerApi): McpReadSource {
  return {
    taskStatus: (input) => workerApi.client.query(api.mcpRead.taskStatus, workerApi.args(input)),
    taskList: (input) => workerApi.client.query(api.mcpRead.taskList, workerApi.args(input)),
    memorySearch: (input) => workerApi.client.query(api.mcpRead.memorySearch, workerApi.args(input)),
  };
}
