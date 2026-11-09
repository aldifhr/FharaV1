# Branch / Worktree + Diff Approval

## Tujuan

Saat ini agen menulis langsung ke workspace (branch `main`). Untuk workflow PR yang aman:

1. Setiap task berjalan di **branch terdedikasi**
2. Implementasi ditulis ke branch tersebut
3. Sebelum di-merge, user melihat **diff** dan memberi approval
4. Jika approved → merge ke main; jika rejected → branch di-delete

## Arsitektur

### Branch Naming

```
fhara/<task-id>/<slug>
# contoh: fhara/jx70s9cevkn6/summon-api-route
```

Slug derived dari task title (sanitized, max 40 chars).

### Worktree vs Branch Langsung

Dua opsi:

**Opsi A — Git worktree per task**
- `git worktree add <path> <branch>` → workspace terpisah
- write ke worktree
- diff dari worktree vs main
- merge: `git checkout main && git merge <branch> && git worktree remove <path>`
- reject: `git worktree remove <path> && git branch -D <branch>`

**Pro**: isolate completely, no stale files, `git worktree` handles conflicts
**Con**: worktree management overhead; some git commands behave differently in worktrees

**Opsi B — Branch langsung di same repo**
- `git checkout -b <branch>` di workspace
- write langsung
- `git diff main..<branch>` untuk diff
- merge: `git checkout main && git merge --no-ff <branch>`
- reject: `git checkout main && git branch -D <branch>`

**Pro**: Simpler, no worktree management
**Con**: Risk of uncommitted changes affecting main; need clean workspace before branch

**Rekomendasi**: Opsi A (worktree) — isolate adalah kunci untuk flow multi-task concurrent.

### Exposed API (Convex)

#### `worker:createBranch`
```ts
mutation createBranch(taskId: Id, workspacePath: string, branchName: string): Promise<{
  branch: string;       // misal "fhara/jx70s9cevkn6/summon-api-route"
  worktreePath: string; // "/path/to/workspaces/<projectId>/<branch-name>"
}>
```
- Creates git branch from `main` at `workspacePath`
- Adds worktree at `worktreePath/<projectRelative>`
- Returns branch name + absolute worktree path

#### `worker:getDiff`
```ts
query getDiff(taskId: Id): Promise<{
  diff: string;         // unified diff output
  fileCount: number;
  files: Array<{ path: string; status: "added"|"modified"|"deleted" }>;
}>
```
- Runs `git diff main..<branch>` di worktree
- Returns compact diff + file list

#### `worker:mergeBranch`
```ts
mutation mergeBranch(taskId: Id): Promise<{ success: boolean; mergeCommit?: string }>
```
- `git checkout main && git merge --no-ff <branch>`
- Deletes worktree + branch after merge

#### `worker:discardBranch`
```ts
mutation discardBranch(taskId: Id): Promise<void>
```
- `git worktree remove <path> && git branch -D <branch>`
- FileChanges remain only in branch (discarded)

### Task Flow dengan Branch

```
task.claim → createBranch → worktreePath
  → runNodes (implementasi di worktree)
  → runReviewLoop
  → runVerification (di worktree)
  → diff = getDiff()
  → requestApproval(kind: "merge_pr", summary: diff summary, payload: { fileCount, diff })
  → user approves → mergeBranch → completeTask "done"
               rejects → discardBranch → completeTask "rejected"
```

### Schema Update

Tambahkan ke `projects` table:
```ts
mainBranch?: string;   // default "main"
worktreesPath?: string; // base untuk worktrees, default "<workspaceRoot>/.moagent-worktrees"
```

Tambahkan ke `tasks` table:
```ts
branchName?: string;
worktreePath?: string;
```

### Idempotency

- Jika task sudah punya `branchName` (resume): skip createBranch, reuse existing worktree
- `getResumable` harus mengembalikan task dengan branch yang sudah ada
- Approval expired → cleanup branch saat worker recover stale tasks

### Concurrency

- `maxConcurrency` di worker policy membatasi task konkuren per worker
- Branch name collision: `<task-id>/<slug>` unik per task, collision tidak mungkin
- Worktree path: `<worktreesPath>/<projectId>/<branchName>` — unjur per project

### Edge Cases

1. **Merge conflict**: `git merge` gagal → task status "failed" dengan error; user harus resolve manual (out of scope untuk P0)
2. **Branch exists from previous run**: `git worktree list` check; jika ada, reuse
3. **Workspace dirty** (uncommitted changes): tidak bisa checkout branch baru → gagal dengan instruksi `git stash`
4. **Approval timeout**: policy `approvalTimeoutMs` → auto-discard branch

## Todo

- [ ] Schema: projects.mainBranch, projects.worktreesPath; tasks.branchName, tasks.worktreePath
- [ ] `worker:createBranch` — git worktree + branch creation
- [ ] `worker:getDiff` — diff query
- [ ] `worker:mergeBranch` — merge + cleanup
- [ ] `worker:discardBranch` — discard + cleanup
- [ ] Worker: `processTask` call createBranch, pass worktreePath ke taskRunner
- [ ] Worker: executePlan run di worktree (sudah ada workspacePath — tinggal gunakan worktree)
- [ ] Approval kind "merge_pr" — requestApproval dengan diff payload
- [ ] resumeTask: reuse existing branch
- [ ] Stale branch cleanup: `worker:recover` atau cron
