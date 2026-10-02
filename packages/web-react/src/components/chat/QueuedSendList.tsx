/**
 * 还没开始发送的用户消息。钉在输入框上方，不进对话流。
 * 每条右侧是「修改」和「立即发送」。
 */
import type { ChatMessage } from "../../lib/chat/model";

export function QueuedSendList({
  messages,
  onEdit,
  onSendNow,
}: {
  messages: ChatMessage[];
  onEdit: (message: ChatMessage) => void;
  onSendNow: (message: ChatMessage) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4" data-testid="queued-send-list">
      <div className="overflow-hidden rounded-lg border border-border bg-elevated shadow-soft">
        <div className="px-3 py-2 text-xs font-medium text-muted">待发送 {messages.length}</div>
        <ul className="flex max-h-[min(13rem,30dvh)] flex-col gap-1.5 overflow-y-auto border-t border-border px-3 py-2">
          {messages.map((message) => {
            const text = (message.text || "").trim();
            return (
              <li key={message.id} className="flex items-center gap-3" data-testid="queued-send-row">
                <p className="min-w-0 flex-1 truncate text-left text-body text-fg">
                  {text || "（无文字）"}
                </p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onEdit(message)}
                    className="inline-flex items-center rounded-full bg-card px-2.5 py-1 text-caption font-medium text-fg transition-colors hover:brightness-95 [@media(hover:none)]:min-h-11"
                  >
                    修改
                  </button>
                  <button
                    type="button"
                    onClick={() => onSendNow(message)}
                    className="inline-flex items-center rounded-full bg-card px-2.5 py-1 text-caption font-medium text-fg transition-colors hover:brightness-95 [@media(hover:none)]:min-h-11"
                  >
                    立即发送
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
