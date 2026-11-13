const CHAT_TYPING_EVENT = "fhara:chat-typing";

export interface ChatTypingDetail {
  agentIds: string[];
  active: boolean;
}

export function dispatchChatTyping(detail: ChatTypingDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ChatTypingDetail>(CHAT_TYPING_EVENT, { detail }));
}

export function subscribeChatTyping(listener: (detail: ChatTypingDetail) => void) {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<ChatTypingDetail>).detail);
  window.addEventListener(CHAT_TYPING_EVENT, handler);
  return () => window.removeEventListener(CHAT_TYPING_EVENT, handler);
}
