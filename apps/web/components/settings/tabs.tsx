"use client";

/**
 * Settings modal tabs. Every control here is saved and read by the code:
 *  - server behaviour → Convex `appSettings` (knobs the worker / Convex
 *    read instead of the env, new-project defaults, child env);
 *  - this-device behaviour → localStorage prefs (lib/uiPrefs.ts,
 *    lib/keybindings.ts) read by the components they change.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { ChevronRight, Plus, RotateCcw, Trash2 } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import ConfirmDialog, { type ConfirmRequest } from "@/components/ConfirmDialog";
import GithubAccountRow from "@/components/GithubAccount";
import { useToast } from "@/components/Toasts";
import {
  chordConflicts,
  chordFromEvent,
  defaultKeybindings,
  formatChord,
  KEYBINDING_ACTIONS,
  useKeybindings,
  writeKeybindings,
  type KeybindingId,
} from "@/lib/keybindings";
import { suggestProjectPath, useUiPref } from "@/lib/uiPrefs";
import {
  BUTTON,
  CommitField,
  errorText,
  INPUT,
  KnobNumber,
  KnobSelect,
  KnobText,
  KnobToggle,
  LINK_BUTTON,
  Muted,
  relativeTime,
  Row,
  Section,
  Select,
  Toggle,
  useAppSettings,
} from "./controls";

/** Shared confirm state for destructive actions in a tab. */
function useConfirm() {
  const [request, setRequest] = useState<(ConfirmRequest & { run: () => Promise<void> }) | null>(null);
  const [pending, setPending] = useState(false);
  const dialog = (
    <ConfirmDialog
      request={request}
      pending={pending}
      onCancel={() => setRequest(null)}
      onConfirm={async () => {
        if (!request) return;
        setPending(true);
        try {
          await request.run();
          setRequest(null);
        } finally {
          setPending(false);
        }
      }}
    />
  );
  return { ask: setRequest, dialog };
}

const workerEnvNote = (name: string, fallback: string) => (
  <>
    Unset uses <code className="font-mono">{name}</code> from the worker env ({fallback}). Applies to the next task, no restart.
  </>
);

// ── Diffs & pull requests ───────────────────────────────────────────────

export function DiffsTab() {
  const [diffView, setDiffView] = useUiPref("diffView");
  const [diffContext, setDiffContext] = useUiPref("diffContext");
  const [diffExpanded, setDiffExpanded] = useUiPref("diffExpanded");
  return (
    <>
      <Section title="Diffs" description="How file changes render on this device.">
        <Row label="Layout" description="Side by side or unified, for full-file diffs in the task thread.">
          <Select
            label="Diff layout"
            value={diffView}
            onChange={setDiffView}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Side by side" },
            ]}
          />
        </Row>
        <Row label="Context" description="Show the whole file, or only the changed lines with a little context.">
          <Select
            label="Diff context"
            value={diffContext}
            onChange={setDiffContext}
            options={[
              { value: "full", label: "Whole file" },
              { value: "changes", label: "Changes only" },
            ]}
          />
        </Row>
        <Row label="Expand diffs" description="File sections start open. Off: they start collapsed.">
          <Toggle label="Expand diffs" checked={diffExpanded} onChange={setDiffExpanded} />
        </Row>
      </Section>
      <Section title="Pull requests" description="What happens when you approve Push & open PR.">
        <KnobToggle
          knob="FHARA_PR_DRAFT"
          label="Open pull requests as drafts"
          description="Off: pull requests open ready for review. Repositories without draft support always open ready."
        />
        <NewProjectToggle
          field="prFeedbackReactions"
          label="Fix pull request feedback"
          description="Default for new projects: a failed check, requested changes or a merge conflict on a task's PR queues a fix task on the same branch. Change it per project in the project settings."
        />
        <KnobNumber
          knob="FHARA_PR_FIX_MAX_ATTEMPTS"
          label="Fix attempts per pull request"
          description="Automatic fix tasks per PR before Fhara stops and leaves it to you (0–20)."
        />
      </Section>
      <Section
        title="Auto-merge"
        description="Fhara merges a task's PR only when every check passed, the diff passes the limits below, and the PR head is the commit you approved. Anything else waits with a reason. Off unless a project turns it on."
      >
        <NewProjectToggle
          field="autoMerge"
          label="Merge pull requests automatically"
          description="Default for new projects. Change it per project in the project settings."
        />
        <KnobNumber
          knob="FHARA_AUTO_MERGE_MAX_LINES"
          label="Largest diff to merge"
          unit="lines"
          description="Added plus deleted lines. A bigger PR waits for you (0 = no size limit)."
        />
        <KnobText
          knob="FHARA_AUTO_MERGE_SENSITIVE"
          label="Paths that always need you"
          description="Comma-separated globs (** any depth, * one segment). A PR touching one waits for you."
          width="w-72"
        />
        <KnobSelect
          knob="FHARA_AUTO_MERGE_METHOD"
          label="Merge method"
          options={[
            { value: "squash", label: "Squash" },
            { value: "merge", label: "Merge commit" },
            { value: "rebase", label: "Rebase" },
          ]}
        />
      </Section>
    </>
  );
}

// ── Keybindings ─────────────────────────────────────────────────────────

