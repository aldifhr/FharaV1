/** Types for make-synthetic.mjs (plain Node, imported by the fixture tests). */
export declare const BASE: number;
export interface BuiltFixture {
  scenario: { format: number; id: string; title: string; base: number; anchor: number; rows: Record<string, Array<Record<string, unknown>>> };
  events: Array<Record<string, unknown> & { table: "taskEvents" | "agentEvents" }>;
}
export declare function buildAll(): BuiltFixture[];
