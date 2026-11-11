/**
 * Side-effect module: loads the repo-root .env. The entrypoint imports it
 * FIRST, so every module evaluated after it (including values read once at
 * module load, D14: DIRECT_POLL_MS, COMMAND_APPROVAL_TIMEOUT_MS, the worker
 * LLM gate, the round-robin sticky limit) already sees the .env values.
 * Before this, dotenv ran in index.ts's body, after every import had been
 * evaluated, so those reads saw only the shell env.
 */
import dotenv from "dotenv";
import { ROOT_ENV_FILE } from "./rootEnv";

dotenv.config({ path: ROOT_ENV_FILE });
