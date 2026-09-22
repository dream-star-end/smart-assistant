import { Check, Copy, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { Message as MessageT, ToolCard as ToolCardT } from "../lib/types";
import { Markdown } from "./Markdown";
import { OptionsGroupFooter, OptionsGroupProvider } from "./optionsGroup";
import { IconButton, useToast } from "./ui";

// demo 通道动作条:桌面 hover 露出;触屏没有 hover,常显并给 44px 触控靶(与 chat/cards 的口径一致)。
const DEMO_ACTIONS_CLASS =
  "mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <IconButton
      aria-label="复制"
      title="复制"
      size="sm"
      shape="square"
      className="[@media(hover:none)]:size-11"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast("复制失败，请手动选中文本复制", "error");
        }
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="group flex flex-col items-end animate-in">
      <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-[20px] bg-bubble px-4 py-2.5 text-[15.5px] leading-relaxed text-fg">
        {content}
      </div>
      {content && (
        <div className={DEMO_ACTIONS_CLASS}>
          <CopyBtn text={content} />
        </div>
      )}
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
    <div className="group min-w-0 animate-in">
      <div className="min-w-0">
        {message.content ? (
          // live 与 chat/cards 同口径:流式期 options 块禁止隐式发送(demo 下 ChatInteraction 为空,
          // 块本就不可交互,但契约要一致,别让 demo 通道成为唯一「流式也点击即发」的路径)。
          <OptionsGroupProvider live={!!streaming}>
            {/* 流式光标由 Markdown 内联到最后一个文本块末尾(与 chat/cards 同一实现)。 */}
            <Markdown caret={!!streaming}>{message.content}</Markdown>
            <OptionsGroupFooter />
          </OptionsGroupProvider>
        ) : streaming ? (
          // 三点跳动只有视觉,给读屏一个状态名;aria-hidden 掉装饰点。
          <output aria-live="polite" aria-label="正在生成回复" className="flex items-center gap-1.5 py-1 text-muted">
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-muted" />
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-muted [animation-delay:200ms]" />
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-muted [animation-delay:400ms]" />
          </output>
        ) : null}
        {!streaming && message.content && (
          <div className={DEMO_ACTIONS_CLASS}>
            <CopyBtn text={message.content} />
            {onRegenerate && (
              <IconButton
                aria-label="重新生成"
                title="重新生成"
                size="sm"
                shape="square"
                className="[@media(hover:none)]:size-11"
                onClick={onRegenerate}
              >
                <RotateCcw size={15} />
              </IconButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
