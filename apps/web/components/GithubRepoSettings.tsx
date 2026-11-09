"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { GitBranch, Loader2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.");
const INPUT =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-base sm:text-sm dark:border-white/15 dark:bg-[#1c1c1f] dark:text-neutral-100";

type Repo = { fullName: string; owner: string; name: string; defaultBranch: string; private: boolean };

/**
 * Plan 019: GitHub connection and push target for a project. Connecting
 * reuses the existing OAuth flow (integrations.getOAuthUrl → GitHub →
 * /api/integrations/github/callback → Convex http action). The token
 * never reaches the browser; this panel only sees `hasAccessToken`.
 */
export default function GithubRepoSettings({ projectId }: { projectId: string }) {
  const toast = useToast();
  const integrations = useQuery(api.integrations.listByProject, { projectId: projectId as any });
  const oauthUrl = useQuery(api.integrations.getOAuthUrl, { projectId: projectId as any });
  const listRepos = useAction(api.integrations.listGithubRepos);
  const updateConfig = useMutation(api.integrations.updateConfig);
  const disconnect = useMutation(api.integrations.remove);
  const github = (integrations ?? []).find((row: any) => row.type === "github" && row.status !== "disconnected");

  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoFullName, setRepoFullName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!github) return;
    setRepoFullName(github.githubOwner && github.githubRepo ? `${github.githubOwner}/${github.githubRepo}` : "");
    setBaseBranch(github.githubBaseBranch ?? "");
  }, [github?._id, github?.githubOwner, github?.githubRepo, github?.githubBaseBranch]); // eslint-disable-line react-hooks/exhaustive-deps

  // The OAuth popup reports back with postMessage; Convex pushes the new
  // integration row by itself, so only the toast is needed here.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type === "github_oauth_success") toast("success", "GitHub connected");
      if (type === "github_oauth_error") toast("error", "GitHub connection failed", String((event.data as any).error ?? ""));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [toast]);

  const loadRepos = async () => {
    if (!github) return;
    setLoadingRepos(true);
    try {
      setRepos(await listRepos({ integrationId: github._id }));
    } catch (err) {
      toast("error", "Couldn't load repositories", errorText(err));
    } finally {
      setLoadingRepos(false);
    }
  };

  const save = async () => {
    if (!github) return;
    const [owner, name] = repoFullName.split("/");
    if (!owner || !name) {
      toast("error", "Choose a repository as owner/name");
      return;
    }
    setSaving(true);
    try {
      await updateConfig({
        integrationId: github._id,
        githubOwner: owner.trim(),
        githubRepo: name.trim(),
        githubBaseBranch: baseBranch.trim(),
      });
      toast("success", "Push target saved");
    } catch (err) {
      toast("error", "Couldn't save the repository", errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-5 border-t border-gray-200 pt-4 dark:border-white/10">
      <div className="flex items-center gap-2">
        <GitBranch size={16} aria-hidden="true" />
        <h3 className="text-sm font-semibold">GitHub</h3>
        {github && (
          <span className="rounded-md bg-[#e9f8ef] px-1.5 py-0.5 text-[11px] font-medium text-[#1f8a4c] dark:bg-emerald-500/15 dark:text-emerald-300">
            {github.status === "error" ? "error" : "connected"}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
        Task branches are pushed and draft PRs opened only after you click Approve push on a push card.
      </p>

      {integrations === undefined ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-gray-500"><Loader2 size={13} className="animate-spin" /> Loading…</p>
      ) : !github ? (
        <div className="mt-3">
          {oauthUrl ? (
            <button
              type="button"
              onClick={() => window.open(oauthUrl, "github-oauth", "width=720,height=780")}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-gray-900"
            >
              Connect GitHub
            </button>
          ) : (
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              GitHub OAuth is not configured on this deployment. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in the Convex environment to enable it.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3 grid gap-3">
          {github.errorMessage && <p className="text-xs text-red-600">{github.errorMessage}</p>}
          <label className="grid gap-1 text-sm">
            Repository
            {repos ? (
              <select
                value={repoFullName}
                onChange={(event) => {
                  setRepoFullName(event.target.value);
                  const repo = repos.find((r) => r.fullName === event.target.value);
                  if (repo && !baseBranch) setBaseBranch(repo.defaultBranch);
                }}
                className={INPUT}
              >
                <option value="">Choose a repository…</option>
                {repos.map((repo) => (
                  <option key={repo.fullName} value={repo.fullName}>
                    {repo.fullName}
                    {repo.private ? " (private)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex gap-2">
                <input
                  value={repoFullName}
                  onChange={(event) => setRepoFullName(event.target.value)}
                  placeholder="owner/repo"
                  className={INPUT}
                />
                <button
                  type="button"
                  onClick={() => void loadRepos()}
                  disabled={loadingRepos}
                  className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/15"
                >
                  {loadingRepos ? "Loading…" : "Browse"}
                </button>
              </div>
            )}
          </label>
          <label className="grid gap-1 text-sm">
            Base branch for PRs
            <input
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
              placeholder="main (project main branch when empty)"
              className={INPUT}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
            >
              {saving ? "Saving…" : "Save push target"}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await disconnect({ integrationId: github._id });
                  setRepos(null);
                } catch (err) {
                  toast("error", "Couldn't disconnect GitHub", errorText(err));
                }
              }}
              className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
