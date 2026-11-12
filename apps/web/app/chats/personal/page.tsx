import { redirect } from "next/navigation";

/** Old personal-chat index (`/chats/personal`); it now lives at `/message`. */
export default function LegacyPersonalChatIndex() {
  redirect("/message");
}
