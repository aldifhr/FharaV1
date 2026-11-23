export type Id<T extends string = string> = string & { __tableName?: T };

export interface Validator<T = any> {
  readonly __type?: T;
  kind: string;
  isOptional: "optional" | "required";
  isFharaRuntimeValidator: true;
  [key: string]: any;
}

export type Infer<T> = T extends Validator<infer U> ? U : never;

const required = <T>(validator: Omit<Validator<T>, "isOptional">): Validator<T> => ({
  ...validator,
  isOptional: "required",
}) as Validator<T>;

const optionalValidator = <T>(validator: Validator<T>): Validator<T | undefined> =>
  ({ ...validator, isOptional: "optional" }) as Validator<T | undefined>;

export const v = {
  string: (): Validator<string> => required({ kind: "string", isFharaRuntimeValidator: true }),
  number: (): Validator<number> => required({ kind: "float64", isFharaRuntimeValidator: true }),
  float64: (): Validator<number> => required({ kind: "float64", isFharaRuntimeValidator: true }),
  int64: (): Validator<number> => required({ kind: "int64", isFharaRuntimeValidator: true }),
  boolean: (): Validator<boolean> => required({ kind: "boolean", isFharaRuntimeValidator: true }),
  null: (): Validator<null> => required({ kind: "null", isFharaRuntimeValidator: true }),
  any: (): Validator<any> => required({ kind: "any", isFharaRuntimeValidator: true }),
  bytes: (): Validator<ArrayBuffer> => required({ kind: "bytes", isFharaRuntimeValidator: true }),
  id: <T extends string = string>(_tableName?: T): Validator<Id<T>> =>
    required({ kind: "id", tableName: _tableName, isFharaRuntimeValidator: true }) as unknown as Validator<Id<T>>,
  literal: <T extends string | number | boolean>(value: T): Validator<T> =>
    required({ kind: "literal", value, isFharaRuntimeValidator: true }),
  optional: optionalValidator,
  array: <T>(element: Validator<T>): Validator<T[]> =>
    required({ kind: "array", element, isFharaRuntimeValidator: true }),
  object: <T extends Record<string, Validator<any>>>(fields: T): Validator<{
    [K in keyof T as undefined extends Infer<T[K]> ? never : K]: Infer<T[K]>;
  } & {
    [K in keyof T as undefined extends Infer<T[K]> ? K : never]?: Exclude<Infer<T[K]>, undefined>;
  }> =>
    required({ kind: "object", fields, isFharaRuntimeValidator: true }) as any,
  record: <T>(key: Validator<string>, value: Validator<T>): Validator<Record<string, T>> =>
    required({ kind: "record", key, value, isFharaRuntimeValidator: true }) as unknown as Validator<Record<string, T>>,
  union: <T extends Validator<any>[]>(...members: T): Validator<Infer<T[number]>> =>
    required({ kind: "union", members, isFharaRuntimeValidator: true }) as unknown as Validator<Infer<T[number]>>,
};
