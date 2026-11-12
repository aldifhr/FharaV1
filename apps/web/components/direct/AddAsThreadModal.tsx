"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/api/convex/_generated/api";
import Modal from "@/components/Modal";
import { useToast } from "@/components/Toasts";
import { BTN_OUTLINE, BTN_PRIMARY } from "@/components/chat/cards/primitives";
import { INSPECTOR_INPUT } from "@/components/ui/inspector";
import { threadHref } from "@/lib/threadTree";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] : "Please try again.");

/**
 * "Add as Thread" (plan 048): seed a new direct thread from the messages the
 * user selected in the project chat. The originals stay untouched; the new
 * thread starts with them as `user.message` events, and the first selected
 * message seeds the title and the role.
 */
export default function AddAsThreadModal({
  projectId,
  messageIds,
  firstText,
  onClose,
  onCreated,
}: {
  projectId: string;
  messageIds: string[];
  firstText: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const create = useMutation(api.directThreads.createFromMessages);
  const [title, setTitle] = useState(() => firstText.trim().slice(0, 80));
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const trimmed = title.trim();
      const { taskId } = await create({
        projectId: projectId as any,
        messageIds: messageIds as never[],
        ...(trimmed ? { title: trimmed } : {}),
        clientId: `add-as-thread-${Date.now().toString(36)}`,
      });
      onClose();
      onCreated();
      router.push(threadHref({ projectId, taskId: String(taskId), conversationId: null }));
    } catch (err) {
      toast("error", "Couldn't create the thread", errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add as thread" onClose={onClose}>
      <div className="grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-caption">Thread title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={INSPECTOR_INPUT}
            placeholder="Title for this thread"
          />
        </label>
        <p className="text-[12px] text-ink-3">
          {messageIds.length} message{messageIds.length === 1 ? "" : "s"} will start a new direct thread. The original messages stay in this chat.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_OUTLINE} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={() => void start()} disabled={busy}>
            {busy ? "Creating…" : "Create thread"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