export function KeybindingsTab() {
  const bindings = useKeybindings();
  const [recording, setRecording] = useState<KeybindingId | null>(null);
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
    setIsMac(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);

  // Capture the next chord while recording. Escape cancels (and is
  // swallowed so it does not close Settings).
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return;
      writeKeybindings({ ...bindings, [recording]: chord });
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, bindings]);

  const defaults = defaultKeybindings();
  const changed = KEYBINDING_ACTIONS.some((a) => bindings[a.id] !== defaults[a.id]);
  const scopes = Array.from(new Set(KEYBINDING_ACTIONS.map((a) => a.scope)));

  return (
    <>
      {scopes.map((scope) => (
        <Section
          key={scope}
          title={scope === "Global" ? "Global" : "Message composer"}
          description={scope === "Global" ? "Work anywhere in the app." : "Work while typing a message."}
        >
          {KEYBINDING_ACTIONS.filter((a) => a.scope === scope).map((action) => {
            const conflicts = chordConflicts(bindings, action.id, bindings[action.id]);
            const isDefault = bindings[action.id] === action.defaultChord;
            return (
              <Row
                key={action.id}
                label={action.label}
                description={
                  conflicts.length > 0
                    ? `Same keys as ${conflicts.map((id) => KEYBINDING_ACTIONS.find((a) => a.id === id)?.label).join(", ")}`
                    : undefined
                }
              >
                {!isDefault && (
                  <button
                    type="button"
                    className={LINK_BUTTON}
                    onClick={() => writeKeybindings({ ...bindings, [action.id]: action.defaultChord })}
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setRecording(recording === action.id ? null : action.id)}
                  aria-label={`Change shortcut for ${action.label}`}
                  className={`${BUTTON} min-w-[7rem] justify-center font-mono`}
                >
                  {recording === action.id ? "Press keys…" : formatChord(bindings[action.id], isMac)}
                </button>
              </Row>
            );
          })}
        </Section>
      ))}
      <div className="flex items-center justify-between">
        <Muted>Click a shortcut, then press the new keys. Escape cancels. Saved on this device.</Muted>
        {changed && (
          <button type="button" className={BUTTON} onClick={() => writeKeybindings(defaultKeybindings())}>
            <RotateCcw size={12} />
            Reset all
          </button>
        )}
      </div>
    </>
  );
}

// ── Voice ───────────────────────────────────────────────────────────────

