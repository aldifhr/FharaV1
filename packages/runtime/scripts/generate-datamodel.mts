import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import schema from "../../../apps/api/functions/schema";

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, "..", "src", "compat", "generatedDataModel.ts");

function tsType(validator: any): string {
  if (!validator || typeof validator !== "object") return "any";
  switch (validator.kind) {
    case "string":
    case "id":
      return "string";
    case "float64":
    case "int64":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "any":
    case "bytes":
      return "any";
    case "literal":
      return JSON.stringify(validator.value);
    case "array":
      return `Array<${tsType(validator.element)}>`;
    case "object":
      return `{ ${Object.entries<any>(validator.fields ?? {})
        .map(([key, field]) => `${JSON.stringify(key)}${field?.isOptional === "optional" ? "?" : ""}: ${tsType(field)}`)
        .join("; ")} }`;
    case "union":
      return (validator.members ?? []).map(tsType).join(" | ") || "any";
    case "record":
      return `Record<string, ${tsType(validator.value)}>`;
    default:
      return "any";
  }
}

const lines = [
  "// Generated from apps/api/functions/schema.ts by scripts/generate-datamodel.mts.",
  "// Do not edit by hand.",
  "",
  "export type Id<T extends string = string> = string;",
  "",
];

for (const [table, definition] of Object.entries<any>((schema as any).tables ?? {})) {
  const fields = Object.entries<any>(definition.validator?.fields ?? {})
    .map(([key, validator]) => `${JSON.stringify(key)}${validator?.isOptional === "optional" ? "?" : ""}: ${tsType(validator)}`)
    .join("; ");
  lines.push(`export type Doc_${table} = { ${fields} } & { _id: string; _creationTime: number };`);
}

lines.push("", "export interface DataModelMap {");
for (const table of Object.keys((schema as any).tables ?? {})) {
  lines.push(`  ${JSON.stringify(table)}: Doc_${table};`);
}
lines.push(
  "}",
  "",
  "export type Doc<T extends keyof DataModelMap> = DataModelMap[T];",
  "export type TableNames = keyof DataModelMap;",
  "export type DataModel = DataModelMap;",
  ""
);

fs.writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(`[local] generated document types for ${Object.keys((schema as any).tables ?? {}).length} tables`);
