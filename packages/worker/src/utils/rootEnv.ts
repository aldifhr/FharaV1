import { fileURLToPath } from "node:url";

/**
 * The repo-root .env, resolved from this file rather than the cwd (E4).
 * Same file as the old `path.resolve(process.cwd(), "../../.env")` when the
 * worker starts in packages/worker (npm run worker, supervise --cwd), and
 * still right when it starts anywhere else.
 */
export const ROOT_ENV_FILE = fileURLToPath(new URL("../../../../.env", import.meta.url));
