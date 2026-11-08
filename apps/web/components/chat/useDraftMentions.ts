"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * File `@mention` state for the composer. Tracks the token being typed, the
 * workspace file list, and powers insertion + file-content attachment when a
 * message is sent.
 */
export function useDraftMentions(draft: string, setDraft: (v: string) => void, project: any, projectFiles: any[] | undefined) {
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

  const results = useMemo(() => {
    if (mention === null) return [];
    const q = mention.toLowerCase();
    const changedFiles = (projectFiles ?? []).map((f: any) => f.filePath as string);
    return [...new Set([...workspaceFiles, ...changedFiles])]
      .filter((p) => p.toLowerCase().includes(q))
      .slice(0, 30);
  }, [mention, projectFiles, workspaceFiles]);

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

  const insert = (path: string) => {
    const at = draft.lastIndexOf("@");
    const before = draft.slice(0, at);
    setDraft(`${before}@${path} `);
    setMention(null);
  };

  const handleInput = (value: string) => {
    setDraft(value);
    const at = value.lastIndexOf("@");
    const afterSpace = at >= 0 && (at === 0 || /\s/.test(value[at - 1]));
    const token = afterSpace ? value.slice(at + 1) : null;
    setMention(token !== null && !/\s/.test(token) ? token : null);
  };

  return { mention, setMention, results, insert, handleInput, attachMentionedFiles };
}
