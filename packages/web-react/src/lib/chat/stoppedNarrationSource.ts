import type { ChatMessage } from "./model";

// Render-only links are created by splitStoppedNarration, never from JSON or a
// claimed source ID. Keeping the link outside the row also keeps it out of storage.
const stoppedNarrationSources = new WeakMap<ChatMessage, ChatMessage>();

export function registerStoppedNarrationSource(view: ChatMessage, source: ChatMessage): void {
  Object.defineProperty(view, "_continuationSourceId", { value: source.id, enumerable: false });
  stoppedNarrationSources.set(view, source);
}

export function stoppedNarrationContinuationSource(view: ChatMessage): ChatMessage | undefined {
  return stoppedNarrationSources.get(view);
}
