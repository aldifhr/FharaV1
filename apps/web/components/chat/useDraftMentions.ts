"use client";

import { useEffect, useMemo, useState } from "react";
import { roleLabel } from "@/lib/agentRoles";

/**
 * `@mention` state for the composer. One token drives both:
 *  - agent mentions (`@CTO who are you`) → routing
 *  - file mentions (`@src/app/page.tsx`) → file-content attachment on send
 */
export function useDraftMentions(
  draft: string,
  setDraft: (v: string) => void,
  project: any,
  projectFiles: any[] | undefined,
  agents: Array<{ _id: string; name: string; role: string }> = []
) {
  const [mention, setMention] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);

  useEffect(() => {
    const workspacePath = project?.workspacePath;
    if (!workspacePath) {
      setWorkspaceFiles([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to list project files");
        return (await response.json()) as { files?: string[] };
      })
      .then((data) => {
        if (!cancelled) setWorkspaceFiles(data.files ?? []);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.workspacePath]);

  const fileResults = useMemo(() => {
    if (mention === null) return [];
    const q = mention.toLowerCase();
    const changedFiles = (projectFiles ?? []).map((f: any) => f.filePath as string);
    return [...new Set([...workspaceFiles, ...changedFiles])]
      .filter((p) => p.toLowerCase().includes(q))
      .slice(0, 30);
  }, [mention, projectFiles, workspaceFiles]);

  const agentResults = useMemo(() => {
    if (mention === null) return [];
    const q = mention.toLowerCase();
    return agents
      .filter((a) => {
        const label = roleLabel(a.role).toLowerCase();
        return label.includes(q) || a.name.toLowerCase().includes(q);
      })
      .slice(0, 6);
  }, [mention, agents]);

  /** Read `@path` contents from the workspace and append them to `text`. */
  const attachMentionedFiles = async (text: string) => {
    const workspacePath = project?.workspacePath;
    if (!workspacePath) return text;
    const paths = [...new Set(
      [...text.matchAll(/@([\w./-]+\.[\w]{1,12})/g)].map((match) => match[1]),
    )];
    if (paths.length === 0) return text;
    const contents = await Promise.all(paths.map(async (filePath) => {
      const params = new URLSearchParams({ workspacePath, filePath });
      const response = await fetch(`/api/project-files?${params}`);
      if (!response.ok) return "";
      const data = (await response.json()) as { content?: string };
      return data.content ? `\n\n--- File: ${filePath} ---\n${data.content}` : "";
    }));
    return `${text}${contents.join("")}`.slice(0, 8000);
  };

  /** Agent ids mentioned in the text (`@CTO`, `@Frontend`, …). */
  const mentionedAgentIds = (text: string): string[] =>
    agents
      .filter((a) => new RegExp(`@${escapeRegExp(roleLabel(a.role))}\\b`, "i").test(text))
      .map((a) => a._id);

  const insert = (path: string) => {
    const at = draft.lastIndexOf("@");
    const before = draft.slice(0, at);
    setDraft(`${before}@${path} `);
    setMention(null);
  };

  const insertAgent = (agent: { _id: string; name: string; role: string }) => {
    const at = draft.lastIndexOf("@");
    const before = draft.slice(0, at);
    setDraft(`${before}@${roleLabel(agent.role)} `);
    setMention(null);
  };

  const handleInput = (value: string) => {
    setDraft(value);
    const at = value.lastIndexOf("@");
    const afterSpace = at >= 0 && (at === 0 || /\s/.test(value[at - 1]));
    const token = afterSpace ? value.slice(at + 1) : null;
    setMention(token !== null && !/\s/.test(token) ? token : null);
  };

  return {
    mention,
    setMention,
    results: fileResults,
    agentResults,
    insert,
    insertAgent,
    mentionedAgentIds,
    handleInput,
    attachMentionedFiles,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
