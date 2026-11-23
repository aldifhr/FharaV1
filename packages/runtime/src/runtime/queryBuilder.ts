import type { LocalDatabase, LocalDoc } from "../db";
import { tableMeta } from "../schemaMeta";

type Operator = "eq" | "lt" | "lte" | "gt" | "gte";

interface RangeCondition {
  field: string;
  operator: Operator;
  value: unknown;
}

interface QuerySpec {
  table: string;
  indexName?: string;
  indexFields: string[];
  conditions: RangeCondition[];
  order: "asc" | "desc";
  searchTerm?: string;
  searchIndex?: string;
  filters: Array<(doc: any) => boolean>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) return a === b;
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function fieldAccessor(path: string): (doc: any) => unknown {
  return (doc) => path.split(".").reduce<any>((value, key) => value?.[key], doc);
}

function makeFilterBuilder() {
  const accessor = (input: unknown): ((doc: any) => unknown) =>
    typeof input === "string" ? fieldAccessor(input) : (input as (doc: any) => unknown);
  const compare = (operator: Operator, left: unknown, right: unknown) => (doc: any) => {
    const a = accessor(left)(doc);
    const b = accessor(right)(doc);
    const result = compareValues(a, b);
    switch (operator) {
      case "eq": return sameValue(a, b);
      case "lt": return result < 0;
      case "lte": return result <= 0;
      case "gt": return result > 0;
      case "gte": return result >= 0;
    }
  };
  return {
    field: fieldAccessor,
    eq: (left: unknown, right: unknown) => compare("eq", left, right),
    lt: (left: unknown, right: unknown) => compare("lt", left, right),
    lte: (left: unknown, right: unknown) => compare("lte", left, right),
    gt: (left: unknown, right: unknown) => compare("gt", left, right),
    gte: (left: unknown, right: unknown) => compare("gte", left, right),
    or: (...predicates: Array<(doc: any) => boolean>) => (doc: any) =>
      predicates.some((predicate) => predicate(doc)),
    and: (...predicates: Array<(doc: any) => boolean>) => (doc: any) =>
      predicates.every((predicate) => predicate(doc)),
    not: (predicate: (doc: any) => boolean) => (doc: any) => !predicate(doc),
  };
}

class ConditionBuilder {
  constructor(private readonly spec: QuerySpec) {}

  private add(operator: Operator, field: string, value: unknown): this {
    this.spec.conditions.push({ operator, field, value });
    return this;
  }

  eq(field: string, value: unknown): this { return this.add("eq", field, value); }
  lt(field: string, value: unknown): this { return this.add("lt", field, value); }
  lte(field: string, value: unknown): this { return this.add("lte", field, value); }
  gt(field: string, value: unknown): this { return this.add("gt", field, value); }
  gte(field: string, value: unknown): this { return this.add("gte", field, value); }
  search(_field: string, term: string): this {
    this.spec.searchTerm = term;
    return this;
  }
}

export class LocalQuery {
  private readonly spec: QuerySpec;

  constructor(private readonly db: LocalDatabase, table: string) {
    this.spec = { table, indexFields: [], conditions: [], order: "asc", filters: [] };
  }

  withIndex(name: string, callback?: (q: ConditionBuilder) => ConditionBuilder): this {
    const index = tableMeta(this.spec.table).indexes.find((entry) => entry.name === name);
    this.spec.indexName = name;
    this.spec.indexFields = index?.fields ?? [];
    if (callback) callback(new ConditionBuilder(this.spec));
    return this;
  }

  withSearchIndex(name: string, callback: (q: ConditionBuilder) => ConditionBuilder): this {
    const index = tableMeta(this.spec.table).searchIndexes.find((entry) => entry.name === name);
    if (!index) throw new Error(`Unknown search index ${this.spec.table}.${name}`);
    this.spec.searchIndex = name;
    this.spec.conditions.push({ operator: "eq", field: index.searchField, value: undefined });
    this.spec.indexFields = [];
    callback(new ConditionBuilder(this.spec));
    this.spec.conditions = this.spec.conditions.filter(
      (condition) => !(condition.field === index.searchField && condition.value === undefined)
    );
    return this;
  }

  order(direction: "asc" | "desc"): this {
    this.spec.order = direction;
    return this;
  }

  filter(callback: (q: ReturnType<typeof makeFilterBuilder>) => (doc: any) => boolean): this {
    this.spec.filters.push(callback(makeFilterBuilder()));
    return this;
  }

  private evaluate(): LocalDoc[] {
    let docs: LocalDoc[];
    if (this.spec.searchTerm !== undefined && this.spec.searchIndex) {
      const ids = this.db.search(this.spec.table, this.spec.searchIndex, this.spec.searchTerm);
      docs = ids.map((id) => this.db.get(this.spec.table, id)).filter((doc): doc is LocalDoc => doc !== null);
    } else {
      docs = this.db.all(this.spec.table);
    }

    for (const condition of this.spec.conditions) {
      docs = docs.filter((doc) => {
        const value = doc[condition.field];
        switch (condition.operator) {
          case "eq": return sameValue(value, condition.value);
          case "lt": return compareValues(value, condition.value) < 0;
          case "lte": return compareValues(value, condition.value) <= 0;
          case "gt": return compareValues(value, condition.value) > 0;
          case "gte": return compareValues(value, condition.value) >= 0;
        }
      });
    }
    for (const predicate of this.spec.filters) docs = docs.filter(predicate);

    const sortFields = [...this.spec.indexFields, "_creationTime"];
    docs.sort((a, b) => {
      for (const field of sortFields) {
        const result = compareValues(a[field], b[field]);
        if (result !== 0) return result;
      }
      return compareValues(a._id, b._id);
    });
    if (this.spec.order === "desc") docs.reverse();
    return docs;
  }

  async first(): Promise<any> {
    return this.evaluate()[0] ?? null;
  }

  async take(limit: number): Promise<any[]> {
    return this.evaluate().slice(0, limit);
  }

  async collect(): Promise<any[]> {
    return this.evaluate();
  }

  async unique(): Promise<any> {
    const docs = this.evaluate();
    if (docs.length > 1) throw new Error(`Expected one document, found ${docs.length}`);
    return docs[0] ?? null;
  }

  async paginate(options: { numItems: number; cursor?: string | null }): Promise<{
    page: LocalDoc[];
    isDone: boolean;
    continueCursor: string;
  }> {
    const docs = this.evaluate();
    const offset = options.cursor ? Number(Buffer.from(options.cursor, "base64").toString("utf8")) : 0;
    const page = docs.slice(offset, offset + options.numItems);
    const end = offset + page.length;
    return {
      page,
      isDone: end >= docs.length,
      continueCursor: Buffer.from(String(end)).toString("base64"),
    };
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any> {
    for (const doc of this.evaluate()) yield doc;
  }

  then<TResult1 = LocalDoc[], TResult2 = never>(
    onfulfilled?: ((value: LocalDoc[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.collect().then(onfulfilled, onrejected);
  }
}
