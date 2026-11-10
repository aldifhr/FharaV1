# T1 live push smoke

- Run: 2026-11-10T18:39:17.100Z → 2026-11-10T18:39:23.994Z (UTC)
- Command: `node scripts/push-smoke.mjs --repo aldifhr/experiment --proxy-auth --out audit/t1-push-smoke.json`
- Auth: the sandbox's GitHub credentials proxy (HTTPS_PROXY) supplied the account token; the script sent a placeholder.
- Repo: aldifhr/experiment (base `main`), branch `fhara-e2e-smoke-20261110-183917-jdp8`, commit `6f21496dfb74fb4c22734aa26365659a952ef78a`
- PR: https://github.com/aldifhr/experiment/pull/2 (opened as draft, then closed)
- Checks on the head commit: none (the repo has no CI)
- Result: **PASS**

| Step | OK | Detail |
|---|---|---|
| guard refuses base-branch push | yes | `{"reason": "Push blocked: \"main\" is the base branch; task pushes go to their own branch (set FHARA_ALLOW_BASE_BRANCH_PUSH=true to allow)"}` |
| guard refuses force push | yes | `{"reason": "Push blocked: force push is not allowed (set FHARA_ALLOW_FORCE_PUSH=true to allow)"}` |
| local commit on base | yes | `{"base": "main", "sha": "6f21496dfb74"}` |
| push via pushCommitToGithub | yes | `{"ms": 1805, "remoteSha": "6f21496dfb74"}` |
| open draft PR | yes | `{"number": 2, "url": "https://github.com/aldifhr/experiment/pull/2", "state": "draft"}` |
| read PR | yes | `{"state": "open", "draft": true, "headSha": "6f21496dfb74"}` |
| read PR check status | yes | `{"state": "none", "total": 0, "failed": 0, "pending": 0, "url": "https://github.com/aldifhr/experiment/commit/6f21496dfb74fb4c22734aa26365659a952ef78a/checks", "names": []}` |
| cleanup: close PR | yes | `{"number": 2, "state": "closed"}` |
| cleanup: delete branch | yes | `{"deleteStatus": 204, "verifyStatus": 404}` |

Cleanup verified after the run: `git ls-remote` shows no `fhara-e2e-smoke-*` ref on the repo, and PR #2 reads `closed`. GitHub does not allow deleting a PR, so the closed draft stays in the repo's PR list.
