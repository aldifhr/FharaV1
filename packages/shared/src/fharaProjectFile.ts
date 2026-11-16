import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { FharaProjectFile, FHARA_PROJECT_FILE_SCHEMA_URL } from "@fhara/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const FharaProjectFileFromJson = fromLenientJson(FharaProjectFile);

const decodeFharaProjectFile = Schema.decodeExit(FharaProjectFileFromJson);

export function parseFharaProjectFile(contents: string): FharaProjectFile | null {
  const decoded = decodeFharaProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildFharaProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(FharaProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: FHARA_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
