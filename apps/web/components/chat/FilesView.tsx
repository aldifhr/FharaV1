"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, FolderX } from "lucide-react";

export default function FilesView({ project }: { project: any }) {
  const workspacePath = (project as any)?.workspacePath as string | undefined;
  const projectId = (project as any)?._id as string | undefined;
  const [files, setFiles] = useState<string[] | null>(null);
  const [totalFiles, setTotalFiles] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [binaryNote, setBinaryNote] = useState<string | null>(null);
  // Ignore responses from earlier clicks (a slow file must not overwrite a newer one).
  const fileReqId = useRef(0);

  useEffect(() => {
    setImageSrc(null);
    setBinaryNote(null);
  }, [selected]);

  useEffect(() => {
    if (!workspacePath || !projectId) {
      setFiles(null);
      setSelected(null);
      return;
    }
    let cancelled = false;
    setFiles(null);
    setError("");
    setSelected(null);
    setContent(null);
    setImageSrc(null);
    setBinaryNote(null);
    fetch(`/api/project-files?projectId=${encodeURIComponent(projectId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if ((data as any)?.error) setError((data as any).error);
        else {
          const meta = data as { files?: string[]; totalFiles?: number; truncated?: boolean };
          setFiles(meta.files ?? []);
          setTotalFiles(meta.totalFiles ?? 0);
          setTruncated(!!meta.truncated);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load workspace files");
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, projectId]);

  const openFile = (filePath: string) => {
    if (!workspacePath || !projectId) return;
    const reqId = ++fileReqId.current;
    setSelected(filePath);
    setContent(null);
    setImageSrc(null);
    setBinaryNote(null);
    fetch(
      `/api/project-files?projectId=${encodeURIComponent(projectId)}&filePath=${encodeURIComponent(filePath)}`
    )
      .then((res) => res.json())
      .then((data) => {
        if (reqId !== fileReqId.current) return;
        if ((data as any)?.image && (data as any)?.data && (data as any)?.mime) {
          setImageSrc(`data:${(data as any).mime};base64,${(data as any).data}`);
          setContent("");
        } else if ((data as any)?.binary) {
          setContent("");
          setBinaryNote((data as any)?.reason ?? "Binary file — preview not available");
        } else {
          setContent((data as any)?.content ?? "");
        }
      })
      .catch(() => {
        if (reqId === fileReqId.current) setContent("Failed to load file");
      });
  };

  const visible = (files ?? []).filter(
    (file) => !query || file.toLowerCase().includes(query.toLowerCase())
  );

  if (project && !workspacePath) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-12 text-center">
        <FolderX size={22} className="text-ink-3" aria-hidden="true" />
        <p className="text-sm font-medium text-ink">This project has no folder set</p>
        <p className="max-w-xs text-xs text-ink-3">Add a folder path under More actions → Manage project to browse its files here.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      <div className={`flex w-full shrink-0 flex-col gap-2 md:w-72 ${selected ? "max-md:hidden" : ""}`}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files…"
          aria-label="Search files"
          className="rounded-xl border border-line bg-panel px-3 py-2 text-base outline-none focus:border-ink/30 focus-visible:ring-2 focus-visible:ring-ink/10 sm:text-sm"
        />
        <div className="max-h-[60vh] min-h-0 flex-1 overflow-y-auto rounded-xl border md:max-h-[calc(100dvh-16rem)] border-line bg-panel p-1">
          {error && <p className="px-2 py-2 text-xs text-rose-600">{error}</p>}
          {!error && !files && <p role="status" className="px-2 py-2 text-xs text-ink-3">Loading files…</p>}
          {truncated && files !== null && files.length > 0 ? (
            <p className="px-2 py-2 text-xs text-ink-3">Showing {files.length} of {totalFiles} files — the listing was truncated.</p>
          ) : null}
          {files && visible.length === 0 && (
            <p className="px-2 py-2 text-xs text-ink-3">{query ? "No files match." : "No files found."}</p>
          )}
          {visible.map((file) => (
            <button
              key={file}
              type="button"
              onClick={() => openFile(file)}
              aria-current={selected === file ? "true" : undefined}
              className={`flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[13px] outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 ${
                selected === file ? "bg-hover font-semibold" : ""
              }`}
            >
              <FileText size={13} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{file}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={`h-[calc(100dvh-16rem)] min-h-[320px] min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-panel ${selected ? "" : "max-md:hidden"}`}>
        {selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-line px-4 py-2">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-md px-1.5 py-0.5 text-xs font-medium text-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30 md:hidden"
              >
                ← Files
              </button>
              <p className="min-w-0 flex-1 truncate font-mono text-xs text-ink-3">{selected}</p>
            </div>
            {imageSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local file preview (blob/data URL), not an optimizable asset
              <img src={imageSrc} alt={selected} className="h-[calc(100%-41px)] w-full object-contain bg-panel-2" />
            ) : content === "" && binaryNote ? (
              <p className="flex h-[calc(100%-41px)] items-center justify-center text-sm text-ink-3">{binaryNote}</p>
            ) : (
              <pre className="h-[calc(100%-41px)] overflow-auto p-4 font-mono text-xs leading-5">
                {content ?? "Loading…"}
              </pre>
            )}
          </>
        ) : (
          <p className="flex h-full items-center justify-center text-sm text-ink-3">
            Select a file to preview it.
          </p>
        )}
      </div>
    </div>
  );
}
