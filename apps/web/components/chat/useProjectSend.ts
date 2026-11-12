import { useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { newClientId, optimisticUserRow, withOptimisticRow } from "@/lib/optimisticChat";

/**
 * Idempotent, optimistic project-chat send (t3code idea #2): every send
 * carries a client id; the bubble draws at once and the server row with the
 * same clientId replaces it (reconcileOptimistic in the chat timeline).
 */
export function useProjectSend() {
  const sendMutation = useMutation(api.messages.send).withOptimisticUpdate((store, args) => {
    if (!args.clientId) return;
    const listArgs = { projectId: args.projectId };
    const current = store.getQuery(api.messages.listByProject, listArgs);
    if (current === undefined) return;
    const row = optimisticUserRow(
      {
        projectId: args.projectId as string,
        content: args.content,
        clientId: args.clientId,
        ...(args.quotedMessageId ? { quotedMessageId: args.quotedMessageId as string } : {}),
      },
      Date.now(),
    );
    store.setQuery(api.messages.listByProject, listArgs, withOptimisticRow(current as any[], row as any) as any);
  });
  return useCallback(
    (args: Omit<Parameters<typeof sendMutation>[0], "clientId"> & { clientId?: string }) =>
      sendMutation({ ...args, clientId: args.clientId ?? newClientId() }),
    [sendMutation],
  );
}
