"use client";

/**
 * Workflow Studio (frontend only): visual node editor for agent workflows.
 * Definitions are persisted in localStorage via `@/lib/workflow`; nothing
 * here executes agents or touches Convex. "Simulate" is a dry-run preview
 * that walks the graph in topological order.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  Download,
  GitFork,
  Hand,
  Info,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Flag,
  CircleDot,
  Upload,
} from "lucide-react";
import { ROLE_KEYS, roleLabel } from "@/api/convex/lib/roles";
import {
  defaultWorkflow,
  loadWorkflows,
  newId,
  nodeById,
  previewOrder,
  saveWorkflows,
  validateWorkflow,
  workflowToBrief,
  type EdgeCondition,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from "@/lib/workflow";
import { useToast } from "../Toasts";
import ConfirmDialog, { type ConfirmRequest } from "../ConfirmDialog";

const NODE_W = 176;
const NODE_H = 104;
const CANVAS_W = 1280;
const CANVAS_H = 640;

const INPUT =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong";
const LABEL = "grid gap-1.5 text-[12.5px] text-ink-2";
const GHOST_BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-hover disabled:opacity-50";
const PRIMARY_BTN =
  "inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition hover:opacity-90 disabled:opacity-50";

const TYPE_META: Record<WorkflowNodeType, { label: string; badge: string; bar: string }> = {
  start: { label: "User / Start", badge: "bg-gray-500/10 text-gray-700 ring-gray-500/20 dark:bg-gray-500/20 dark:text-gray-200", bar: "bg-gray-400" },
  agent: { label: "Agent", badge: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:bg-emerald-500/20 dark:text-emerald-300", bar: "bg-emerald-500" },
  approval: { label: "Human approval", badge: "bg-amber-500/10 text-amber-800 ring-amber-500/20 dark:bg-amber-500/20 dark:text-amber-300", bar: "bg-amber-500" },
  conditional: { label: "Conditional branch", badge: "bg-violet-500/10 text-violet-700 ring-violet-500/20 dark:bg-violet-500/20 dark:text-violet-300", bar: "bg-violet-500" },
  end: { label: "Done", badge: "bg-blue-500/10 text-blue-700 ring-blue-500/20 dark:bg-blue-500/20 dark:text-blue-300", bar: "bg-blue-500" },
};

const CONDITION_LABELS: Record<EdgeCondition, string> = {
  always: "Always",
  on_success: "On success",
  on_failure: "On failure",
  custom: "Custom",
};

function NodeIcon({ type }: { type: WorkflowNodeType }) {
  switch (type) {
    case "start":
      return <CircleDot size={14} />;
    case "agent":
      return <Bot size={14} />;
    case "approval":
      return <Hand size={14} />;
    case "conditional":
      return <GitFork size={14} />;
    case "end":
      return <Flag size={14} />;
  }
}

function edgePath(from: WorkflowNode, to: WorkflowNode): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function edgeMid(from: WorkflowNode, to: WorkflowNode): { x: number; y: number } {
  return { x: (from.x + NODE_W + to.x) / 2, y: (from.y + to.y) / 2 + NODE_H / 2 };
}

export default function WorkflowStudio() {
  const toast = useToast();
  const [workflows, setWorkflows] = useState<Workflow[]>(() => [defaultWorkflow()]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [simStep, setSimStep] = useState(-1);
  const [simRunning, setSimRunning] = useState(false);
  const [confirmReq, setConfirmReq] = useState<(ConfirmRequest & { onOk: () => void }) | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ nodeId: string; dx: number; dy: number } | null>(null);
  const linkRef = useRef<{ from: string; x: number; y: number } | null>(null);
  const [linkLine, setLinkLine] = useState<{ from: string; x: number; y: number } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const simTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Hydration: localStorage only exists on the client.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const loaded = loadWorkflows();
    setWorkflows(loaded);
    setActiveId(loaded[0]?.id ?? null);
    setHydrated(true);
  }, []);

  const persist = useCallback((next: Workflow[]) => {
    setWorkflows(next);
    saveWorkflows(next);
  }, []);

  const workflow = useMemo(
    () => workflows.find((candidate) => candidate.id === activeId) ?? workflows[0],
    [workflows, activeId],
  );

  const issues = useMemo(() => (workflow ? validateWorkflow(workflow) : []), [workflow]);
  const order = useMemo(() => (workflow ? previewOrder(workflow) : []), [workflow]);

  const mutate = useCallback(
    (fn: (workflow: Workflow) => Workflow) => {
      if (!workflow) return;
      const next = workflows.map((candidate) =>
        candidate.id === workflow.id ? { ...fn(candidate), updatedAt: Date.now() } : candidate,
      );
      persist(next);
    },
    [persist, workflow, workflows],
  );

  const updateNode = useCallback(
    (nodeId: string, patch: Partial<WorkflowNode>) => {
      mutate((current) => ({
        ...current,
        nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
      }));
    },
    [mutate],
  );

  const addNode = useCallback(
    (type: WorkflowNodeType) => {
      if (!workflow) return;
      const titles: Record<WorkflowNodeType, string> = {
        start: "User",
        agent: "Agent step",
        approval: "Approval",
        conditional: "Branch",
        end: "Done",
      };
      const counts: Record<WorkflowNodeType, number> = { start: 0, agent: 0, approval: 0, conditional: 0, end: 0 };
      for (const node of workflow.nodes) counts[node.type] += 1;
      const node: WorkflowNode = {
        id: newId("node"),
        type,
        title: type === "agent" ? "Agent step" : titles[type],
        role: type === "agent" ? "frontend" : undefined,
        prompt: type === "agent" ? "Describe what this agent should do." : undefined,
        retries: type === "agent" ? 1 : undefined,
        message: type === "approval" ? "Approve to continue" : type === "conditional" ? "Pick the branch by the previous result" : undefined,
        x: 80 + (counts[type] * 28) % 440,
        y: 60 + counts[type] * 56 + (type === "agent" ? 0 : 0),
      };
      mutate((current) => ({ ...current, nodes: [...current.nodes, node] }));
      setSelectedNode(node.id);
      setSelectedEdge(null);
    },
    [mutate, workflow],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      if (!workflow) return;
      mutate((current) => ({
        ...current,
        nodes: current.nodes.filter((node) => node.id !== nodeId),
        edges: current.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
      }));
      if (selectedNode === nodeId) setSelectedNode(null);
    },
    [mutate, selectedNode, workflow],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      mutate((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== edgeId) }));
      if (selectedEdge === edgeId) setSelectedEdge(null);
    },
    [mutate, selectedEdge],
  );

  // Delete key removes the selection (not while typing in an input).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (selectedEdge) {
        event.preventDefault();
        deleteEdge(selectedEdge);
      } else if (selectedNode) {
        event.preventDefault();
        deleteNode(selectedNode);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedNode, selectedEdge, deleteNode, deleteEdge]);

  const stopSim = useCallback(() => {
    setSimRunning(false);
    setSimStep(-1);
    if (simTimer.current) clearInterval(simTimer.current);
    simTimer.current = null;
  }, []);

  const startSim = useCallback(() => {
    if (!workflow || order.length === 0) return;
    stopSim();
    setSimRunning(true);
    setSimStep(0);
    simTimer.current = setInterval(() => {
      setSimStep((step) => {
        if (step + 1 >= order.length) {
          if (simTimer.current) clearInterval(simTimer.current);
          setSimRunning(false);
          return step;
        }
        return step + 1;
      });
    }, 750);
  }, [order, stopSim, workflow]);

  useEffect(() => () => stopSim(), [stopSim]);

  const simulatedNodeId = simStep >= 0 && simStep < order.length ? order[simStep] : null;
  const simulatedUpTo = simStep >= 0 ? new Set(order.slice(0, simStep + 1)) : new Set<string>();

  const pointerPos = (event: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onNodePointerDown = (event: React.PointerEvent, node: WorkflowNode) => {
    if ((event.target as HTMLElement).closest("[data-port]")) return;
    event.preventDefault();
    const pos = pointerPos(event);
    dragRef.current = { nodeId: node.id, dx: node.x - pos.x, dy: node.y - pos.y };
    setSelectedNode(node.id);
    setSelectedEdge(null);
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (linkRef.current) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        setLinkLine({ ...linkRef.current, x: event.clientX - rect.left, y: event.clientY - rect.top });
        return;
      }
      if (!dragRef.current) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const { nodeId, dx, dy } = dragRef.current;
      updateNode(nodeId, {
        x: Math.max(0, Math.min(CANVAS_W - NODE_W, event.clientX - rect.left + dx)),
        y: Math.max(0, Math.min(CANVAS_H - NODE_H, event.clientY - rect.top + dy)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      linkRef.current = null;
      setLinkLine(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [updateNode]);

  const onPortDown = (event: React.PointerEvent, node: WorkflowNode) => {
    event.preventDefault();
    event.stopPropagation();
    const pos = pointerPos(event);
    linkRef.current = { from: node.id, x: pos.x, y: pos.y };
    setLinkLine({ from: node.id, x: pos.x, y: pos.y });
  };

  const onPortUp = (event: React.PointerEvent, node: WorkflowNode) => {
    event.preventDefault();
    event.stopPropagation();
    if (linkRef.current && linkRef.current.from !== node.id) {
      const from = linkRef.current.from;
      mutate((current) => {
        const exists = current.edges.some((edge) => edge.from === from && edge.to === node.id);
        if (exists) return current;
        return {
          ...current,
          edges: [...current.edges, { id: newId("edge"), from, to: node.id, condition: "always" as EdgeCondition }],
        };
      });
      toast("success", "Connected", `${nodeById(workflow!, from)?.title ?? from} → ${node.title}`);
    }
    linkRef.current = null;
    setLinkLine(null);
  };

  const createWorkflow = () => {
    const fresh = defaultWorkflow();
    fresh.name = `Workflow ${workflows.length + 1}`;
    persist([...workflows, fresh]);
    setActiveId(fresh.id);
    setSelectedNode(null);
    setSelectedEdge(null);
  };

  const duplicateWorkflow = () => {
    if (!workflow) return;
    const copy: Workflow = {
      ...structuredClone(workflow),
      id: newId("wf"),
      name: `${workflow.name} (copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    persist([...workflows, copy]);
    setActiveId(copy.id);
    toast("success", "Duplicated", copy.name);
  };

  const askDeleteWorkflow = () => {
    if (!workflow || workflows.length <= 1) return;
    setConfirmReq({
      title: `Delete "${workflow.name}"?`,
      message: "This workflow definition will be removed from this browser.",
      confirmLabel: "Delete",
      onOk: () => {
        const next = workflows.filter((candidate) => candidate.id !== workflow.id);
        persist(next);
        setActiveId(next[0]?.id ?? null);
        setSelectedNode(null);
        setSelectedEdge(null);
        setConfirmReq(null);
        toast("success", "Deleted", workflow.name);
      },
    });
  };

  const askResetCurrent = () => {
    if (!workflow) return;
    setConfirmReq({
      title: `Reset "${workflow.name}"?`,
      message: "This will restore the default template (User → CTO → Developer → QA → Reviewer → Done). The name is kept. Your edits to nodes and edges will be discarded.",
      confirmLabel: "Reset",
      onOk: () => {
        const fresh = defaultWorkflow();
        const reset: Workflow = { ...fresh, id: workflow.id, name: workflow.name, createdAt: workflow.createdAt, updatedAt: Date.now() };
        persist(workflows.map((candidate) => (candidate.id === workflow.id ? reset : candidate)));
        setSelectedNode(null);
        setSelectedEdge(null);
        stopSim();
        setConfirmReq(null);
        toast("success", "Reset", reset.name);
      },
    });
  };

  const askResetAll = () => {
    setConfirmReq({
      title: "Reset all workflows?",
      message: "All locally saved workflows will be replaced with the single default template.",
      confirmLabel: "Reset all",
      onOk: () => {
        const fresh = defaultWorkflow();
        persist([fresh]);
        setActiveId(fresh.id);
        setSelectedNode(null);
        setSelectedEdge(null);
        stopSim();
        setConfirmReq(null);
        toast("success", "Reset complete", fresh.name);
      },
    });
  };

  const exportWorkflow = () => {
    if (!workflow) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${workflow.name.replace(/[^\w-]+/g, "-")}.workflow.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importWorkflow = (file: File) => {
    file
      .text()
      .then((raw) => {
        const parsed = JSON.parse(raw) as Workflow;
        if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error("Not a workflow file");
        }
        const imported: Workflow = {
          ...parsed,
          id: newId("wf"),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        persist([...workflows, imported]);
        setActiveId(imported.id);
        toast("success", "Imported", imported.name);
      })
      .catch(() => toast("error", "Import failed", "The file is not a valid workflow JSON."));
  };

  const copyBrief = async () => {
    if (!workflow) return;
    try {
      await navigator.clipboard.writeText(workflowToBrief(workflow));
      toast("success", "Copied", "Paste it into a chat to brief the CTO.");
    } catch {
      toast("error", "Copy failed", "Clipboard is not available in this browser.");
    }
  };

  if (!hydrated || !workflow) {
    return <main className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-ink-3">Loading…</main>;
  }

  const selectedNodeObj = selectedNode ? nodeById(workflow, selectedNode) : undefined;
  const selectedEdgeObj = selectedEdge ? workflow.edges.find((edge) => edge.id === selectedEdge) : undefined;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      <ConfirmDialog request={confirmReq} onCancel={() => setConfirmReq(null)} onConfirm={() => confirmReq?.onOk()} />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
        <input
          value={workflow.name}
          onChange={(event) => {
            const name = event.target.value;
            mutate((current) => ({ ...current, name }));
          }}
          aria-label="Workflow name"
          className="w-52 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[15px] font-semibold text-ink outline-none transition focus:border-line hover:border-line"
        />
        <select
          value={workflow.id}
          onChange={(event) => {
            setActiveId(event.target.value);
            setSelectedNode(null);
            setSelectedEdge(null);
            stopSim();
          }}
          aria-label="Choose workflow"
          className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none"
        >
          {workflows.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        <span className="h-5 w-px bg-line" aria-hidden="true" />
        <button type="button" onClick={createWorkflow} className={GHOST_BTN} title="New workflow">
          <Plus size={14} /> New
        </button>
        <button type="button" onClick={duplicateWorkflow} className={GHOST_BTN} title="Duplicate this workflow">
          <Copy size={14} /> Duplicate
        </button>
        <button
          type="button"
          onClick={askDeleteWorkflow}
          disabled={workflows.length <= 1}
          className={`${GHOST_BTN} text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30`}
          title="Delete this workflow"
        >
          <Trash2 size={14} /> Delete
        </button>
        <button type="button" onClick={askResetCurrent} className={GHOST_BTN} title="Restore this workflow to the default template">
          <RotateCcw size={14} /> Reset
        </button>
        <button type="button" onClick={askResetAll} className={GHOST_BTN} title="Clear all workflows and restore the default template">
          <RotateCcw size={14} /> Reset all
        </button>
        <span className="h-5 w-px bg-line" aria-hidden="true" />
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Add node">
          <span className="text-[12px] text-ink-3">Add:</span>
          {(["agent", "approval", "conditional", "start", "end"] as WorkflowNodeType[]).map((type) => (
            <button key={type} type="button" onClick={() => addNode(type)} className={GHOST_BTN}>
              + {TYPE_META[type].label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {simRunning ? (
            <button type="button" onClick={stopSim} className={GHOST_BTN}>
              <Square size={14} /> Stop preview
            </button>
          ) : (
            <button type="button" onClick={startSim} disabled={order.length === 0} className={GHOST_BTN} title="Dry-run animation (no agents run)">
              <Play size={14} /> Simulate
            </button>
          )}
          <button type="button" onClick={copyBrief} className={GHOST_BTN} title="Copy a text brief describing this flow (paste into chat)">
            <Copy size={14} /> Copy run brief
          </button>
          <button type="button" onClick={exportWorkflow} className={GHOST_BTN} title="Download this workflow as JSON">
            <Download size={14} /> Export
          </button>
          <button type="button" onClick={() => importRef.current?.click()} className={GHOST_BTN} title="Import a workflow JSON file">
            <Upload size={14} /> Import
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import workflow JSON"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importWorkflow(file);
              event.target.value = "";
            }}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Canvas column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={canvasRef}
            className="relative min-h-0 flex-1 overflow-auto bg-canvas"
            onClick={() => {
              setSelectedNode(null);
              setSelectedEdge(null);
            }}
            aria-label="Workflow canvas. Drag nodes to move them. Drag from a node's right port to another node's left port to connect."
          >
            <div
              className="relative m-0"
              style={{
                width: CANVAS_W,
                height: CANVAS_H,
                backgroundImage: "radial-gradient(circle, rgba(128,128,128,0.18) 1px, transparent 1px)",
                backgroundSize: "22px 22px",
              }}
            >
              <svg className="absolute inset-0" width={CANVAS_W} height={CANVAS_H} aria-hidden="true">
                <defs>
                  <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 1 L 10 5 L 0 9 z" className="fill-ink-3" />
                  </marker>
                </defs>
                {workflow.edges.map((edge) => {
                  const from = nodeById(workflow, edge.from);
                  const to = nodeById(workflow, edge.to);
                  if (!from || !to) return null;
                  const active = selectedEdge === edge.id;
                  const lit = simulatedUpTo.has(edge.from) && simulatedUpTo.has(edge.to);
                  const mid = edgeMid(from, to);
                  return (
                    <g key={edge.id}>
                      <path
                        d={edgePath(from, to)}
                        fill="none"
                        strokeWidth={active ? 3 : 2}
                        markerEnd="url(#wf-arrow)"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedEdge(edge.id);
                          setSelectedNode(null);
                        }}
                        className={`cursor-pointer ${
                          active
                            ? "stroke-brand"
                            : lit
                              ? "stroke-emerald-500"
                              : edge.condition === "on_failure"
                                ? "stroke-violet-400"
                                : "stroke-ink-3"
                        }`}
                        style={{ opacity: active || lit ? 1 : 0.75 }}
                      />
                      {(edge.label || edge.condition !== "always") && (
                        <g
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedEdge(edge.id);
                            setSelectedNode(null);
                          }}
                          className="cursor-pointer"
                        >
                          <rect
                            x={mid.x - 52}
                            y={mid.y - 20}
                            width={104}
                            height={20}
                            rx={10}
                            className={active ? "fill-brand-soft" : "fill-panel"}
                          />
                          <text x={mid.x} y={mid.y - 6} textAnchor="middle" className="fill-ink-2" fontSize={10.5}>
                            {edge.label || CONDITION_LABELS[edge.condition]}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {linkLine && (
                  <path
                    d={`M ${nodeById(workflow, linkLine.from)?.x ?? 0} ${nodeById(workflow, linkLine.from)?.y ?? 0} L ${linkLine.x} ${linkLine.y}`}
                    fill="none"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    className="stroke-brand"
                  />
                )}
              </svg>

              {workflow.nodes.map((node) => {
                const meta = TYPE_META[node.type];
                const active = selectedNode === node.id;
                const simulated = simulatedNodeId === node.id;
                return (
                  <div
                    key={node.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Node: ${node.title} (${meta.label})`}
                    onPointerDown={(event) => onNodePointerDown(event, node)}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedNode(node.id);
                      setSelectedEdge(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedNode(node.id);
                        setSelectedEdge(null);
                      }
                    }}
                    className={`absolute select-none rounded-xl border bg-panel shadow-sm outline-none transition ${
                      active
                        ? "border-brand ring-2 ring-brand/30"
                        : simulated
                          ? "border-emerald-500 ring-2 ring-emerald-500/30"
                          : "border-line hover:border-line-strong"
                    }`}
                    style={{ left: node.x, top: node.y, width: NODE_W, minHeight: NODE_H }}
                  >
                    <span className={`block h-1 rounded-t-xl ${meta.bar}`} aria-hidden="true" />
                    <div className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <NodeIcon type={node.type} />
                        <p className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{node.title}</p>
                        {node.retries ? (
                          <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-ink-2" title="Max retries">
                            ↻{node.retries}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-[12px] text-ink-3">
                        {node.type === "agent"
                          ? `${roleLabel(node.role ?? "")} · ${node.prompt ?? "no instructions"}`
                          : node.type === "approval"
                            ? node.message ?? "Approve to continue"
                            : node.type === "conditional"
                              ? node.message ?? "Choose branch by result"
                              : meta.label}
                      </p>
                      <span className={`mt-1.5 inline-flex rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ${meta.badge}`}>
                        {meta.label}
                      </span>
                    </div>
                    <button
                      type="button"
                      data-port="in"
                      aria-label={`Connect into ${node.title}`}
                      onPointerDown={(event) => event.preventDefault()}
                      onPointerUp={(event) => onPortUp(event, node)}
                      className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-line-strong bg-canvas outline-none transition hover:scale-125 hover:border-brand"
                    />
                    <button
                      type="button"
                      data-port="out"
                      aria-label={`Connect from ${node.title}`}
                      onPointerDown={(event) => onPortDown(event, node)}
                      className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-line-strong bg-canvas outline-none transition hover:scale-125 hover:border-brand"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Validation strip */}
          <div className="border-t border-line bg-panel px-4 py-2.5">
            <p className="mb-1.5 text-[12.5px] font-semibold text-ink-2">
              Validation <span className="font-normal text-ink-3">({issues.length} issue{issues.length === 1 ? "" : "s"})</span>
            </p>
            {issues.length === 0 ? (
              <p className="flex items-center gap-1.5 text-[12.5px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 size={14} /> Valid — ready to copy the run brief.
              </p>
            ) : (
              <ul className="grid gap-1 md:grid-cols-2">
                {issues.map((issue, index) => (
                  <li key={index} className="flex items-start gap-1.5 text-[12.5px] text-ink-2">
                    {issue.level === "error" ? (
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-600" />
                    ) : issue.level === "info" ? (
                      <Info size={14} className="mt-0.5 shrink-0 text-sky-600" />
                    ) : (
                      <Info size={14} className="mt-0.5 shrink-0 text-amber-600" />
                    )}
                    <span>{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[11.5px] text-ink-3">
              Frontend definition only — Simulate is a dry-run animation; no agent runs and nothing is sent to Convex. Save happens in your browser (localStorage).
            </p>
          </div>
        </div>

        {/* Inspector */}
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-line bg-panel p-4 lg:block" aria-label="Inspector">
          {selectedNodeObj ? (
            <NodeInspector
              node={selectedNodeObj}
              workflow={workflow}
              onChange={(patch) => updateNode(selectedNodeObj.id, patch)}
              onDelete={() => deleteNode(selectedNodeObj.id)}
            />
          ) : selectedEdgeObj ? (
            <EdgeInspector
              edge={selectedEdgeObj}
              workflow={workflow}
              onChange={(patch) => {
                mutate((current) => ({
                  ...current,
                  edges: current.edges.map((edge) => (edge.id === selectedEdgeObj.id ? { ...edge, ...patch } : edge)),
                }));
              }}
              onDelete={() => deleteEdge(selectedEdgeObj.id)}
            />
          ) : (
            <div className="grid gap-2 text-[13px] text-ink-2">
              <p className="font-medium text-ink">No selection</p>
              <p>Click a node to edit it. Drag a node's right port onto another node's left port to connect. Fan-out (2+ outgoing edges) means the branches can run in parallel.</p>
              <p className="text-ink-3">Delete / Backspace removes the selection.</p>
            </div>
          )}
        </aside>
      </div>

      {/* Mobile inspector */}
      {(selectedNodeObj || selectedEdgeObj) && (
        <div className="border-t border-line bg-panel p-4 lg:hidden">
          {selectedNodeObj ? (
            <NodeInspector
              node={selectedNodeObj}
              workflow={workflow}
              onChange={(patch) => updateNode(selectedNodeObj.id, patch)}
              onDelete={() => deleteNode(selectedNodeObj.id)}
            />
          ) : selectedEdgeObj ? (
            <EdgeInspector
              edge={selectedEdgeObj}
              workflow={workflow}
              onChange={(patch) => {
                mutate((current) => ({
                  ...current,
                  edges: current.edges.map((edge) => (edge.id === selectedEdgeObj.id ? { ...edge, ...patch } : edge)),
                }));
              }}
              onDelete={() => deleteEdge(selectedEdgeObj.id)}
            />
          ) : null}
        </div>
      )}
    </main>
  );
}

function NodeInspector({
  node,
  workflow,
  onChange,
  onDelete,
}: {
  node: WorkflowNode;
  workflow: Workflow;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onDelete: () => void;
}) {
  const out = workflow.edges.filter((edge) => edge.from === node.id).length;
  const incomingCount = workflow.edges.filter((edge) => edge.to === node.id).length;
  return (
    <div className="grid gap-3">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <NodeIcon type={node.type} /> {TYPE_META[node.type].label} node
      </p>
      <label className={LABEL}>
        Title
        <input value={node.title} onChange={(event) => onChange({ title: event.target.value })} className={INPUT} aria-label="Node title" />
      </label>
      <label className={LABEL}>
        Type
        <select value={node.type} onChange={(event) => onChange({ type: event.target.value as WorkflowNodeType })} className={INPUT} aria-label="Node type">
          {(Object.keys(TYPE_META) as WorkflowNodeType[]).map((type) => (
            <option key={type} value={type}>
              {TYPE_META[type].label}
            </option>
          ))}
        </select>
      </label>
      {node.type === "agent" && (
        <>
          <label className={LABEL}>
            Role
            <select value={node.role ?? ""} onChange={(event) => onChange({ role: event.target.value })} className={INPUT} aria-label="Agent role">
              <option value="">Select a role…</option>
              {ROLE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {roleLabel(key)}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Instructions
            <textarea
              value={node.prompt ?? ""}
              onChange={(event) => onChange({ prompt: event.target.value })}
              rows={3}
              className={INPUT}
              placeholder="What should this agent do?"
              aria-label="Agent instructions"
            />
          </label>
          <label className={LABEL}>
            Retries (0–5)
            <input
              type="number"
              min={0}
              max={5}
              value={node.retries ?? 0}
              onChange={(event) => onChange({ retries: Math.max(0, Math.min(5, Number(event.target.value) || 0)) })}
              className={INPUT}
              aria-label="Max retries"
            />
          </label>
        </>
      )}
      {(node.type === "approval" || node.type === "conditional") && (
        <label className={LABEL}>
          {node.type === "approval" ? "Approval message" : "Condition text"}
          <input
            value={node.message ?? ""}
            onChange={(event) => onChange({ message: event.target.value })}
            className={INPUT}
            placeholder={node.type === "approval" ? "Approve to continue" : "e.g. QA failed"}
            aria-label={node.type === "approval" ? "Approval message" : "Condition text"}
          />
        </label>
      )}
      {node.type === "conditional" && (
        <p className="rounded-lg bg-hover px-2.5 py-2 text-[12px] text-ink-2">
          A conditional simply takes the branch whose edge label matches the result. Give it at least two outgoing edges and label them
          (e.g. "QA passes" / "QA fails").
        </p>
      )}
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <span>{incomingCount} in · {out} out</span>
        {out > 1 && <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">Parallel fan-out</span>}
      </div>
      <button type="button" onClick={onDelete} className="inline-flex items-center gap-1.5 self-start text-[13px] text-red-600 hover:underline">
        <Trash2 size={14} /> Delete node
      </button>
    </div>
  );
}

function EdgeInspector({
  edge,
  workflow,
  onChange,
  onDelete,
}: {
  edge: WorkflowEdge;
  workflow: Workflow;
  onChange: (patch: Partial<WorkflowEdge>) => void;
  onDelete: () => void;
}) {
  const from = nodeById(workflow, edge.from);
  const to = nodeById(workflow, edge.to);
  return (
    <div className="grid gap-3">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <RotateCcw size={14} /> Connection
      </p>
      <p className="rounded-lg bg-hover px-2.5 py-2 text-[13px] text-ink">
        {from?.title ?? edge.from} <span className="text-ink-3">→</span> {to?.title ?? edge.to}
      </p>
      <label className={LABEL}>
        Runs
        <select value={edge.condition} onChange={(event) => onChange({ condition: event.target.value as EdgeCondition })} className={INPUT} aria-label="Edge condition">
          <option value="always">Always</option>
          <option value="on_success">On success</option>
          <option value="on_failure">On failure</option>
          <option value="custom">Custom (label only)</option>
        </select>
      </label>
      <label className={LABEL}>
        Branch label
        <input
          value={edge.label ?? ""}
          onChange={(event) => onChange({ label: event.target.value })}
          className={INPUT}
          placeholder="e.g. QA passes"
          aria-label="Branch label"
        />
      </label>
      <button type="button" onClick={onDelete} className="inline-flex items-center gap-1.5 self-start text-[13px] text-red-600 hover:underline">
        <Trash2 size={14} /> Delete connection
      </button>
    </div>
  );
}
