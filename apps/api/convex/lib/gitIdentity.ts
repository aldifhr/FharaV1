/**
 * The git identity Fhara commits and merges as. Passed per command
 * (`git -c user.name=… -c user.email=… <cmd>`) because a fresh clone, a CI
 * box or a container often has no global git config, and the child env is
 * scrubbed by buildChildEnv (no GIT_AUTHOR_* / GIT_COMMITTER_* reach git),
 * so `git merge`/`git commit` would otherwise fail with "Committer identity
 * unknown". Operators override it with FHARA_GIT_AUTHOR_NAME /
 * FHARA_GIT_AUTHOR_EMAIL, read from the PARENT env. Pure: safe to bundle.
 */

export const DEFAULT_GIT_AUTHOR_NAME = "Fhara";
export const DEFAULT_GIT_AUTHOR_EMAIL = "fhara@users.noreply.github.com";

export interface GitIdentity {
  name: string;
  email: string;
}

function clean(value: string | undefined): string | undefined {
  // Newlines/NULs would break the -c value; angle brackets break the ident.
  const trimmed = value?.replace(/[\u0000-\u001f<>]/g, "").trim();
  return trimmed ? trimmed : undefined;
}

export function gitIdentity(
  source: Record<string, string | undefined> = typeof process !== "undefined" && process.env ? process.env : {}
): GitIdentity {
  return {
    name: clean(source.FHARA_GIT_AUTHOR_NAME) ?? DEFAULT_GIT_AUTHOR_NAME,
    email: clean(source.FHARA_GIT_AUTHOR_EMAIL) ?? DEFAULT_GIT_AUTHOR_EMAIL,
  };
}

/** `-c user.name=… -c user.email=…`, to put before the git subcommand. */
export function gitIdentityArgs(identity: GitIdentity = gitIdentity()): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}
