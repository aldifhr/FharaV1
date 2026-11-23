import schema from "../../../apps/api/functions/schema";

export type StorageKind = "text" | "number" | "integer" | "boolean" | "json";

export interface FieldMeta {
  name: string;
  kind: StorageKind;
  required: boolean;
}

export interface IndexMeta {
  name: string;
  fields: string[];
}

export interface SearchIndexMeta {
  name: string;
  searchField: string;
  filterFields: string[];
}

export interface TableMeta {
  name: string;
  fields: FieldMeta[];
  indexes: IndexMeta[];
  searchIndexes: SearchIndexMeta[];
}

function storageKind(validator: any): StorageKind {
  const kind = validator?.kind;
  if (kind === "number" || kind === "float64" || kind === "float32") return "number";
  if (kind === "boolean") return "boolean";
  if (kind === "int64") return "integer";
  if (kind === "string" || kind === "id" || kind === "literal") return "text";
  if (kind === "union") {
    const members: any[] = Array.isArray(validator.members) ? validator.members : [];
    if (members.length > 0 && members.every((m) => m?.kind === "literal")) return "text";
    return "json";
  }
  return "json";
}

const tables = new Map<string, TableMeta>();

for (const [name, table] of Object.entries<any>((schema as any).tables ?? {})) {
  const fields: FieldMeta[] = [];
  for (const [fieldName, validator] of Object.entries<any>(table.validator?.fields ?? {})) {
    fields.push({
      name: fieldName,
      kind: storageKind(validator),
      required: validator?.isOptional === "required",
    });
  }
  const indexes: IndexMeta[] = (table.indexes ?? []).map((index: any) => ({
    name: index.indexDescriptor,
    fields: (index.fields ?? []).map(String),
  }));
  const searchIndexes: SearchIndexMeta[] = (table.searchIndexes ?? []).map((index: any) => ({
    name: index.indexDescriptor,
    searchField: index.searchField,
    filterFields: (index.filterFields ?? []).map(String),
  }));
  tables.set(name, { name, fields, indexes, searchIndexes });
}

export function tableMeta(name: string): TableMeta {
  const meta = tables.get(name);
  if (!meta) throw new Error(`Unknown table: ${name}`);
  return meta;
}

export function tableNames(): string[] {
  return [...tables.keys()];
}

export function fieldKinds(name: string): Map<string, StorageKind> {
  return new Map(tableMeta(name).fields.map((field) => [field.name, field.kind]));
}

export function columnFor(field: string): string {
  return field === "_id" ? "id" : field;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
