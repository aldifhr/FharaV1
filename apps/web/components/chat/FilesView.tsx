"use client";

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";

export default function FilesView({ project }: { project: any }) {
  const workspacePath = (project as any)?.workspacePath as string | undefined;
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [binaryNote, setBinaryNote] = useState<string | null>(null);

  useEffect(() => {
    setImageSrc(null);
    setBinaryNote(null);
  }, [selected]);

  useEffect(() => {
    if (!workspacePath) return;
    setFiles(null);
    setError("");
    setSelected(null);
    setContent(null);
    setImageSrc(null);
    setBinaryNote(null);
    fetch(`/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then((res) => res.json())
      .then((data) => {
        if ((data as any)?.error) setError((data as any).error);
        else setFiles((data as any)?.files ?? []);
      })
      .catch(() => setError("Failed to load workspace files"));
  }, [workspacePath]);

  const openFile = (filePath: string) => {
    if (!workspacePath) return;
    setSelected(filePath);
    setContent(null);
    setImageSrc(null);
    setBinaryNote(null);
    fetch(
      `/api/project-files?workspacePath=${encodeURIComponent(workspacePath)}&filePath=${encodeURIComponent(filePath)}`
    )
      .then((res) => res.json())
      .then((data) => {
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
      .catch(() => setContent("Failed to load file"));
  };

  const visible = (files ?? []).filter(
    (file) => !query || file.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="flex min-h-0 flex-1 gap-4 p-5">
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files…"
          aria-label="Search files"
          className="rounded-xl border border-[#e5e3eb] bg-white px-3 py-2 text-sm outline-none focus:border-[#a29ae8] dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[#e5e3eb] bg-white p-1 dark:border-gray-800 dark:bg-gray-900">
          {error && <p className="px-2 py-2 text-xs text-rose-600">{error}</p>}
          {!error && !files && <p className="px-2 py-2 text-xs text-gray-400">Loading files…</p>}
          {files && visible.length === 0 && (
            <p className="px-2 py-2 text-xs text-gray-400">No files found.</p>
          )}
          {visible.map((file) => (
            <button
              key={file}
              type="button"
              onClick={() => openFile(file)}
              className={`flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-gray-100 dark:hover:bg-gray-800 ${
                selected === file ? "bg-gray-100 font-semibold dark:bg-gray-800" : ""
              }`}
            >
              <FileText size={13} className="shrink-0 text-gray-400" />
              <span className="min-w-0 flex-1 truncate">{file}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-[#e5e3eb] bg-white dark:border-gray-800 dark:bg-gray-900">
        {selected ? (
          <>
            <p className="border-b border-[#e5e3eb] px-4 py-2.5 font-mono text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
              {selected}
            </p>
            {imageSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageSrc} alt={selected} className="h-[calc(100%-37px)] w-full object-contain bg-gray-50 dark:bg-gray-950" />
            ) : content === "" && binaryNote ? (
              <p className="flex h-[calc(100%-37px)] items-center justify-center text-sm text-gray-400">{binaryNote}</p>
            ) : (
              <pre className="h-[calc(100%-37px)] overflow-auto p-4 font-mono text-xs leading-5 dark:text-gray-200">
                {content ?? "Loading…"}
              </pre>
            )}
          </>
        ) : (
          <p className="flex h-full items-center justify-center text-sm text-gray-400">
            Select a file to preview it.
          </p>
        )}
      </div>
    </div>
  );
}