const VOICE_LANGUAGES = [
  { value: "", label: "Browser language" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "id-ID", label: "Indonesian" },
  { value: "ms-MY", label: "Malay" },
  { value: "ja-JP", label: "Japanese" },
  { value: "zh-CN", label: "Chinese (Mandarin)" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
] as const;

export function VoiceTab() {
  const [enabled, setEnabled] = useUiPref("voiceEnabled");
  const [language, setLanguage] = useUiPref("voiceLanguage");
  const [continuous, setContinuous] = useUiPref("voiceContinuous");
  const [autoSend, setAutoSend] = useUiPref("voiceAutoSend");
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    setSupported(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);
  return (
    <Section
      title="Voice input"
      description={
        supported === false
          ? "This browser has no speech recognition, so the mic button stays hidden. Chrome, Edge and Safari support it."
          : "Dictate messages with the mic button in the composer. Saved on this device."
      }
    >
      <Row label="Mic button" description="Show the voice input button in the message composer.">
        <Toggle label="Mic button" checked={enabled} onChange={setEnabled} />
      </Row>
      <Row label="Language" description="The language speech is recognized in.">
        <Select label="Voice language" value={language as (typeof VOICE_LANGUAGES)[number]["value"]} onChange={setLanguage} options={VOICE_LANGUAGES} />
      </Row>
      <Row label="Keep listening" description="Dictate until you press the mic again, instead of stopping after one phrase.">
        <Toggle label="Keep listening" checked={continuous} onChange={setContinuous} />
      </Row>
      <Row label="Send when dictation ends" description="Send the message as soon as listening stops.">
        <Toggle label="Send when dictation ends" checked={autoSend} onChange={setAutoSend} />
      </Row>
    </Section>
  );
}

// ── SnapShots ───────────────────────────────────────────────────────────

export function SnapshotsTab() {
  const runNow = useMutation(api.cronJobs.runNow);
  const toast = useToast();
  return (
    <>
      <Section
        title="Context snapshots"
        description="A redacted record of what each LLM call saw, for Inspect context, Replay and Compare on runs."
      >
        <KnobToggle
          knob="CONTEXT_SNAPSHOTS"
          label="Record snapshots"
          description="Off: no new snapshots are stored, for tasks or chat. Existing ones stay until retention removes them."
        />
        <KnobNumber
          knob="FHARA_SNAPSHOT_RETENTION_DAYS"
          label="Keep snapshots for"
          unit="days"
          description="For projects without their own retention (1–365, default 14). Pruned daily."
        />
        <Row label="Prune now" description="Delete snapshots past retention without waiting for the daily run.">
          <button
            type="button"
            className={BUTTON}
            onClick={async () => {
              try {
                await runNow({ name: "prune context snapshots" });
                toast("success", "Pruning started");
              } catch (err) {
                toast("error", "Couldn't start pruning", errorText(err));
              }
            }}
          >
            Prune now
          </button>
        </Row>
      </Section>
    </>
  );
}

// ── Providers ───────────────────────────────────────────────────────────

export function ProvidersTab({ onOpenModels }: { onOpenModels: () => void }) {
  const opencode = useQuery(api.opencodeModels.list, {});
  const refresh = useMutation(api.opencodeModels.requestRefresh);
  const toast = useToast();
  let status: string;
  if (opencode === undefined) status = "Checking…";
  else if (opencode.updatedAt === 0) status = "Not checked yet. A worker reports on start.";
  else if (opencode.installed === false) status = "Not installed on the worker machine.";
  else if (!opencode.available) status = opencode.error ? `Installed, but listing models failed: ${opencode.error}` : "Installed, no models listed.";
  else status = `Installed${opencode.version ? ` (${opencode.version})` : ""}, ${opencode.models.length} model${opencode.models.length === 1 ? "" : "s"}.`;
  return (
    <>
      <Section title="LLM providers" description="Connections, models and their order live in LLM & Models.">
        <button type="button" onClick={onOpenModels} className="flex w-full items-center justify-between gap-6 px-4 py-3.5 text-left transition-colors hover:bg-hover">
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">Open LLM & Models</span>
            <span className="mt-0.5 block text-[11.5px] text-ink-3">Add a provider, pick models, set the fallback order.</span>
          </span>
          <ChevronRight size={14} className="shrink-0 text-ink-3" />
        </button>
      </Section>
      <Section title="OpenCode" description="The OpenCode CLI as reported by the worker.">
        <Row label="Status" description={status}>
          <button
            type="button"
            className={BUTTON}
            disabled={opencode === undefined || opencode.pendingRefresh}
            onClick={async () => {
              try {
                const { requested } = await refresh({});
                toast(requested ? "success" : "info", requested ? "Detection requested" : "No worker has reported yet", requested ? "The worker re-checks on its next poll." : "Start the worker first.");
              } catch (err) {
                toast("error", "Couldn't request detection", errorText(err));
              }
            }}
          >
            {opencode?.pendingRefresh ? "Checking…" : "Check again"}
          </button>
        </Row>
        {opencode && opencode.updatedAt > 0 && (
          <Row
            label="Last report"
            description={`${opencode.hostname ?? opencode.workerId ?? "worker"}${opencode.path ? ` · ${opencode.path}` : ""}`}
          >
            <Muted>{relativeTime(opencode.updatedAt)}</Muted>
          </Row>
        )}
      </Section>
    </>
  );
}

// ── Threads ─────────────────────────────────────────────────────────────

export function ThreadsTab() {
  const [enterToSend, setEnterToSend] = useUiPref("enterToSend");
  const [liveOutput, setLiveOutput] = useUiPref("liveOutput");
  return (
    <>
      <Section title="Composer and thread view" description="Saved on this device.">
        <Row label="Enter sends" description="Off: Enter adds a new line and Ctrl/Cmd+Enter sends.">
          <Toggle label="Enter sends" checked={enterToSend} onChange={setEnterToSend} />
        </Row>
        <Row label="Live model output" description="Show streamed output under running subtasks in the task thread.">
          <Toggle label="Live model output" checked={liveOutput} onChange={setLiveOutput} />
        </Row>
      </Section>
      <Section title="Timeouts" description="When a thread that stopped making progress is ended.">
        <KnobNumber
          knob="CHAT_REPLY_STALE_MS"
          label="Chat reply timeout"
          unit="min"
          factor={60_000}
          description="A chat reply still running after this is marked interrupted with a Retry button (11–1440, default 15)."
        />
        <KnobNumber
          knob="ORCHESTRATOR_IDLE_TIMEOUT_MS"
          label="Task idle timeout"
          unit="min"
          factor={60_000}
          description={workerEnvNote("ORCHESTRATOR_IDLE_TIMEOUT_MS", "default 10 min")}
        />
        <KnobNumber
          knob="ORCHESTRATOR_TASK_TIMEOUT_MS"
          label="Task deadline"
          unit="min"
          factor={60_000}
          description={workerEnvNote("ORCHESTRATOR_TASK_TIMEOUT_MS", "default 20 min; high-complexity tasks get at least 40")}
        />
      </Section>
    </>
  );
}

// ── Browser ─────────────────────────────────────────────────────────────

export function BrowserTab() {
  return (
    <Section title="Browser QA" description="The headless browser the QA agent uses to check UI changes.">
      <KnobSelect
        knob="ORCHESTRATOR_QA_MODE"
        label="When to run browser QA"
        description="Auto: only for UI changes in a project that can run in a browser."
        options={[
          { value: "auto", label: "Auto" },
          { value: "always", label: "Every code change" },
          { value: "never", label: "Never" },
        ]}
      />
      <KnobToggle
        knob="ORCHESTRATOR_QA_REQUIRED"
        label="Require QA"
        description="When the browser can not run (no Chromium, no dev script), fail the task instead of skipping QA."
      />
      <KnobText
        knob="QA_CHROMIUM_PATH"
        label="Chromium path"
        placeholder="Playwright's bundled Chromium"
        description="A Chrome or Chromium binary to use instead of Playwright's."
      />
      <KnobToggle
        knob="QA_CHROMIUM_NO_SANDBOX"
        label="Disable the Chromium sandbox"
        description="Needed in some containers. Root and container runs turn it off on their own."
      />
      <KnobNumber
        knob="QA_STARTUP_TIMEOUT_MS"
        label="Dev server start timeout"
        unit="s"
        factor={1000}
        description="How long QA waits for the project's dev server (default 90 s)."
      />
    </Section>
  );
}

// ── Devices ─────────────────────────────────────────────────────────────

export function DevicesTab() {
  const workers = useQuery(api.appSettings.workers, {});
  const forget = useMutation(api.appSettings.forgetOfflineWorkers);
  const [notify, setNotify] = useUiPref("notifyAttention");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const toast = useToast();
  const confirm = useConfirm();
  useEffect(() => {
    setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);
  const offline = (workers ?? []).filter((w) => w.status === "offline").length;

  const toggleNotify = async (next: boolean) => {
    if (!next) return setNotify(false);
    if (permission === "unsupported") return;
    const result = permission === "granted" ? "granted" : await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") setNotify(true);
    else toast("info", "Notifications are blocked", "Allow them for this site in the browser settings.");
  };

  return (
    <>
      <Section title="This device">
        <Row
          label="Desktop notifications"
          description={
            permission === "unsupported"
              ? "This browser does not support notifications."
              : permission === "denied"
                ? "Blocked in the browser. Allow notifications for this site to turn this on."
                : "Notify when something new needs you (an approval, a question) while Fhara is in the background."
          }
        >
          <Toggle
            label="Desktop notifications"
            checked={notify && permission === "granted"}
            disabled={permission === "unsupported" || permission === "denied"}
            onChange={(next) => void toggleNotify(next)}
          />
        </Row>
      </Section>
      <Section title="Workers" description="Machines running the Fhara worker, newest heartbeat first.">
        {workers === undefined && <Row label="Loading…" />}
        {workers?.length === 0 && <Row label="No worker has connected yet" description="Start one with npm run dev or npm run worker." />}
        {(workers ?? []).map((w) => (
          <Row
            key={w._id}
            label={w.hostname ?? w.workerId}
            description={`${w.status === "online" ? "Online" : "Offline"} · ${w.activeTasks}/${w.capacity} tasks · heartbeat ${relativeTime(w.lastHeartbeatAt)}${w.capabilities.length ? ` · ${w.capabilities.join(", ")}` : ""}`}
          />
        ))}
        {offline > 0 && (
          <Row label="Forget offline workers" description={`Remove ${offline} offline ${offline === 1 ? "entry" : "entries"} from this list. A worker that starts again reappears.`}>
            <button
              type="button"
              className={BUTTON}
              onClick={() =>
                confirm.ask({
                  title: "Forget offline workers?",
                  message: `${offline} offline ${offline === 1 ? "worker is" : "workers are"} removed from the list. Running workers are not affected.`,
                  confirmLabel: "Forget",
                  run: async () => {
                    try {
                      await forget({});
                    } catch (err) {
                      toast("error", "Couldn't forget workers", errorText(err));
                    }
                  },
                })
              }
            >
              Forget
            </button>
          </Row>
        )}
      </Section>
      {confirm.dialog}
    </>
  );
}

// ── Scheduled tasks ─────────────────────────────────────────────────────

export function ScheduledTab() {
  const jobs = useQuery(api.cronJobs.list, {});
  const runNow = useMutation(api.cronJobs.runNow);
  const toast = useToast();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Section title="Scheduled tasks" description="Background jobs the backend runs on a timer. Times are recorded from their first run after this update.">
      {jobs === undefined && <Row label="Loading…" />}
      {(jobs ?? []).map((job) => {
        const last =
          job.lastStatus === null
            ? "Not run yet"
            : job.lastStatus === "running"
              ? `Running since ${relativeTime(job.lastStartedAt)}`
              : `${job.lastStatus === "ok" ? "Last run" : "Failed"} ${relativeTime(job.lastFinishedAt ?? job.lastStartedAt)}${job.trigger === "manual" ? " (manual)" : ""}`;
        return (
          <Row
            key={job.name}
            stacked
            label={job.name.charAt(0).toUpperCase() + job.name.slice(1)}
            description={
              <>
                {job.schedule} · {job.description}
                <span className="block">
                  {last}
                  {job.lastStatus === "failed" && job.lastError ? `: ${job.lastError}` : ""}
                  {job.lastStatus === "ok" && job.lastResult && job.lastResult !== "null" ? ` · ${job.lastResult}` : ""}
                </span>
              </>
            }
          >
            <button
              type="button"
              className={BUTTON}
              disabled={job.lastStatus === "running"}
              onClick={async () => {
                try {
                  await runNow({ name: job.name });
                  toast("success", "Started", job.name);
                } catch (err) {
                  toast("error", "Couldn't start the job", errorText(err));
                }
              }}
            >
              Run now
            </button>
          </Row>
        );
      })}
    </Section>
  );
}

// ── Projects ────────────────────────────────────────────────────────────

type NewProjectField = "prFeedbackReactions" | "shadowAgentDefault" | "autoMerge" | "issueIntake";

function NewProjectToggle({ field, label, description }: { field: NewProjectField; label: string; description?: string }) {
  const settings = useAppSettings();
  const save = useMutation(api.appSettings.setNewProjectDefaults);
  const toast = useToast();
  return (
    <Row label={label} description={description}>
      <Toggle
        label={label}
        checked={Boolean(settings?.newProject[field])}
        disabled={settings === undefined}
        onChange={async (next) => {
          try {
            await save({ [field]: next });
          } catch (err) {
            toast("error", "Couldn't save the setting", errorText(err));
          }
        }}
      />
    </Row>
  );
}

export function ProjectsTab() {
  const settings = useAppSettings();
  const save = useMutation(api.appSettings.setNewProjectDefaults);
  const projects = useQuery(api.projects.list, {});
  const removeProject = useMutation(api.projects.remove);
  const toast = useToast();
  const confirm = useConfirm();
  const saveField = async (patch: Parameters<typeof save>[0]) => {
    try {
      await save(patch);
    } catch (err) {
      toast("error", "Couldn't save the setting", errorText(err));
    }
  };
  const np = settings?.newProject;
  return (
    <>
      <Section title="New project defaults" description="Applied when a project is created. Each project can change them later.">
        <Row label="Permission mode" description="What new tasks may do without asking.">
          <Select
            label="Default permission mode"
            value={np?.defaultPermissionMode ?? "supervised"}
            disabled={!np}
            onChange={(value) => void saveField({ defaultPermissionMode: value === "supervised" ? null : value })}
            options={[
              { value: "supervised", label: "Supervised" },
              { value: "auto_edits", label: "Auto-accept edits" },
              { value: "full_access", label: "Full access" },
            ]}
          />
        </Row>
        <Row label="Plan review" description="Pause after the plan is made so you can review it.">
          <Select
            label="Plan review"
            value={np?.planReview ?? "off"}
            disabled={!np}
            onChange={(value) => void saveField({ planReview: value === "off" ? null : value })}
            options={[
              { value: "off", label: "Off" },
              { value: "medium_plus", label: "Medium and larger tasks" },
              { value: "always", label: "Every task" },
            ]}
          />
        </Row>
        <NewProjectToggle field="shadowAgentDefault" label="Shadow reviewer" description="New tasks start with the Reviewer observing." />
        <NewProjectToggle field="prFeedbackReactions" label="Fix pull request feedback" description="Queue a fix task when a task's PR gets failed checks or requested changes." />
        <NewProjectToggle field="autoMerge" label="Merge pull requests automatically" description="Merge a task's PR once every check passed and the diff is within the auto-merge limits." />
      </Section>
      <Section title="Projects" description="Deleting a project removes its tasks, chat and history. Files on disk are not touched.">
        {projects === undefined && <Row label="Loading…" />}
        {projects?.length === 0 && <Row label="No projects yet" />}
        {(projects ?? []).map((p) => (
          <Row key={p._id} label={p.name} description={<span className="font-mono">{p.workspacePath}</span>}>
            <Link href={`/chats/${p._id}`} className={BUTTON}>
              Open
            </Link>
            <button
              type="button"
              aria-label={`Delete ${p.name}`}
              className={BUTTON}
              onClick={() =>
                confirm.ask({
                  title: `Delete ${p.name}?`,
                  message: "Its tasks, chat, approvals and history are deleted. The folder on disk is kept.",
                  confirmLabel: "Delete project",
                  run: async () => {
                    try {
                      await removeProject({ projectId: p._id });
                      toast("success", "Project deleted", p.name);
                    } catch (err) {
                      toast("error", "Couldn't delete the project", errorText(err));
                    }
                  },
                })
              }
            >
              <Trash2 size={13} />
            </button>
          </Row>
        ))}
      </Section>
      {confirm.dialog}
    </>
  );
}

// ── Source control ──────────────────────────────────────────────────────

export function SourceControlTab() {
  const settings = useAppSettings();
  const save = useMutation(api.appSettings.setNewProjectDefaults);
  const toast = useToast();
  return (
    <>
      <Section title="Commit identity" description="The author on commits and merges Fhara makes. Empty uses FHARA_GIT_AUTHOR_* from the env, else Fhara.">
        <KnobText knob="FHARA_GIT_AUTHOR_NAME" label="Author name" placeholder="Fhara" />
        <KnobText knob="FHARA_GIT_AUTHOR_EMAIL" label="Author email" placeholder="fhara@users.noreply.github.com" />
      </Section>
      <Section title="Branches and pushes">
        <Row label="Base branch for new projects" description="Task branches start from it and merge back into it. Empty: detect from the repository." htmlFor="settings-base-branch">
          <CommitField
            id="settings-base-branch"
            label="Base branch for new projects"
            value={settings?.defaultBaseBranch ?? ""}
            placeholder="Auto-detect"
            width="w-40"
            disabled={settings === undefined}
            onCommit={async (next) => {
              try {
                await save({ defaultBaseBranch: next });
              } catch (err) {
                toast("error", "Couldn't save the base branch", errorText(err));
              }
            }}
          />
        </Row>
        <KnobToggle
          knob="FHARA_ALLOW_BASE_BRANCH_PUSH"
          label="Allow pushing to the base branch"
          description={workerEnvNote("FHARA_ALLOW_BASE_BRANCH_PUSH", "off: pushes go to the task branch; main, master and the base branch are refused")}
        />
        <KnobToggle
          knob="FHARA_ALLOW_FORCE_PUSH"
          label="Allow force push"
          description={workerEnvNote("FHARA_ALLOW_FORCE_PUSH", "off")}
        />
      </Section>
    </>
  );
}

// ── Worktrees ───────────────────────────────────────────────────────────

export function WorktreesTab() {
  const runNow = useMutation(api.cronJobs.runNow);
  const jobs = useQuery(api.cronJobs.list, {});
  const sweep = jobs?.find((j) => j.name === "sweep stale task worktrees");
  const toast = useToast();
  const confirm = useConfirm();
  return (
    <>
      <Section title="Worktrees" description="Each task can run in its own git worktree so your checkout is never touched.">
        <KnobToggle
          knob="ORCHESTRATOR_WORKTREE_ISOLATION"
          label="Isolate tasks in worktrees"
          description={workerEnvNote("ORCHESTRATOR_WORKTREE_ISOLATION", "off; needs a git repository")}
        />
        <KnobNumber
          knob="FHARA_WORKTREE_RETENTION_HOURS"
          label="Keep finished worktrees for"
          unit="hours"
          description="Then the worktree is removed unless its PR is still open. The branch is kept (1–720, default 72)."
        />
        <Row
          label="Clean up now"
          description={`Remove worktrees past retention now. ${sweep?.lastFinishedAt ? `Last cleanup ${relativeTime(sweep.lastFinishedAt)}${sweep.lastResult ? ` · ${sweep.lastResult}` : ""}.` : "Runs every 6 hours."}`}
        >
          <button
            type="button"
            className={BUTTON}
            disabled={sweep?.lastStatus === "running"}
            onClick={() =>
              confirm.ask({
                title: "Clean up worktrees?",
                message: "Worktrees of tasks finished longer ago than the retention window are removed. Branches and open PRs are kept.",
                confirmLabel: "Clean up",
                run: async () => {
                  try {
                    await runNow({ name: "sweep stale task worktrees" });
                    toast("success", "Cleanup started");
                  } catch (err) {
                    toast("error", "Couldn't start cleanup", errorText(err));
                  }
                },
              })
            }
          >
            {sweep?.lastStatus === "running" ? "Cleaning…" : "Clean up"}
          </button>
        </Row>
      </Section>
      {confirm.dialog}
    </>
  );
}

// ── Environments ────────────────────────────────────────────────────────

type EnvRow = { name: string; value: string };

export function EnvironmentsTab() {
  const settings = useAppSettings();
  const save = useMutation(api.appSettings.setChildEnv);
  const toast = useToast();
  const [rows, setRows] = useState<EnvRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const stored = useMemo(() => settings?.childEnv ?? [], [settings]);
  useEffect(() => {
    if (settings) setRows(stored.map((e) => ({ ...e })));
  }, [settings, stored]);
  const dirty = rows !== null && JSON.stringify(rows.filter((r) => r.name.trim())) !== JSON.stringify(stored);

  return (
    <Section
      title="Environment variables"
      description="Passed to every process the worker starts for a task: commands, tests, builds, QA dev servers, OpenCode. Worker secrets can not be set here. Stored in your local Convex database."
    >
      {rows === null && <Row label="Loading…" />}
      {rows !== null && (
        <div className="space-y-2 px-4 py-3.5">
          {rows.length === 0 && <Muted>No variables. Processes get the scrubbed worker env only.</Muted>}
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                aria-label={`Variable ${index + 1} name`}
                value={row.name}
                placeholder="NAME"
                onChange={(e) => setRows(rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))}
                className={`${INPUT} w-48 font-mono`}
              />
              <input
                aria-label={`Variable ${index + 1} value`}
                value={row.value}
                placeholder="value"
                onChange={(e) => setRows(rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))}
                className={`${INPUT} min-w-0 flex-1 font-mono`}
              />
              <button
                type="button"
                aria-label={`Remove ${row.name || "variable"}`}
                className="rounded-md p-1.5 text-ink-3 hover:bg-hover hover:text-ink"
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1">
            <button type="button" className={BUTTON} onClick={() => setRows([...rows, { name: "", value: "" }])}>
              <Plus size={12} />
              Add variable
            </button>
            <span className="flex items-center gap-2">
              {dirty && (
                <button type="button" className={LINK_BUTTON} onClick={() => setRows(stored.map((e) => ({ ...e })))}>
                  Discard
                </button>
              )}
              <button
                type="button"
                className={BUTTON}
                disabled={!dirty || saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await save({ entries: rows.filter((r) => r.name.trim()) });
                    toast("success", "Environment saved", "Applies to the next process the worker starts.");
                  } catch (err) {
                    toast("error", "Couldn't save the environment", errorText(err));
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Sharing & access ────────────────────────────────────────────────────

export function SharingTab() {
  return (
    <>
      <Section title="Access" description="Fhara runs on this machine for you alone: no accounts, no sharing. These control what agents may do.">
        <KnobToggle
          knob="ORCHESTRATOR_AGENT_REACH_ENABLED"
          label="Web reading"
          description="Agents that declare the web tool may read public web pages during research and audits."
        />
        <KnobToggle
          knob="ORCHESTRATOR_MCP_WRITE_TOOLS"
          label="MCP write tools"
          description="Let agents use MCP tools that write, move or delete files. Off: file writes go only through the approval-gated diff."
        />
        <KnobNumber
          knob="ORCHESTRATOR_APPROVAL_TIMEOUT_MS"
          label="Approval wait"
          unit="min"
          factor={60_000}
          description={workerEnvNote("ORCHESTRATOR_APPROVAL_TIMEOUT_MS", "default 30 min; then the task stops waiting")}
        />
      </Section>
      <Section title="Accounts">
        <Row label="GitHub and MCP servers" description="Connections every project uses live in Integrations.">
          <Link href="/integrations" className={BUTTON}>
            Open Integrations
          </Link>
        </Row>
      </Section>
    </>
  );
}

// ── Workspace ───────────────────────────────────────────────────────────

const WORKSPACE_LINKS = [
  { id: "integrations", label: "Integrations", description: "GitHub connection, MCP servers.", href: "/integrations" },
  { id: "library", label: "Library", description: "Agent skills and templates.", href: "/library" },
  { id: "memory", label: "Memory", description: "Saved facts and context.", href: "/memory" },
  { id: "team", label: "Team", description: "Agents, roles and performance.", href: "/team" },
  { id: "sandbox", label: "Agent sandbox", description: "Try tools without a task.", href: "/sandbox" },
  { id: "audit", label: "Audit log", description: "Every action the app took.", href: "/audit" },
];

export function WorkspaceTab({ projectId }: { projectId?: string }) {
  const [folder, setFolder] = useUiPref("projectsFolder");
  return (
    <>
      <Section title="Folders">
        <Row
          label="Projects folder"
          htmlFor="settings-projects-folder"
          description={folder ? `New project fills in ${suggestProjectPath(folder, "my-project")}.` : "New project fills in this folder plus the project name. Saved on this device."}
        >
          <CommitField id="settings-projects-folder" label="Projects folder" value={folder} placeholder="C:\code or ~/code" width="w-64" onCommit={setFolder} />
        </Row>
        <KnobText
          knob="WORKSPACE_ROOT"
          label="Worker workspace root"
          placeholder="./workspaces"
          description="Relative project paths resolve under this folder on the worker. Absolute paths are not affected. Unset uses WORKSPACE_ROOT from the worker env."
        />
      </Section>
      <Section title="Pages">
        {WORKSPACE_LINKS.map((link) => (
          <Link
            key={link.id}
            href={projectId ? `${link.href}?project=${projectId}` : link.href}
            className="flex items-center justify-between gap-6 px-4 py-3.5 transition-colors hover:bg-hover"
          >
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-ink">{link.label}</span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-3">{link.description}</span>
            </span>
            <ChevronRight size={13} className="shrink-0 text-ink-3" />
          </Link>
        ))}
      </Section>
    </>
  );
}

// ── Maintenance ─────────────────────────────────────────────────────────

const MAINTENANCE_JOBS = [
  { name: "sweep stale task worktrees", label: "Clean up worktrees", description: "Remove worktrees of finished tasks past retention.", confirm: true },
  { name: "sweep stale chat replies", label: "Settle stale chat replies", description: "Mark chat replies whose run died as interrupted, with Retry.", confirm: false },
  { name: "recover expired task leases", label: "Recover stuck tasks", description: "Requeue tasks whose worker lease expired.", confirm: false },
  { name: "task watchdog", label: "Run task watchdog", description: "Fail tasks that made no progress for 30 minutes.", confirm: true },
] as const;

export function MaintenanceTab() {
  const workers = useQuery(api.appSettings.workers, {});
  const jobs = useQuery(api.cronJobs.list, {});
  const runNow = useMutation(api.cronJobs.runNow);
  const toast = useToast();
  const confirm = useConfirm();
  const online = (workers ?? []).filter((w) => w.status === "online");
  const start = async (name: string) => {
    try {
      await runNow({ name });
      toast("success", "Started", name);
    } catch (err) {
      toast("error", "Couldn't start the job", errorText(err));
    }
  };
  return (
    <>
      <Section title="Worker">
        <Row
          label={workers === undefined ? "Checking…" : online.length > 0 ? `${online.length} worker${online.length === 1 ? "" : "s"} online` : "No worker online"}
          description={
            workers === undefined
              ? undefined
              : online.length > 0
                ? online.map((w) => `${w.hostname ?? w.workerId}: ${w.activeTasks}/${w.capacity} tasks, heartbeat ${relativeTime(w.lastHeartbeatAt)}`).join(" · ")
                : "Tasks and grounded chat wait until a worker runs. Start one with npm run dev."
          }
        />
      </Section>
      <Section title="Run now" description="The same jobs run on their own schedule (see Scheduled tasks).">
        {MAINTENANCE_JOBS.map((job) => {
          const run = jobs?.find((j) => j.name === job.name);
          return (
            <Row
              key={job.name}
              label={job.label}
              description={`${job.description} ${run?.lastStatus ? `Last run ${relativeTime(run.lastFinishedAt ?? run.lastStartedAt)}${run.lastStatus === "failed" ? " (failed)" : ""}.` : ""}`}
            >
              <button
                type="button"
                className={BUTTON}
                disabled={run?.lastStatus === "running"}
                onClick={() =>
                  job.confirm
                    ? confirm.ask({
                        title: `${job.label}?`,
                        message: job.description,
                        confirmLabel: "Run",
                        run: () => start(job.name),
                      })
                    : void start(job.name)
                }
              >
                {run?.lastStatus === "running" ? "Running…" : "Run"}
              </button>
            </Row>
          );
        })}
      </Section>
      {confirm.dialog}
    </>
  );
}

// ── Labs ────────────────────────────────────────────────────────────────

export function LabsTab() {
  return (
    <Section title="Experimental" description="Off by default. Each applies to the next task the worker starts.">
      <KnobToggle
        knob="ORCHESTRATOR_TOOL_LOOP"
        label="Agent tool loop"
        description="Read-only agents may call host tools in a loop during a subtask."
      />
      <KnobToggle
        knob="ORCHESTRATOR_PERFORMANCE_ROUTING"
        label="Performance routing"
        description="Prefer the agent with the best recorded results for a capability. Projects can override it."
      />
      <KnobToggle
        knob="ORCHESTRATOR_LOAD_AWARE_ROUTING"
        label="Load-aware routing"
        description="Prefer a capable agent with spare capacity. Projects can override it."
      />
      <KnobSelect
        knob="ORCHESTRATOR_ROUTER_LLM"
        label="LLM intent router"
        description="Ask an LLM how to route a task request when the rules are unsure."
        options={[
          { value: "off", label: "Off" },
          { value: "ambiguous", label: "When unsure" },
          { value: "always", label: "Always" },
        ]}
      />
      <KnobSelect
        knob="ORCHESTRATOR_DECISION_LLM"
        label="LLM decision advisor"
        description="Consult an LLM on orchestrator decisions. The rules still win when they disagree."
        options={[
          { value: "ambiguous", label: "When unsure" },
          { value: "always", label: "Always" },
          { value: "off", label: "Off" },
        ]}
      />
    </Section>
  );
}

// ── About ───────────────────────────────────────────────────────────────

type About = {
  name: string;
  version: string | null;
  commit: string | null;
  commitDate: string | null;
  branch: string | null;
  node: string;
  next: string | null;
  convex: string | null;
  notices: string | null;
};

export function AboutTab() {
  const [about, setAbout] = useState<About | null>(null);
  const [error, setError] = useState("");
  const [showNotices, setShowNotices] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/about")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as About;
      })
      .then((data) => !cancelled && setAbout(data))
      .catch((err) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, []);
  const commit = about?.commit ? about.commit.slice(0, 7) : null;
  return (
    <>
      <Section title="Fhara">
        {error && <Row label="Couldn't read version info" description={error} />}
        {!about && !error && <Row label="Loading…" />}
        {about && (
          <>
            <Row label="Version">
              <Muted>{about.version ?? "unknown"}</Muted>
            </Row>
            <Row label="Commit" description={about.commitDate ? new Date(about.commitDate).toLocaleString() : undefined}>
              {commit ? (
                <a href={`https://github.com/aldifhr/Fhara/commit/${about.commit}`} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-ink-2 hover:text-ink hover:underline">
                  {commit}
                  {about.branch && about.branch !== "HEAD" ? ` · ${about.branch}` : ""}
                </a>
              ) : (
                <Muted>Not a git checkout</Muted>
              )}
            </Row>
            <Row label="Runtime">
              <Muted>
                Node {about.node}
                {about.next ? ` · Next ${about.next}` : ""}
                {about.convex ? ` · Convex ${about.convex}` : ""}
              </Muted>
            </Row>
          </>
        )}
      </Section>
      <Section title="Licenses" description="Third-party code Fhara includes and its licenses.">
        <Row label="Third-party notices" description="THIRD_PARTY_NOTICES.md">
          <button type="button" className={BUTTON} disabled={!about?.notices} onClick={() => setShowNotices((v) => !v)}>
            {showNotices ? "Hide" : "Show"}
          </button>
        </Row>
        {showNotices && about?.notices && (
          <div className="px-4 py-3.5">
            <pre className="shell-scroll max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">{about.notices}</pre>
          </div>
        )}
      </Section>
    </>
  );
}

// ── Archive ─────────────────────────────────────────────────────────────

export function ArchiveTab() {
  const threads = useQuery(api.archive.list, {});
  const restore = useMutation(api.archive.restore);
  const remove = useMutation(api.archive.remove);
  const toast = useToast();
  const confirm = useConfirm();
  return (
    <>
      <Section title="Archived threads" description="Chats closed with New chat or by clearing a project chat. Restore one to continue it, or delete it for good.">
        {threads === undefined && <Row label="Loading…" />}
        {threads?.length === 0 && <Row label="Nothing archived" description="Closed chats with messages show up here." />}
        {(threads ?? []).map((t) => {
          const title =
            t.title ?? (t.kind === "personal" ? `Chat with ${t.agentName ?? "agent"}` : `${t.projectName ?? "Project"} chat`);
          return (
            <Row
              key={t._id}
              label={title}
              description={`${t.kind === "personal" ? "Personal" : "Project"} · ${t.messageCount} messages · closed ${relativeTime(t.closedAt)}${t.preview ? ` · ${t.preview}` : ""}`}
            >
              <button
                type="button"
                className={BUTTON}
                onClick={async () => {
                  try {
                    await restore({ conversationId: t._id });
                    toast("success", "Thread restored", "The thread it replaced was archived.");
                  } catch (err) {
                    toast("error", "Couldn't restore the thread", errorText(err));
                  }
                }}
              >
                Restore
              </button>
              <button
                type="button"
                aria-label={`Delete ${title}`}
                className={BUTTON}
                onClick={() =>
                  confirm.ask({
                    title: "Delete this thread?",
                    message: `${title} and its ${t.messageCount} messages are deleted. This can not be undone.`,
                    confirmLabel: "Delete",
                    run: async () => {
                      try {
                        let more = true;
                        while (more) more = (await remove({ conversationId: t._id })).more;
                        toast("success", "Thread deleted");
                      } catch (err) {
                        toast("error", "Couldn't delete the thread", errorText(err));
                      }
                    },
                  })
                }
              >
                <Trash2 size={13} />
              </button>
            </Row>
          );
        })}
      </Section>
      {confirm.dialog}
    </>
  );
}

// ── Sign in ─────────────────────────────────────────────────────────────

export function SignInTab() {
  return (
    <>
      <Section title="Account" description="Fhara runs locally for one person, so there is no Fhara login. Accounts it acts with are connected here.">
        <ul>
          <GithubAccountRow returnTo="/" alwaysShowReconnect />
        </ul>
      </Section>
    </>
  );
}
