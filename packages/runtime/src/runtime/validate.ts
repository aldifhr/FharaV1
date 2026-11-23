function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOne(path: string, value: unknown, validator: any): string[] {
  if (!validator || typeof validator !== "object") return [];
  if (value === undefined) {
    return validator.isOptional === "optional" ? [] : [`${path} is required`];
  }

  switch (validator.kind) {
    case "any":
      return [];
    case "string":
    case "id":
      return typeof value === "string" ? [] : [`${path} must be a string`];
    case "float64":
      return typeof value === "number" && Number.isFinite(value) ? [] : [`${path} must be a number`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
    case "null":
      return value === null ? [] : [`${path} must be null`];
    case "literal":
      return value === validator.value ? [] : [`${path} must be ${JSON.stringify(validator.value)}`];
    case "bytes":
      return value instanceof Uint8Array || value instanceof ArrayBuffer ? [] : [`${path} must be bytes`];
    case "array": {
      if (!Array.isArray(value)) return [`${path} must be an array`];
      const errors: string[] = [];
      value.forEach((item, index) => errors.push(...validateOne(`${path}[${index}]`, item, validator.element)));
      return errors;
    }
    case "object": {
      if (!isRecord(value)) return [`${path} must be an object`];
      const fields: Record<string, any> = validator.fields ?? {};
      const errors: string[] = [];
      for (const [key, fieldValue] of Object.entries(value)) {
        if (!(key in fields)) {
          errors.push(`${path}.${key} is not an allowed field`);
          continue;
        }
        errors.push(...validateOne(`${path}.${key}`, fieldValue, fields[key]));
      }
      return errors;
    }
    case "record": {
      if (!isRecord(value)) return [`${path} must be a record`];
      const errors: string[] = [];
      for (const [key, fieldValue] of Object.entries(value)) {
        errors.push(...validateOne(`${path}.${key}`, fieldValue, validator.value));
      }
      return errors;
    }
    case "union": {
      const members: any[] = validator.members ?? [];
      if (members.some((member) => validateOne(path, value, member).length === 0)) return [];
      return [`${path} does not match any allowed shape`];
    }
    default:
      return [];
  }
}

export function validateArgs(args: unknown, argsValidator: any): string[] {
  if (argsValidator === undefined) return [];
  if (!isRecord(args)) return ["arguments must be an object"];
  const errors: string[] = [];
  const fields: Record<string, any> = argsValidator?.fields ?? argsValidator ?? {};
  for (const [key, fieldValue] of Object.entries(args)) {
    if (!(key in fields)) {
      errors.push(`${key} is not an allowed argument`);
      continue;
    }
    errors.push(...validateOne(key, fieldValue, fields[key]));
  }
  return errors;
}
