"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import InitialAvatar from "@/components/InitialAvatar";
import { ROLES, type RoleKey } from "@/api/convex/lib/roles";

/**
 * Org chart, drawn like a classic organisation chart (top-down tree):
 * User / Owner at the top, CTO below, then one column per department
 * (Product, Engineering, Quality, Operations, Research), then the roles.
 * A card looks like an employee directory entry: avatar + name + title +
 * responsibility + capabilities. Clicking an agent card opens its
 * performance profile.
 *
 * Purely presentational: the data is the `orgIntel.orgChart` query (CTO at
 * the root); the User root and the department grouping are display-only.
 */

const CARD_W = 232;
const CARD_H = 176;
const COL_GAP = 48;
const ROW_GAP = 56;
const PAD = 24;
const VIEW_H = 700;

type CardKind = "user" | "cto" | "group" | "role";

interface Card {
  key: string;
  kind: CardKind;
  name: string;
  title: string;
  detail: string;
  agentId?: string;
  muted?: boolean;
  children: Card[];
}

interface Box {
  key: string;
  card: Card;
  x: number;
  y: number;
  w: number;
  h: number;
}

type ChartNode = {
  key: string;
  parent: string | null;
  roleKey: string;
  label: string;
  fixed: boolean;
  agentId: string | null;
  enabled: boolean;
  model: string | null;
  runtime: "api" | "opencode" | null;
  skills: number;
  tools: string[];
  capabilities: string[];
  maxConcurrency: number | null;
  registryName: string | null;
  registryEnabled: boolean | null;
};

function roleMeta(roleKey: string) {
  return (Object.keys(ROLES) as RoleKey[]).includes(roleKey as RoleKey)
    ? ROLES[roleKey as RoleKey]
    : null;
}

function buildTree(nodes: ChartNode[]): Card {
  const ctoNodes = nodes.filter((n) => n.roleKey === "cto");
  const rest = nodes.filter((n) => n.roleKey !== "cto");

  const roleCard = (n: ChartNode): Card => {
    const meta = roleMeta(n.roleKey);
    const tools = n.tools.length ? n.tools.join(", ") : "no tools";
    const vacant = !n.agentId;
    const disabled = !!n.agentId && !n.enabled;
    return {
      key: n.key,
      kind: "role",
      name: n.label,
      title: n.registryName ?? meta?.title ?? n.label,
      detail: [
        meta?.description ?? "",
        n.capabilities.length ? `Capabilities: ${n.capabilities.join(", ")}` : null,
        `${n.model ?? "default model"}${n.runtime === "opencode" ? " · OpenCode" : ""} · ${n.skills} skill${n.skills === 1 ? "" : "s"} · ${tools}`,
        vacant ? "Vacant — no agent yet" : disabled ? "Disabled" : null,
      ]
        .filter(Boolean)
        .join("\n"),
      agentId: n.agentId ?? undefined,
      muted: vacant || disabled,
      children: [],
    };
  };

  const groups = new Map<string, ChartNode[]>();
  for (const n of rest) {
    const category = roleMeta(n.roleKey)?.category ?? "Custom roles";
    const list = groups.get(category) ?? [];
    list.push(n);
    groups.set(category, list);
  }
  const groupCards: Card[] = [...groups.entries()].map(([category, members]) => ({
    key: `group:${category}`,
    kind: "group",
    name: category,
    title: `${members.length} role${members.length === 1 ? "" : "s"}`,
    detail: "",
    children: members.map(roleCard),
  }));

  // Departments hang under the first CTO; extra CTO agents (rare) also hang
  // under the user but have no departments of their own.
  const ctoCards: Card[] = ctoNodes.map((n, index) => {
    const card = roleCard(n);
    return { ...card, children: index === 0 ? groupCards : [] };
  });
  const user: Card = {
    key: "user",
    kind: "user",
    name: "User / Owner",
    title: "CEO",
    detail: "Gives the goal, approves risky steps, owns the final call.",
    children: ctoCards.length ? ctoCards : groupCards,
  };
  return user;
}

