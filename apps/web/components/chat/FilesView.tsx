"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronsUpDown,
  FileCode2,
  FileImage,
  FileText,
  FolderX,
} from "lucide-react";

import {
  CollapseButton,
  File,
  Folder,
  Tree,
  type TreeViewElement,
} from "@/components/ui/file-tree";

function buildTree(paths: string[]): TreeViewElement[] {
  const roots: TreeViewElement[] = [];
  const byPath = new Map<string, TreeViewElement>();

  for (const filePath of paths) {
    const parts = filePath.split("/").filter(Boolean);
    let siblings = roots;
    let accumulated = "";

    parts.forEach((part, index) => {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const isFile = index === parts.length - 1;
      let node = byPath.get(accumulated);
      if (!node) {
        node = isFile
          ? { id: accumulated, name: part, type: "file" }
          : { id: accumulated, name: part, type: "folder", children: [] };
        byPath.set(accumulated, node);
        siblings.push(node);
      }
      if (!isFile && node.children) siblings = node.children;
    });
  }
  return roots;
}

function fileIconFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp"].includes(ext)) {
    return <FileImage className="size-4 shrink-0 text-ink-3" />;
  }
  if (
    ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "c", "cpp", "css", "html", "json", "yml", "yaml", "sh"].includes(ext)
  ) {
    return <FileCode2 className="size-4 shrink-0 text-ink-3" />;
  }
  return <FileText className="size-4 shrink-0 text-ink-3" />;
}

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

  const visible = useMemo(
    () => (files ?? []).filter((file) => !query || file.toLowerCase().includes(query.toLowerCase())),
    [files, query]
  );
  const tree = useMemo(() => buildTree(visible), [visible]);
  const initialExpanded = useMemo(
    () => tree.filter((node) => node.type === "folder").map((node) => node.id),
    [tree]
  );

  const renderNodes = (nodes: TreeViewElement[]): ReactNode =>
    nodes.map((node) =>
      node.type === "folder" ? (
        <Folder
          key={node.id}
          value={node.id}
          element={node.name}
          className="w-full text-[13px] text-ink"
        >
          {renderNodes(node.children ?? [])}
        </Folder>
      ) : (
        <File
          key={node.id}
          value={node.id}
          handleSelect={openFile}
          fileIcon={fileIconFor(node.name)}
          className="w-full max-w-full text-[13px] text-ink"
        >
          <span className="min-w-0 truncate">{node.name}</span>
        </File>
      )
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
      <div className={`flex w-full shrink-0 flex-col gap-3 md:w-80 ${selected ? "max-md:hidden" : ""}`}>
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">Workspace files</p>
            <p className="truncate text-xs text-ink-3">
              {files
                ? `${files.length} of ${totalFiles} file${totalFiles === 1 ? "" : "s"}${truncated ? " (listing truncated)" : ""}`
                : "Loading workspace…"}
            </p>
          </div>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files…"
          aria-label="Search files"
          className="rounded-xl border border-line bg-panel px-3 py-2 text-base outline-none focus:border-ink/30 focus-visible:ring-2 focus-visible:ring-ink/10 sm:text-sm"
        />
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-panel">
          {error ? (
            <p className="px-3 py-2 text-xs text-rose-600">{error}</p>
          ) : !files ? (
            <p role="status" className="px-3 py-2 text-xs text-ink-3">Loading files…</p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-3">
              {query ? "No files match your search." : "No files found."}
            </p>
          ) : (
            <Tree
              key={query || "all"}
              initialExpandedItems={initialExpanded}
              className="h-full py-2"
              indicator
            >
              <CollapseButton elements={tree} className="bottom-auto top-1">
                <ChevronsUpDown className="size-3.5 text-ink-3" />
              </CollapseButton>
              {renderNodes(tree)}
            </Tree>
          )}
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
