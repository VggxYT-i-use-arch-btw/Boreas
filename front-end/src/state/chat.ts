import type { ChatState } from "../types/chat";

export const initialChatState: ChatState = {
  conversations: [],
  activeConversationId: null,
  status: "idle",
  error: null,
  currentGenerationId: null,
};