/** Top-down tree layout: children are placed side by side, parents centred over them. */
function layoutTree(root: Card): { boxes: Box[]; width: number; height: number } {
  const boxes: Box[] = [];
  const widthOf = (card: Card): number => {
    if (card.children.length === 0) return CARD_W;
    const total = card.children.reduce((sum, child) => sum + widthOf(child), 0);
    return Math.max(CARD_W, total + COL_GAP * (card.children.length - 1));
  };
  const place = (card: Card, x: number, y: number) => {
    const width = widthOf(card);
    const height = card.kind === "group" ? 56 : CARD_H;
    boxes.push({ key: card.key, card, x: x + (width - CARD_W) / 2, y, w: CARD_W, h: height });
    let cursor = x;
    for (const child of card.children) {
      place(child, cursor, y + height + ROW_GAP);
      cursor += widthOf(child) + COL_GAP;
    }
  };
  place(root, 0, 0);
  const width = widthOf(root) + PAD * 2;
  const height = Math.max(...boxes.map((box) => box.y + box.h)) + PAD * 2;
  return { boxes: boxes.map((box) => ({ ...box, x: box.x + PAD, y: box.y + PAD })), width, height };
}

function CardView({ box, onSelect }: { box: Box; onSelect: (card: Card) => void }) {
  const { card } = box;
  if (card.kind === "group") {
    return (
      <div
        data-orgcard="1"
        className="absolute flex flex-col justify-center rounded-lg border border-line bg-hover px-3 text-center"
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        aria-label={`Department: ${card.name}`}
      >
        <p className="text-[13px] font-semibold text-ink">{card.name}</p>
        <p className="text-[11px] text-ink-3">{card.title}</p>
      </div>
    );
  }
  const inner = (
    <>
      <div className="flex items-center gap-2.5">
        <InitialAvatar agent name={card.name} size={36} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-tight text-ink">{card.name}</p>
          <p className="truncate text-[11px] leading-tight text-ink-3">{card.title}</p>
        </div>
      </div>
      <p className="mt-2 line-clamp-4 break-words text-[11px] leading-snug text-ink-2">{card.detail}</p>
    </>
  );
  const style = { left: box.x, top: box.y, width: box.w, height: box.h } as const;
  const cls = `absolute rounded-lg border bg-canvas p-3 text-left shadow-sm transition ${
    card.muted ? "border-line opacity-60" : "border-line"
  } ${card.kind === "user" ? "border-brand ring-1 ring-brand/30" : ""}`;
  return card.agentId ? (
    <button type="button" data-orgcard="1" onClick={() => onSelect(card)} aria-label={`${card.name}, ${card.title}`} className={`${cls} outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40`} style={style}>
      {inner}
    </button>
  ) : (
    <div data-orgcard="1" className={cls} style={style}>
      {inner}
      <span className="sr-only">{card.title}</span>
    </div>
  );
}

