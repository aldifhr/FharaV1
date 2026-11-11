import { fileURLToPath } from "node:url";

/**
 * The repo-root .env, resolved from this file rather than the cwd (E4).
 * Same file as the old `path.resolve(process.cwd(), "../../.env")` when the
 * worker starts in packages/worker (npm run worker, supervise --cwd), and
 * still right when it starts anywhere else.
 */
export const ROOT_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));

/**
 * packages/worker, file-relative. B7: a relative WORKSPACE_ROOT is measured
 * from here, whatever the process cwd (same as before when the worker is
 * started in packages/worker, as npm run worker and supervise do).
 */
export const WORKER_DIR = fileURLToPath(new URL("../../", import.meta.url));
