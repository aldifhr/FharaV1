import { Children, isValidElement, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { useToast } from "../Toasts";
import { NEUTRAL_MENTION_COLOR, ROLE_COLORS, roleKeyForMention } from "@/lib/agentRoles";

/**
 * `@Role` mentions (from the user, or the CTO handing off to "@QA",
 * "@Frontend", …). A mention starts after whitespace/start/"(" and must not
 * continue into a path (`@src/app.tsx`) or file name (`@page.tsx`).
 */
const MENTION_RE = /(^|[\s(])@([A-Za-z][\w-]*)(?![\w-]|[./][\w])/g;

/**
 * Wrap mentions in bold markers so the markdown renderer hands them to the
 * `strong` override below, which draws them as chips. Fenced code blocks and
 * inline code are left untouched so code samples keep their `@decorators`.
 */
function markMentions(content: string): string {
  return content
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(MENTION_RE, "$1**@$2**")))
    .join("");
}

function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : isValidElement(child) ? textOf((child.props as { children?: ReactNode }).children) : ""))
    .join("");
}

function Strong({ children, className }: { children?: ReactNode; className?: string }) {
  const text = textOf(children).trim();
  if (/^@[A-Za-z][\w-]*$/.test(text)) {
    const roleKey = roleKeyForMention(text);
    return (
      <span
        data-mention={roleKey ?? text.slice(1).toLowerCase()}
        className={`mx-px inline-flex items-center rounded-md px-1.5 py-px align-baseline text-[0.95em] font-semibold leading-[1.35] ring-1 ring-inset ${roleKey ? ROLE_COLORS[roleKey] : NEUTRAL_MENTION_COLOR}`}
      >
        {text}
      </span>
    );
  }
  return <span className={`font-semibold ${className ?? ""}`} data-streamdown="strong">{children}</span>;
}

const COMPONENTS = { strong: Strong };

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
  const highlighted = markMentions(content ?? "");
  return (
    <div className="mt-1 max-w-3xl space-y-2 text-[13px] leading-5 text-[#4c4a55] dark:text-gray-200">
      <div className="markdown-body">
        <Streamdown
          mode={isAnimating ? "streaming" : "static"}
          plugins={{ code, math, mermaid, cjk }}
          components={COMPONENTS}
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
