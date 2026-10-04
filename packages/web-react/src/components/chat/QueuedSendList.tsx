/**
 * 还没开始发送的用户消息。钉在输入框上方，不进对话流。
 * 每条右侧是三个图标：修改（收回输入框）、删除（不发了）、立即发送（停掉当前这轮先发它）。
 * 立即发送用浅底而非实心主色：不和输入框的发送/停止键抢视觉，手机上仍是 44px 触控靶。
 */
import { ArrowUp, Clock3, PencilLine, Trash2 } from "lucide-react";
import type { ChatMessage } from "../../lib/chat/model";
import { IconButton } from "../ui";

export function QueuedSendList({
  messages,
  onEdit,
  onDelete,
  onSendNow,
}: {
  messages: ChatMessage[];
  onEdit: (message: ChatMessage) => void;
  onDelete?: (message: ChatMessage) => void;
  onSendNow: (message: ChatMessage) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4" data-testid="queued-send-list">
      <div className="overflow-hidden rounded-2xl border border-border bg-elevated shadow-soft">
        <div className="flex items-center gap-1.5 px-3.5 pt-2.5 text-caption text-faint">
          <Clock3 size={13} aria-hidden="true" />
          <span>待发送 {messages.length}</span>
        </div>
        <ul className="flex max-h-[min(13rem,30dvh)] flex-col overflow-y-auto px-1.5 pb-1.5 pt-1">
          {messages.map((message) => {
            const text = (message.text || "").trim();
            return (
              <li
                key={message.id}
                className="flex items-center gap-1 rounded-xl py-0.5 pl-2 pr-0.5"
                data-testid="queued-send-row"
              >
                <p className="min-w-0 flex-1 truncate text-left text-body text-fg" title={text || undefined}>
                  {text || <span className="text-faint">（无文字）</span>}
                </p>
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton
                    aria-label="修改"
                    title="修改"
                    variant="muted"
                    size="sm"
                    onClick={() => onEdit(message)}
                  >
                    <PencilLine size={15} />
                  </IconButton>
                  {onDelete && (
                    <IconButton
                      aria-label="删除"
                      title="删除"
                      variant="muted"
                      size="sm"
                      className="hover:bg-danger-soft hover:text-danger"
                      onClick={() => onDelete(message)}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  )}
                  <IconButton
                    aria-label="立即发送"
                    title="立即发送"
                    variant="subtle"
                    size="sm"
                    className="ml-0.5"
                    onClick={() => onSendNow(message)}
                  >
                    <ArrowUp size={15} strokeWidth={2.4} />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
