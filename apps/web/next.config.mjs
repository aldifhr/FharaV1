import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

// One .env for the whole repo: load the root .env first. apps/web/.env.local
// (if present) is still read by Next and keeps working as an override.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
nextEnv.loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production");

const c = { reactStrictMode: true };
export default c;
