import { redirect } from "@/lib/spaRouter";

/** Old personal-chat index (`/chats/personal`); it now lives at `/message`. */
export default function LegacyPersonalChatIndex() {
  redirect("/message");
}
