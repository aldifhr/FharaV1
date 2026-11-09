"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Copy, Webhook } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "./Toasts";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.";

const GHOST_BTN = "rounded-lg px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50";

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="grid gap-1">
      <span className="text-[12px] text-ink-3">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all truncate rounded-lg border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12.5px] text-ink">
          {value}
        </code>
        <button
          type="button"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => toast("success", `${label} copied`),
              () => undefined
            );
          }}
          className={GHOST_BTN}
        >
          <Copy size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * GitHub webhook setup for one integration: the URL to paste into GitHub
 * and a secret generated server-side and shown ONCE (only its ciphertext is
 * stored). Without any secret the backend rejects deliveries with 401.
 */
export default function GithubWebhookSetup({ integrationId }: { integrationId: string }) {
  const toast = useToast();
  const setup = useQuery(api.integrations.getWebhookSetup, { integrationId: integrationId as never });
  const generate = useAction(api.integrations.generateWebhookSecret);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  if (!setup) return null;

  let detail: string;
  if (setup.hasSecret) {
    detail = `Secret set${setup.secretSetAt ? ` ${new Date(setup.secretSetAt).toLocaleDateString()}` : ""}`;
  } else if (setup.envFallback) {
    detail = "Using GITHUB_WEBHOOK_SECRET";
  } else {
    detail = "No secret yet, deliveries are rejected";
  }

  const run = async () => {
    if (setup.hasSecret && !confirmRotate) {
      setConfirmRotate(true);
      return;
    }
    setBusy(true);
    try {
      const res = await generate({ integrationId: integrationId as never });
      setSecret(res.secret);
      setConfirmRotate(false);
    } catch (err) {
      toast("error", "Couldn't generate a webhook secret", errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="grid gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bubble text-ink-2">
          <Webhook size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px]">Webhook</p>
          <p className="truncate text-[12.5px] text-ink-3">{detail}</p>
        </div>
        {confirmRotate && !busy && (
          <button type="button" onClick={() => setConfirmRotate(false)} className={GHOST_BTN}>
            Cancel
          </button>
        )}
        <button type="button" disabled={busy || !setup.canEncrypt} onClick={() => void run()} className={GHOST_BTN}>
          {busy ? "Generating…" : confirmRotate ? "Rotate (old secret stops working)" : setup.hasSecret ? "Rotate secret" : "Generate secret"}
        </button>
      </div>
      {!setup.canEncrypt && !setup.hasSecret && (
        <p className="text-[12.5px] text-ink-3">
          Set PROVIDER_ENCRYPTION_KEY on the Convex deployment to store a per-project secret, or use GITHUB_WEBHOOK_SECRET.
        </p>
      )}
      {setup.webhookUrl ? (
        <CopyField label="Payload URL" value={setup.webhookUrl} />
      ) : (
        <p className="text-[12.5px] text-ink-3">The deployment's site URL is unknown, so the payload URL can't be shown.</p>
      )}
      <p className="text-[12.5px] text-ink-3">
        Under &quot;Let me select individual events&quot;, tick Check runs, Pull requests, Pull request reviews, Pull request review comments and Issue comments. The PR lanes and fix tasks read these.
      </p>
      {secret && (
        <div className="grid gap-1">
          <CopyField label="Secret" value={secret} />
          <p className="text-[12px] text-ink-3">
            Shown once. In GitHub open Settings → Webhooks → Add webhook, paste both values, and choose application/json.
          </p>
        </div>
      )}
    </li>
  );
}
