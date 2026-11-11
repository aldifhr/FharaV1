"use client";

/**
 * One scheduled task's webhook (GOAT G8). The token is shown once, right
 * after it is made; only its hash is stored, so "Replace token" is the way
 * to get a new one. Deliveries wait (503, retry) while automation is held.
 */
import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "@/components/Toasts";
import { BUTTON, errorText, INPUT, LINK_BUTTON, relativeTime } from "./controls";
import type { ScheduledTaskRow } from "./scheduledTaskText";

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="flex gap-2">
      <input readOnly aria-label={label} className={`${INPUT} min-w-0 flex-1 font-mono text-[11.5px]`} value={value} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className={BUTTON}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast("success", "Copied", label);
          } catch {
            toast("error", "Couldn't copy", "Select the text and copy it instead.");
          }
        }}
      >
        Copy
      </button>
    </div>
  );
}

export function ScheduledTaskWebhook({ row }: { row: ScheduledTaskRow }) {
  const createToken = useAction(api.scheduledTaskHooks.createWebhookToken);
  const removeToken = useMutation(api.scheduledTaskHooks.removeWebhookToken);
  const toast = useToast();
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function makeToken() {
    setBusy(true);
    try {
      const result = await createToken({ scheduledTaskId: row._id });
      setFresh(result.token);
    } catch (err) {
      toast("error", "Couldn't make a webhook token", errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[12px] font-medium text-ink">Webhook</p>
      {row.hasWebhookToken || fresh ? (
        <>
          {row.webhookUrl ? (
            <CopyField label="Webhook URL" value={row.webhookUrl} />
          ) : (
            <p className="text-[11.5px] text-ink-3">The backend has no CONVEX_SITE_URL, so the URL can't be shown. Use your Convex site URL followed by /hooks/scheduled/{row._id}.</p>
          )}
          {fresh && (
            <>
              <CopyField label="Webhook token" value={fresh} />
              <p className="text-[11.5px] text-ink-3">Copy the token now: it is shown only once. Send it as Authorization: Bearer, and a delivery id header (x-fhara-delivery) so retries run once.</p>
            </>
          )}
          <p className="text-[11.5px] text-ink-3">
            POST to fire this task once. {row.webhookTokenSetAt ? `Token made ${relativeTime(row.webhookTokenSetAt)}.` : ""}
          </p>
          <div className="flex gap-3">
            <button type="button" className={LINK_BUTTON} disabled={busy} onClick={makeToken}>
              Replace token
            </button>
            <button
              type="button"
              className={LINK_BUTTON}
              disabled={busy}
              onClick={async () => {
                try {
                  await removeToken({ scheduledTaskId: row._id });
                  setFresh(null);
                  toast("success", "Webhook turned off", row.name);
                } catch (err) {
                  toast("error", "Couldn't turn the webhook off", errorText(err));
                }
              }}
            >
              Turn off webhook
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <p className="text-[11.5px] text-ink-3">Let another tool fire this task with a secret URL and token.</p>
          <button type="button" className={BUTTON} disabled={busy} onClick={makeToken}>
            Make webhook
          </button>
        </div>
      )}
    </div>
  );
}