export default function OrgChart() {
  const router = useRouter();
  const chart = useQuery(api.orgIntel.orgChart, {});
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const laidRef = useRef<{ width: number; height: number } | null>(null);

  const recenter = useCallback(() => {
    const view = viewRef.current;
    const laidSize = laidRef.current;
    if (!view || !laidSize) return;
    setOffset({
      x: Math.max(0, Math.round((view.clientWidth - laidSize.width) / 2)),
      y: PAD,
    });
  }, []);

  useEffect(() => {
    const clamp = (x: number, y: number) => {
      const view = viewRef.current;
      const laidSize = laidRef.current;
      if (!view || !laidSize) return { x, y };
      return {
        x: Math.min(PAD, Math.max(view.clientWidth - laidSize.width - PAD, x)),
        y: Math.min(PAD, Math.max(VIEW_H - laidSize.height - PAD, y)),
      };
    };
    const onMove = (event: PointerEvent) => {
      if (!panRef.current) return;
      const { startX, startY, ox, oy } = panRef.current;
      setOffset(clamp(ox + (event.clientX - startX), oy + (event.clientY - startY)));
    };
    const onUp = () => {
      panRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const tree = useMemo(() => (chart ? buildTree(chart.nodes as ChartNode[]) : null), [chart]);
  const laid = useMemo(() => (tree ? layoutTree(tree) : null), [tree]);

  laidRef.current = laid ? { width: laid.width, height: laid.height } : null;

  // Centre on the root the first time the chart is laid out.
  const centered = useRef(false);
  useEffect(() => {
    if (laid && !centered.current && viewRef.current) {
      centered.current = true;
      recenter();
    }
  }, [laid, recenter]);

  const connectors = useMemo(() => {
    if (!tree || !laid) return [];
    const byKey = new Map(laid.boxes.map((box) => [box.key, box]));
    const lines: Array<[number, number, number, number]> = [];
    const walk = (card: Card) => {
      const parent = byKey.get(card.key);
      if (!parent || card.children.length === 0) return;
      const parentBottomY = parent.y + parent.h;
      const busY = parentBottomY + ROW_GAP / 2;
      const parentCx = parent.x + parent.w / 2;
      const childCenters = card.children.map((child) => byKey.get(child.key)).filter(Boolean) as Box[];
      if (childCenters.length > 0) {
        // Trunk from parent + horizontal bus across children + drops into each child.
        lines.push([parentCx, parentBottomY, parentCx, busY]);
        const minX = Math.min(parentCx, ...childCenters.map((child) => child.x + child.w / 2));
        const maxX = Math.max(parentCx, ...childCenters.map((child) => child.x + child.w / 2));
        lines.push([minX, busY, maxX, busY]);
        for (const child of childCenters) {
          lines.push([child.x + child.w / 2, busY, child.x + child.w / 2, child.y]);
        }
      }
      for (const child of card.children) walk(child);
    };
    walk(tree);
    return lines;
  }, [tree, laid]);

  return (
    <section className="mt-14" aria-labelledby="org-heading">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="org-heading" className="text-[17px] font-semibold tracking-tight">
          Org chart
        </h2>
        {chart && (
          <p className="text-[12.5px] text-ink-3">
            User → CTO → departments → roles · {chart.counts.enabled} of {chart.counts.agents} agents enabled
            {chart.counts.vacant ? ` · ${chart.counts.vacant} vacant` : ""}
            {chart.counts.custom ? ` · ${chart.counts.custom} custom` : ""}
          </p>
        )}
      </header>
      {!chart || !laid ? (
        <div className="mt-6 h-64 animate-pulse rounded-xl bg-hover" aria-label="Loading org chart" />
      ) : (
        <div className="mt-6">
          <div className="flex items-center justify-end gap-2">
            <span className="text-[12px] text-ink-3">Drag the empty area to pan · click a card to open its profile.</span>
            <button
              type="button"
              onClick={recenter}
              className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-2 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              Reset view
            </button>
          </div>
          <div
            ref={viewRef}
            role="region"
            aria-label="Org chart canvas. Drag the empty area to pan; click a card to open its profile."
            className="relative mt-2 cursor-grab overflow-hidden rounded-xl border border-line bg-panel active:cursor-grabbing"
            style={{ height: VIEW_H }}
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("[data-orgcard]")) return;
              panRef.current = { startX: event.clientX, startY: event.clientY, ox: offset.x, oy: offset.y };
            }}
          >
            <div
              className="absolute left-0 top-0"
              style={{ width: laid.width, height: laid.height, transform: `translate(${offset.x}px, ${offset.y}px)` }}
            >
            <svg className="absolute inset-0" width={laid.width} height={laid.height} aria-hidden="true">
              {connectors.map(([x1, y1, x2, y2], index) => (
                <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={1.5} className="stroke-line-strong" />
              ))}
            </svg>
            {laid.boxes.map((box) => (
              <CardView
                key={box.key}
                box={box}
                onSelect={(card) => {
                  if (card.agentId) router.push(`/team/${card.agentId}`);
                }}
              />
            ))}
            </div>
          </div>
        </div>
      )}
      <p className="mt-3 text-[12px] text-ink-3">
        Reporting line is the solid tree. Who reviews, verifies or hands off to whom is in the Collaboration graph below — there it is weighted by real history.
      </p>
    </section>
  );
}
