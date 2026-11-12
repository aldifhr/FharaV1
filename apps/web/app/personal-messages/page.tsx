import { redirect } from "next/navigation";

/**
 * Old personal messages URL (`/personal-messages`); the list now lives at
 * `/messages`.
 */
export default function LegacyPersonalMessagesPage() {
  redirect("/messages");
}
