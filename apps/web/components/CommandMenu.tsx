"use client";

import { useEffect, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import AgentAvatar from "./AgentAvatar";
import { agentName, roleLabel } from "@/lib/agentRoles";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

const itemClass = "my-0.5 min-w-0 gap-2.5 rounded-lg px-3 py-2.5";
const textClass = "flex min-w-0 flex-1 flex-col gap-0.5";
const titleClass = "block truncate text-sm font-medium leading-snug";
const subClass = "block truncate text-xs leading-normal text-muted-foreground";

export default function CommandMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const results = useQuery(api.search.global, q.trim() ? { q } : "skip");

  return (
    <CommandDialog
      open={open}
      onOpenChange={onClose}
      title="Command menu"
      description="Search projects, tasks, and agents"
      className="w-[min(560px,calc(100vw-32px))] max-w-full p-2 sm:max-w-[560px]"
    >
      <CommandPrimitive
        className="w-full min-w-0 overflow-hidden"
        filter={(value, search) => {
          const q = search.toLowerCase();
          if (!q) return 1;
          return value.toLowerCase().includes(q) ? 1 : 0;
        }}
      >
        <CommandInput value={q} onValueChange={setQ} placeholder="Search projects, tasks, agents…" />
        <CommandList className="p-1">
          <CommandEmpty>{q.trim() ? "No results." : "Start typing to search."}</CommandEmpty>

          {results?.projects.length ? (
            <CommandGroup heading="Projects">
              {results.projects.map((p) => (
                <CommandItem
                  key={p._id}
                  value={`${p.name} ${p.workspacePath}`}
                  className={itemClass}
                  onSelect={() => { onClose(); router.push(`/chats/${p._id}`); }}
                >
                  <span className={textClass}>
                    <span className={titleClass}>{p.name}</span>
                    <span className={subClass}>{p.workspacePath}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {results?.tasks.length ? (
            <CommandGroup heading="Tasks">
              {results.tasks.map((t) => (
                <CommandItem
                  key={t._id}
                  value={`${t.title} ${t.projectName} ${t.status}`}
                  className={itemClass}
                  onSelect={() => { onClose(); router.push(`/chats/${t.projectId}`); }}
                >
                  <span className={textClass}>
                    <span className={titleClass}>{t.title}</span>
                    <span className={subClass}>{t.projectName} · {t.status}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {results?.agents.length ? (
            <CommandGroup heading="Agents">
              {results.agents.map((a) => (
                <CommandItem
                  key={a._id}
                  value={`${agentName(a)} ${roleLabel(a.role)} ${a.status}`}
                  className={itemClass}
                  onSelect={() => { onClose(); if (a.projectId) router.push(`/chats/${a.projectId}`); }}
                >
                  <AgentAvatar name={agentName(a)} size={20} status={a.status} avatarParams={a.avatarParams} />
                  <span className={textClass}>
                    <span className={titleClass}>{agentName(a)}</span>
                    <span className={subClass}>{a.status}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandPrimitive>
    </CommandDialog>
  );
}
