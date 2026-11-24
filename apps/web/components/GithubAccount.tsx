import { useState } from "react";
import { useAction, useMutation, useQuery } from "@fhara/runtime/react";
import { GitBranch } from "lucide-react";
import { api } from "@fhara/runtime/api";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { useToast } from "./Toasts";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.";

const GHOST_BTN = "rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50";
const PRIMARY_BTN =
  "rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50";

/**
 * Plan 079: GitHub access comes from the operator's Git credential helper
 * (https://git-scm.com/). There is no OAuth app, callback popup or client
 * id/secret. Importing runs `git credential fill` on the machine running
 * Fhara and seals the token in the backend; disconnect keeps the
 * per-project repository choices.
 */
export default function GithubAccountRow({
  alwaysShowReconnect = false,
}: {
  /** Settings → Account: offer "Refresh" even for a healthy connection. */
  alwaysShowReconnect?: boolean;
} = {}) {
  const toast = useToast();
  const account = useQuery(api.integrations.githubAccount, {});
  const importLocal = useAction(api.integrations.importLocalGithub);
  const disconnect = useMutation(api.integrations.disconnectGithub);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [removing, setRemoving] = useState(false);

  const connect = async () => {
    setStarting(true);
    try {
      const result = await importLocal({});
      if (!result.ok) {
        toast("error", "Couldn't read the Git credential", result.error);
        return;
      }
      toast("success", "GitHub connected from local git", result.login ? `@${result.login}` : undefined);
    } catch (err) {
      toast("error", "Couldn't read the Git credential", errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await disconnect({});
      toast("success", "GitHub disconnected");
      setConfirm(null);
    } catch (err) {
      toast("error", "Couldn't disconnect GitHub", errorText(err));
    } finally {
      setRemoving(false);
    }
  };

  let detail: string;
  let dot = "bg-ink-3";
  if (account === undefined) detail = "Loading…";
  else if (!account.canManage) detail = "Sign in to manage the GitHub connection.";
  else if (!account.connected) detail = "Not connected. Configure a Git credential helper for github.com, then import it below.";
  else if (account.status === "error") {
    detail = account.errorMessage ?? "Connection error";
    dot = "bg-red-500";
  } else if (account.source === "legacy") {
    detail = "Connected through an older per-project token. Import the local git login to make it account-wide.";
    dot = "bg-amber-500";
  } else {
    detail = account.login ? `Connected as @${account.login} using local git` : "Connected using local git";
    dot = "bg-emerald-500";
  }

  return (
    <>
      <li className="flex items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bubble text-ink-2">
          <GitBranch size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px]">GitHub account</p>
          <p className="truncate text-[12.5px] text-ink-3" title={detail}>{detail}</p>
        </div>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        {account?.canManage && (
          <>
            {account.connected && (
              <button
                type="button"
                className={`${GHOST_BTN} text-red-600 dark:text-red-400`}
                onClick={() =>
                  setConfirm({
                    title: "Disconnect GitHub?",
                    message: "Every project loses push and pull request access. Repository choices are kept, so reconnecting restores them.",
                    confirmLabel: "Disconnect",
                  })
                }
              >
                Disconnect
              </button>
            )}
            {alwaysShowReconnect || account.source !== "global" || account.status === "error" || !account.connected ? (
              <button type="button" disabled={starting} onClick={() => void connect()} className={PRIMARY_BTN}>
                {account.connected ? "Refresh" : "Use local git"}
              </button>
            ) : null}
          </>
        )}
      </li>
      <ConfirmDialog request={confirm} pending={removing} onCancel={() => setConfirm(null)} onConfirm={() => void remove()} />
    </>
  );
}
