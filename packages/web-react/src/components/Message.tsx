import { Check, Copy, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { Message as MessageT, ToolCard as ToolCardT } from "../lib/types";
import { Markdown } from "./Markdown";
import { OptionsGroupFooter, OptionsGroupProvider } from "./optionsGroup";
import { Avatar, IconButton } from "./ui";

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      aria-label="复制"
      size="sm"
      shape="square"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* ignore */
        }
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end animate-in">
      <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-[20px] bg-bubble px-4 py-2.5 text-[15.5px] leading-relaxed text-fg">
        {content}
      </div>
    </div>
  );
}

export function AssistantMessage({
  message,
  streaming,
  onRegenerate,
}: {
  message: MessageT;
  streaming?: boolean;
  /**
   * 历史 demo 占位 prop（App.tsx 仍传入，恒为 []）。真实工具卡走 P5 的 MessageRenderer
   * + components/ToolCard.tsx（新契约 `tool` 对象），不再经此 demo 通道，故此处保留类型
   * 以兼容 App.tsx 调用点但不渲染。
   */
  toolCards?: ToolCardT[];
  /** 提供时在该条助手消息下显示「重新生成」（重发上一轮）。仅最后一条传入。 */
  onRegenerate?: () => void;
}) {
  return (
    <div className="group flex gap-4 animate-in">
      <Avatar tone="brand" className="mt-0.5 hidden shadow-sm sm:inline-flex">
        <Sparkles size={16} />
      </Avatar>
      <div className="min-w-0 flex-1">
        {message.content ? (
          <OptionsGroupProvider>
            <Markdown>{message.content}</Markdown>
            <OptionsGroupFooter />
          </OptionsGroupProvider>
        ) : streaming ? (
          <div className="flex items-center gap-1.5 py-1 text-muted">
            <span className="size-2 animate-pulse rounded-full bg-muted" />
            <span className="size-2 animate-pulse rounded-full bg-muted [animation-delay:200ms]" />
            <span className="size-2 animate-pulse rounded-full bg-muted [animation-delay:400ms]" />
          </div>
        ) : null}
        {streaming && message.content && (
          <span className="caret-blink ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-fg" />
        )}
        {!streaming && message.content && (
          <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <CopyBtn text={message.content} />
            {onRegenerate && (
              <IconButton aria-label="重新生成" size="sm" shape="square" onClick={onRegenerate}>
                <RotateCcw size={15} />
              </IconButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
