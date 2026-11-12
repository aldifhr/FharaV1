/**
 * Typed as an opaque style definition: the shipped JSON is ~120 KB and TS
 * would otherwise infer a literal type for every node in it.
 */
declare module "@dicebear/styles/lorelei.json" {
  const definition: Record<string, unknown>;
  export default definition;
}
