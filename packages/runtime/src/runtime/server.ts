import { markFunction, type FunctionKind } from "./registry";
import type { LocalQuery } from "./queryBuilder";
import type { Infer, Validator } from "../compat/values";

export interface LocalCtx {
  db: {
    get(id: string): Promise<any>;
    query(table: string): LocalQuery;
    insert(table: string, value: Record<string, unknown>): Promise<string>;
    patch(id: string, patch: Record<string, unknown>): Promise<any>;
    replace(id: string, value: Record<string, unknown>): Promise<any>;
    delete(id: string): Promise<any>;
    system: { get(id: string): Promise<any> };
    normalizeId(table: string, id: string): string | null;
  };
  runQuery<T = any>(reference: any, args?: Record<string, unknown>): Promise<T>;
  runMutation<T = any>(reference: any, args?: Record<string, unknown>): Promise<T>;
  runAction<T = any>(reference: any, args?: Record<string, unknown>): Promise<T>;
  scheduler: {
    runAfter(delayMs: number, reference: any, args?: Record<string, unknown>): any;
    runAt(timestamp: number, reference: any, args?: Record<string, unknown>): any;
  };
  storage: {
    generateUploadUrl(): Promise<string>;
    getUrl(id: string): Promise<string | null>;
    delete(id: string): Promise<void>;
  };
  auth: { getUserIdentity(): Promise<any> };
}

type ArgsOf<A extends Record<string, Validator<any>>> = {
  [K in keyof A as undefined extends Infer<A[K]> ? never : K]: Infer<A[K]>;
} & {
  [K in keyof A as undefined extends Infer<A[K]> ? K : never]?: Infer<A[K]>;
};

interface FunctionDef<A extends Record<string, Validator<any>>> {
  args?: A;
  returns?: any;
  handler: (ctx: LocalCtx, args: ArgsOf<A>) => any;
}

const define =
  (kind: FunctionKind) =>
  <A extends Record<string, Validator<any>>>(definition: FunctionDef<A>): any =>
    markFunction(definition, kind);

export const query = define("query");
export const mutation = define("mutation");
export const action = define("action");
export const internalQuery = define("internalQuery");
export const internalMutation = define("internalMutation");
export const internalAction = define("internalAction");
export const httpAction = (
  definition: { handler: (ctx: any, request: any) => any } | ((ctx: any, request: any) => any)
): any => markFunction(definition, "httpAction");

export type QueryCtx = LocalCtx;
export type MutationCtx = LocalCtx;
export type ActionCtx = LocalCtx;
export type GenericQueryCtx<T = any> = LocalCtx;
export type GenericMutationCtx<T = any> = LocalCtx;
export type GenericActionCtx<T = any> = LocalCtx;
