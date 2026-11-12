/**
 * The shape of one Fhara env var in the schema.
 *
 * E1 rule: the schema encodes TODAY's behaviour, quirks included. Each var
 * names the parse dialect its call site used before the migration, so a
 * read through the schema returns exactly what the old inline code did.
 * Unifying the dialects is a separate, labelled behaviour change (B1–B10).
 */

export type Runtime = "worker" | "convex" | "convexNode" | "webServer" | "webClient" | "electron" | "scripts";

export type EnvGroup =
  | "core"
  | "llm"
  | "github"
  | "usage"
  | "web"
  | "worker"
  | "policy"
  | "exec"
  | "git"
  | "qa"
  | "snapshots"
  | "threads"
  | "workspace"
  | "electron"
  | "scripts";

/** Read another var through the same source (derived defaults). */
export type EnvGet = (name: string) => unknown;
export type DefaultFn<T> = (get: EnvGet) => T;

/**
 * Number dialects found in the code before E1 (D6). `raw` is the value
 * after alias resolution; `d` the default. B3 moved the index.ts timers,
 * WORKER_CONCURRENCY and the LLM ints onto clampBlank
 * (no NaN, "" reads as the default, "10s" is rejected with a warning).
 *
 * - clamp:           `!raw` → d; Number; not finite → d; floor; clamp(min,max).            (policy.ts intFromEnv)
 * - clampBlank:      undefined/blank → d; Number; not finite → d; [0 = off]; floor; clamp. (stallDetector intEnv)
 * - nullishNumber:   Number(raw ?? d); [floor]; not finite → d; clamp. "" reads as 0.
 * - atLeast:         Number(raw); finite and ≥ min (or > 0 when `positive`) → [floor] value; else d.
 * - truthyNumber:    Number(raw) || d.                                                       (roundRobin)
 * - truthyRawNumber: raw ? Number(raw) : NaN; finite → value; else d. "0" reads as 0.       (llmCall worker gate)
 */
export type NumberParse =
  | "clamp"
  | "clampBlank"
  | "nullishNumber"
  | "atLeast"
  | "truthyNumber"
  | "truthyRawNumber";

/**
 * Booleans (B2): one dialect for every bool var. Unset or blank → the
 * default; 1|true|yes|on → true; 0|false|no|off → false (trimmed,
 * case-insensitive); anything else warns and keeps the default.
 * Before B2 there were five dialects (D5): falsyList, truthyList, neq0,
 * neq0Trim and eq1.
 */
export type BoolParse = "bool";

/**
 * String dialects.
 * - nullish: raw ?? d ("" stays "").
 * - trimOr:  raw?.trim() || d.
 * - or:      raw || d ("" reads as d, no trim).                (electron DEV_SERVER_URL)
 * - lower:   (raw ?? d).toLowerCase().
 */
export type StringParse = "nullish" | "trimOr" | "or" | "lower";

/** Settings-modal knob metadata (apps/api/convex/lib/appSettings.ts SETTING_KNOBS). */
export interface KnobMeta {
  reader: "worker" | "api" | "both";
  /** Only where the UI default is not the code default as a string (derived or tristate defaults). */
  defaultValue?: string;
  /** Only where the UI bounds differ from the code's parse bounds. */
  min?: number;
  max?: number;
  maxLength?: number;
}

interface VarBase {
  name: string;
  runtimes: readonly Runtime[];
  group: EnvGroup;
  /** One line, rendered into .env.example and the README later (E4). */
  doc: string;
  /** Legacy names, read in order after `name` with `??` (an empty string on `name` wins). */
  aliases?: readonly string[];
  /** Feeds SECRET_ENV_NAMES (redactor, child-env block list). */
  secret?: boolean;
  /** Fail-fast candidates in these runtimes (validated from E4 on; informational in E1). */
  required?: readonly Runtime[];
  /** "startup": read once at module load today (D14). */
  readAt?: "startup" | "call";
  knob?: KnobMeta;
  /** CONVEX_SITE_URL: provided by Convex itself, never synced. */
  convexSystem?: boolean;
  deprecated?: string;
  /** Known quirk kept on purpose in E1, with the behaviour PR that fixes it. */
  quirk?: string;
}

export interface NumberVar extends VarBase {
  type: "int";
  parse: NumberParse;
  default: number | DefaultFn<number>;
  min?: number;
  max?: number;
  /** nullishNumber / atLeast: floor the value. */
  floor?: boolean;
  /** atLeast: require > 0 instead of ≥ min. */
  positive?: boolean;
  /** clampBlank: an explicit 0 turns the feature off instead of clamping up. */
  zeroMeansOff?: boolean;
  /** clampBlank: a value ≤ 0 reads as the default ("default") or as 0 = off ("off"). */
  nonPositive?: "default" | "off";
}

export interface BoolVar extends VarBase {
  type: "bool";
  parse?: BoolParse;
  default: boolean | DefaultFn<boolean>;
}

/** QA_CHROMIUM_NO_SANDBOX: unset/blank/auto = auto (undefined), bool words = on/off. Settings shows it as auto / true / false. */
export interface TristateVar extends VarBase {
  type: "tristate";
  /** Written after `NAME=` in .env.example; blank (unset = auto) unless set. */
  exampleValue?: string;
}

export interface EnumVar extends VarBase {
  type: "enum";
  options: readonly string[];
  default: string;
  /** Matched as typed (after trim) instead of lowercased. */
  caseSensitive?: boolean;
  /** Input aliases mapped before matching, e.g. { opencode: "native-provider" }. */
  map?: Readonly<Record<string, string>>;
}

export interface StringVar extends VarBase {
  type: "string" | "url" | "path" | "csv" | "base64key32";
  parse?: StringParse;
  default?: string | DefaultFn<string>;
  maxLength?: number;
}

export type EnvVar = NumberVar | BoolVar | TristateVar | EnumVar | StringVar;

/** The value type a var reads as. */
export type VarValue<D> = D extends { type: "int" }
  ? number
  : D extends { type: "bool" }
    ? boolean
    : D extends { type: "tristate" }
      ? boolean | undefined
      : D extends { type: "enum"; options: readonly (infer O)[] }
        ? O
        : D extends { default: string | DefaultFn<string> }
          ? string
          : string | undefined;
