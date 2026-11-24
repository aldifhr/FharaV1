import { useMemo, useState } from "react";
import { buildDecisionTray, latestOpenOptionPrompt, type TrayAction, type TrayItem } from "@/api/functions/lib/decisionTray";
import { parseOptions } from "@/lib/options";
import { useToast } from "../Toasts";
import type { ConfirmRequest } from "../ConfirmDialog";
import { useDecisionTray } from "./DecisionsTray";

type DecisionData = { approvals?: any[]; questions?: any[] };
type Mutation = (args: any) => Promise<any>;
type BindApproval = (approvalId: unknown) => { fingerprint?: string; shownAt?: number };

/**
 * The "Decision needed" tray for a project chat: builds the ordered item list
 * from the decisions read model, owns the pager/busy/confirm state, and runs
 * every action (command decisions, approvals, questions, option picks).
 * `sendToTray` lets the composer answer/decline the active item with free text.
 */
export function useDecisionTrayActions({
  decisions,
  agents,
  timeline,
  currentConversationId,
  boundTo,
  onSelectTask,
  chooseProposal,
  approve,
  reject,
  respondCommand,
  answerQuestion,
}: {
  decisions: DecisionData | undefined;
  agents: any[];
  timeline: any[];
  currentConversationId: string | null;
  boundTo: BindApproval;
  onSelectTask: (taskId: string) => void;
  chooseProposal: (choice: string) => Promise<void>;
  approve: Mutation;
  reject: Mutation;
  respondCommand: Mutation;
  answerQuestion: Mutation;
}) {
  const toast = useToast();
  const trayItems = useMemo(
    () =>
      buildDecisionTray({
        approvals: (decisions?.approvals ?? []) as any[],
        questions: (decisions?.questions ?? []) as any[],
        optionPrompt: latestOpenOptionPrompt(
          timeline.filter((m) => !m.streaming),
          parseOptions,
          (agentId) => agents.find((a: any) => a._id === agentId)?.role,
        ),
        conversationId: currentConversationId,
      }),
    [decisions, timeline, agents, currentConversationId],
  );
  const tray = useDecisionTray(trayItems);
  const [trayBusy, setTrayBusy] = useState<string | null>(null);
  const [trayConfirm, setTrayConfirm] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);

  const questionOf = (taskId?: string) => (decisions?.questions ?? []).find((q: any) => q.taskId === taskId)?.question ?? undefined;

  const runTrayAction = async (item: TrayItem, action: TrayAction, note?: string) => {
    if (action.confirm && !note) {
      setTrayConfirm({
        title: item.kind === "plan" ? "Reject this plan?" : "Reject these changes?",
        message: item.kind === "plan" ? "This task will stop as rejected." : "The pending changes will not be applied.",
        confirmLabel: "Reject",
        onOk: () => {
          setTrayConfirm(null);
          void runTrayAction(item, { ...action, confirm: false });
        },
      });
      return;
    }
    const busyKey = `${item.key}:${action.id}`;
    setTrayBusy(busyKey);
    try {
      if (action.id === "allow" || action.id === "always" || action.id === "always_exact" || action.id === "deny") {
        await respondCommand({ approvalId: item.approvalId as any, decision: action.id, ...(note ? { note } : {}), ...boundTo(item.approvalId) });
      } else if (action.id === "approve") {
        await approve({ approvalId: item.approvalId as any, ...boundTo(item.approvalId) });
      } else if (action.id === "reject") {
        await reject({ approvalId: item.approvalId as any, ...boundTo(item.approvalId) });
      } else if (action.id === "open") {
        if (item.taskId) onSelectTask(item.taskId);
      } else if (action.id.startsWith("answer:")) {
        const answer = note ?? item.options?.[Number(action.id.slice("answer:".length))] ?? "";
        const res: any = await answerQuestion({ taskId: item.taskId as any, answer, question: questionOf(item.taskId) });
        if (res && res.applied === false) toast("info", "This question has changed", "Open the task to see the latest question.");
      } else if (action.id.startsWith("pick:")) {
        const id = action.id.slice("pick:".length);
        await chooseProposal(`I choose ${id}: ${action.label.replace(/^\S+\.\s*/, "")}`);
      }
    } catch (err) {
      toast("error", "Decision not saved", err instanceof Error ? err.message : undefined);
    } finally {
      setTrayBusy(null);
    }
  };

  /** Text typed while the tray is open answers (questions) or declines with a note (commands). */
  const sendToTray = async (text: string): Promise<boolean> => {
    const item = tray.active ? tray.current : null;
    if (!item || text.startsWith("/")) return false;
    if (item.composerMode === "deny_with_note") {
      await runTrayAction(item, { id: "deny", label: "Deny" }, text);
      return true;
    }
    if (item.composerMode === "answer") {
      await runTrayAction(item, { id: "answer:0", label: text }, text);
      return true;
    }
    return false;
  };

  return { tray, trayBusy, trayConfirm, setTrayConfirm, runTrayAction, sendToTray };
}
