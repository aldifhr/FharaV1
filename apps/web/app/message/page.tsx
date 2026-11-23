
import { useEffect } from "react";
import { useRouter } from "@/lib/spaRouter";
import { useQuery } from "@fhara/runtime/react";
import { api } from "@fhara/runtime/api";
import { personalIndexTarget } from "@/lib/personalChat";

/**
 * `/message` forwards to the most recent personal chat, or to the Personal
 * messages list when there is none.
 */
export default function PersonalMessageIndex() {
  const router = useRouter();
  const rows = useQuery(api.conversations.listPersonal, {});
  useEffect(() => {
    if (rows !== undefined) router.replace(personalIndexTarget(rows as never));
  }, [rows, router]);
  return (
    <p className="px-6 py-10 text-[13px] text-ink-3" role="status">
      Opening personal messages…
    </p>
  );
}
