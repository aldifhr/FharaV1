import { v } from "./values";

export function getFunctionName(reference: any): string {
  if (typeof reference === "string") return reference;
  const path = reference?.__fharaPath;
  if (typeof path === "string") return path;
  throw new Error("Unsupported function reference; local references must come from the local api module");
}

export function makeFunctionReference(name: string): any {
  const target = function () {} as any;
  Object.defineProperty(target, "__fharaPath", { value: name, enumerable: false });
  return target;
}

export const paginationOptsValidator = v.object({
  numItems: v.number(),
  cursor: v.optional(v.union(v.string(), v.null())),
  endCursor: v.optional(v.union(v.string(), v.null())),
  maximumBytes: v.optional(v.number()),
});

class TableDefinition {
  indexes: Array<{ indexDescriptor: string; fields: string[] }> = [];
  searchIndexes: Array<{ indexDescriptor: string; searchField: string; filterFields: string[] }> = [];
  vectorIndexes: any[] = [];
  stagedDbIndexes: any[] = [];
  stagedSearchIndexes: any[] = [];
  stagedVectorIndexes: any[] = [];

  readonly validator: any;

  constructor(fields: any) {
    this.validator = { kind: "object", isOptional: "required", isFharaRuntimeValidator: true, fields };
  }

  index(name: string, fields: string[]): this {
    this.indexes.push({ indexDescriptor: name, fields: [...fields] });
    return this;
  }

  searchIndex(name: string, config: { searchField: string; filterFields?: string[] }): this {
    this.searchIndexes.push({
      indexDescriptor: name,
      searchField: config.searchField,
      filterFields: [...(config.filterFields ?? [])],
    });
    return this;
  }

  vectorIndex(...args: any[]): this {
    this.vectorIndexes.push(args);
    return this;
  }
}

export function defineTable(validator: any): TableDefinition {
  return new TableDefinition(validator);
}

export function defineSchema(tables: Record<string, TableDefinition>): any {
  return { tables, strictTableNameTypes: true, schemaValidation: true };
}

export function cronJobs(_configure?: (scheduler: any) => void): any {
  return {};
}

export function httpRouter(): any {
  const routes: any[] = [];
  return {
    routes,
    get: (...args: any[]) => { routes.push(["get", ...args]); return (handler: any) => handler; },
    post: (...args: any[]) => { routes.push(["post", ...args]); return (handler: any) => handler; },
  };
}

export const queryGeneric = () => ({});
export const mutationGeneric = () => ({});
export const actionGeneric = () => ({});
export const internalQueryGeneric = () => ({});
export const internalMutationGeneric = () => ({});
export const internalActionGeneric = () => ({});
export const httpActionGeneric = () => ({});

export const componentsGeneric = () => makeFunctionReference("components");

export type FunctionReturnType<T> = any;
export type FunctionArgs<T> = any;
export type FunctionReference<A = any, R = any, C = any, P = any> = any;
export type DataModel = any;
export type GenericDataModel = any;
export type GenericQueryCtx<T = any> = any;
export type GenericMutationCtx<T = any> = any;
export type GenericActionCtx<T = any> = any;
