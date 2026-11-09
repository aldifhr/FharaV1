"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { GitBranch, Loader2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.");
const INPUT =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong";
const GHOST_BTN = "shrink-0 rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50";
const PRIMARY_BTN =
  "rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50";

type Repo = { fullName: string; owner: string; name: string; defaultBranch: string; private: boolean };

/**
 * A project's GitHub repository. The GitHub account is connected once for
 * every project in Integrations; a project only binds owner/name and the
 * PR base branch. The token never reaches the browser.
 */
export default function GithubRepoSettings({ projectId }: { projectId: string }) {
  const toast = useToast();
  const account = useQuery(api.integrations.githubAccount, {});
  const integrations = useQuery(api.integrations.listByProject, { projectId: projectId as never });
  const listRepos = useAction(api.integrations.listGithubRepos);
  const bindRepo = useMutation(api.integrations.bindRepo);
  const binding = (integrations ?? []).find((row) => row.type === "github" && row.status !== "disconnected");
  const bound = binding?.githubOwner && binding?.githubRepo ? `${binding.githubOwner}/${binding.githubRepo}` : "";

  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoFullName, setRepoFullName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRepoFullName(bound);
    setBaseBranch(binding?.githubBaseBranch ?? "");
  }, [binding?._id, bound, binding?.githubBaseBranch]);

  const loadRepos = async () => {
    setLoadingRepos(true);
    try {
      setRepos(await listRepos({ projectId: projectId as never }));
    } catch (err) {
      toast("error", "Couldn't load repositories", errorText(err));
    } finally {
      setLoadingRepos(false);
    }
  };

  const save = async () => {
    const [owner, name] = repoFullName.split("/");
    if (!owner?.trim() || !name?.trim()) {
      toast("error", "Choose a repository as owner/name");
      return;
    }
    setSaving(true);
    try {
      await bindRepo({
        projectId: projectId as never,
        githubOwner: owner.trim(),
        githubRepo: name.trim(),
        githubBaseBranch: baseBranch.trim(),
      });
      toast("success", "Repository saved");
    } catch (err) {
      toast("error", "Couldn't save the repository", errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const loading = account === undefined || integrations === undefined;
  const connected = Boolean(account?.connected);

  return (
    <section className="mt-5 border-t border-line pt-4">
      <div className="flex items-center gap-2">
        <GitBranch size={16} aria-hidden="true" className="text-ink-2" />
        <h3 className="text-[14px] font-medium text-ink">GitHub</h3>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Task branches are pushed and draft PRs opened only after you click Approve push on a push card.
      </p>

      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-3">
          <Loader2 size={13} className="animate-spin" /> Loading…
        </p>
      ) : (
        <div className="mt-3 grid gap-3">
          <div className="divide-y divide-line rounded-lg border border-line">
            <div className="flex items-center gap-3 px-3 py-2.5">
              <p className="min-w-0 flex-1 truncate text-[13.5px] text-ink">Repo: {bound || "none chosen"}</p>
              {!connected && (
                <Link href="/integrations" className={GHOST_BTN}>
                  Connect GitHub
                </Link>
              )}
            </div>
            <p className="truncate px-3 py-2.5 text-[12.5px] text-ink-3">
              {connected
                ? account?.login
                  ? `Account: @${account.login} (shared by every project)`
                  : "Account: connected (shared by every project)"
                : "No GitHub account connected. Connect it once in Integrations for every project."}
            </p>
          </div>

          {connected && (
            <>
              <label className="grid gap-1.5 text-[12.5px] text-ink-2">
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
                    <button type="button" onClick={() => void loadRepos()} disabled={loadingRepos} className={GHOST_BTN}>
                      {loadingRepos ? "Loading…" : "Browse"}
                    </button>
                  </div>
                )}
              </label>
              <label className="grid gap-1.5 text-[12.5px] text-ink-2">
                Base branch for PRs
                <input
                  value={baseBranch}
                  onChange={(event) => setBaseBranch(event.target.value)}
                  placeholder="main (project main branch when empty)"
                  className={INPUT}
                />
              </label>
              <div>
                <button type="button" disabled={saving} onClick={() => void save()} className={PRIMARY_BTN}>
                  {saving ? "Saving…" : "Save repository"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
