import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MessageText({ content }: { content: string }) {
  // Make agent routing explicit in the transcript without changing the
  // persisted message text or mention semantics used by the worker.
  const highlighted = content.replace(/(^|\s)(@[A-Za-z][\w-]*)\b/g, "$1**$2**");
  return (
    <div className="mt-1 max-w-3xl space-y-2 text-[13px] leading-5 text-[#4c4a55] dark:text-gray-200">
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{highlighted}</ReactMarkdown>
      </div>
    </div>
  );
}
