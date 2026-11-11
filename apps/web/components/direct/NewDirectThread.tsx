"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/api/convex/_generated/api";
import Modal from "@/components/Modal";
import { useToast } from "@/components/Toasts";
import { BTN_OUTLINE, BTN_PRIMARY } from "@/components/chat/cards/primitives";
import { INSPECTOR_INPUT } from "@/components/ui/inspector";
import { ROLE_KEYS, roleLabel } from "@/api/convex/lib/roles";
import { threadHref } from "@/lib/threadTree";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] : "Please try again.");

/**
 * Start a direct thread (threadbear T3): one agent, one of the nine roles,
 * no planner. The only way one starts is this explicit action
 * (`directThreads.create`); it opens in the task thread panel.
 */
export default function NewDirectThread({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const create = useMutation(api.directThreads.create);
  const [role, setRole] = useState<string>("backend");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const message = text.trim();
      const { taskId } = await create({
        projectId: projectId as any,
        role,
        ...(message ? { text: message, clientId: `web-${Date.now().toString(36)}` } : {}),
      });
      onClose();
      router.push(threadHref({ projectId, taskId: String(taskId) }));
    } catch (err) {
      toast("error", "Couldn't start the thread", errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`New direct thread in ${projectName}`} onClose={onClose}>
      <div className="grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-caption">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)} className={INSPECTOR_INPUT}>
            {ROLE_KEYS.map((key) => (
              <option key={key} value={key}>
                {roleLabel(key)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-caption">First message (optional)</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className={`${INSPECTOR_INPUT} resize-y`} placeholder="What should the agent do?" />
        </label>
        <p className="text-[12px] text-ink-3">One agent works with you directly, without a plan. It asks before running commands your permission mode does not allow.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_OUTLINE} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={() => void start()} disabled={busy}>
            {busy ? "Starting…" : "Start thread"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
