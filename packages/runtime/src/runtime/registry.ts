export type FunctionKind =
  | "query"
  | "mutation"
  | "action"
  | "internalQuery"
  | "internalMutation"
  | "internalAction"
  | "httpAction";

export interface FunctionDefinition {
  kind: FunctionKind;
  definition: any;
  path: string;
}

export const registry = new Map<string, FunctionDefinition>();

export const FUNCTION_MARKER = Symbol.for("fharaLocalFunction");

export function markFunction(definition: any, kind: FunctionKind): any {
  return { [FUNCTION_MARKER]: { kind, definition } };
}

export function registerModules(modules: Record<string, unknown>): void {
  for (const [moduleName, namespace] of Object.entries(modules)) {
    if (!namespace || typeof namespace !== "object") continue;
    for (const [exportName, value] of Object.entries(namespace as Record<string, unknown>)) {
      const marker = (value as any)?.[FUNCTION_MARKER];
      if (!marker) continue;
      const path = exportName === "default" ? moduleName : `${moduleName}:${exportName}`;
      registry.set(path, { kind: marker.kind, definition: marker.definition, path });
    }
  }
}

export function getFunction(path: string): FunctionDefinition {
  const found = registry.get(path);
  if (!found) throw new Error(`Unknown local function: ${path}`);
  return found;
}
