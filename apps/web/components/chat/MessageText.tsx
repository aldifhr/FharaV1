import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { useToast } from "../Toasts";

export default function MessageText({
  content,
  isAnimating = false,
}: {
  content: string;
  isAnimating?: boolean;
}) {
  const toast = useToast();
  // Make agent routing explicit in the transcript without changing the
  // persisted message text or mention semantics used by the worker.
  const highlighted = content.replace(/(^|\s)(@[A-Za-z][\w-]*)\b/g, "$1**$2**");
  return (
    <div className="mt-1 max-w-3xl space-y-2 text-[13px] leading-5 text-[#4c4a55] dark:text-gray-200">
      <div className="markdown-body">
        <Streamdown
          mode={isAnimating ? "streaming" : "static"}
          plugins={{ code, math, mermaid, cjk }}
          isAnimating={isAnimating}
          animated={{ animation: "blurIn", duration: 200, easing: "ease-out" }}
          dir="auto"
          codeBlockMaxHeight={320}
          tableMaxHeight={280}
          controls={{
            code: {
              copy: {
                onCopy: () => toast("success", "Copied to clipboard"),
                onError: (error) => toast("error", "Copy failed", error.message),
              },
            },
          }}
        >
          {highlighted}
        </Streamdown>
      </div>
    </div>
  );
}
