"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { GitBranch } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { useToast } from "./Toasts";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.";

const GHOST_BTN = "rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50";
const PRIMARY_BTN =
  "rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50";

/**
 * Toasts for the OAuth popup's postMessage. Only messages from this app's
 * own origin count (the callback page posts to the web app origin).
 */
export function useGithubOAuthMessages() {
  const toast = useToast();
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; login?: string | null; error?: string } | null;
      if (data?.type === "github_oauth_success") toast("success", "GitHub connected", data.login ? `@${data.login}` : undefined);
      if (data?.type === "github_oauth_error") toast("error", "GitHub connection failed", String(data.error ?? ""));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [toast]);
}

/**
 * The account-level GitHub connection: one account for every project.
 * Lives in the top section of /integrations. Connect opens the OAuth popup
 * (the window is opened synchronously so popup blockers allow it, then
 * pointed at the signed URL from `integrations.getOAuthUrl`).
 */
export default function GithubAccountRow({
  returnTo = "/integrations",
  alwaysShowReconnect = false,
}: {
  /** Where the OAuth callback page sends the user back to. */
  returnTo?: string;
  /** Settings → Account: offer Reconnect even for a healthy connection. */
  alwaysShowReconnect?: boolean;
} = {}) {
  const toast = useToast();
  const account = useQuery(api.integrations.githubAccount, {});
  const getOAuthUrl = useAction(api.integrations.getOAuthUrl);
  const disconnect = useMutation(api.integrations.disconnectGithub);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [removing, setRemoving] = useState(false);
  useGithubOAuthMessages();

  const connect = async () => {
    const popup = window.open("", "github-oauth", "width=720,height=780");
    setStarting(true);
    try {
      const url = await getOAuthUrl({ returnTo });
      if (!url) {
        popup?.close();
        toast("error", "GitHub OAuth is not configured", "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on the Convex deployment.");
        return;
      }
      if (popup) popup.location.href = url;
      else window.location.href = url;
    } catch (err) {
      popup?.close();
      toast("error", "Couldn't start the GitHub connection", errorText(err));
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
  else if (!account.connected) detail = "Not connected. One account is used by every project for pushes and pull requests.";
  else if (account.status === "error") {
    detail = account.errorMessage ?? "Connection error";
    dot = "bg-red-500";
  } else if (account.source === "legacy") {
    detail = "Connected through an older per-project token. Reconnect to make it account-wide.";
    dot = "bg-amber-500";
  } else {
    detail = account.login ? `Connected as @${account.login}` : "Connected";
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
          <p className="truncate text-[12.5px] text-ink-3">{detail}</p>
        </div>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        {account?.canManage &&
          (!account.configured && !account.connected ? (
            <span className="text-[12.5px] text-ink-3" title="Set GITHUB_CLIENT_ID on the Convex deployment">
              OAuth app not configured
            </span>
          ) : (
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
              {account.configured && (alwaysShowReconnect || account.source !== "global" || account.status === "error" || !account.connected) && (
                <button type="button" disabled={starting} onClick={() => void connect()} className={PRIMARY_BTN}>
                  {account.connected ? "Reconnect" : "Connect"}
                </button>
              )}
            </>
          ))}
      </li>
      <ConfirmDialog request={confirm} pending={removing} onCancel={() => setConfirm(null)} onConfirm={() => void remove()} />
    </>
  );
}
