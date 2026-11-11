/**
 * B7 (D8): the one rule for where a project's workspace lives, shared by
 * the worker, the web file preview and the Convex node actions. Before B7
 * each had its own copy, resolved against a different base.
 *
 *   absolute project path → that path (normalised)
 *   relative project path → <anchor>/<root>/<path>
 *
 * `root` is WORKSPACE_ROOT (default ./workspaces) and `anchor` the
 * directory a relative root is measured from: the worker package
 * (packages/worker), which is what the docs always said ("relative to the
 * worker's cwd"). Path functions are passed in so this package keeps no
 * node: imports.
 */
export interface PathApi {
  isAbsolute(p: string): boolean;
  resolve(...segments: string[]): string;
}

/** The absolute workspace root: WORKSPACE_ROOT measured from the anchor. */
export function workspaceRootDir(root: string, anchor: string, path: PathApi): string {
  return path.resolve(anchor, root);
}

/** A project's workspace directory. */
export function resolveProjectPath(configured: string, root: string, anchor: string, path: PathApi): string {
  if (path.isAbsolute(configured)) return path.resolve(configured);
  return path.resolve(workspaceRootDir(root, anchor, path), configured);
}
