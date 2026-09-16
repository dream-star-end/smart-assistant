import { ArrowLeftRight } from "lucide-react";
import type { Agent } from "../lib/agents";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui";

const FALLBACK_STARTERS = [
  "帮我把下面这段内容整理成要点",
  "用一句话说明你能帮我做什么",
];

export function EmptyState({
  agent,
  onPrefill,
  onChangeAgent,
  onOpenGoal,
}: {
  agent: Agent;
  onPrefill: (text: string) => void;
  onChangeAgent: () => void;
  onOpenGoal?: () => void;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12 text-center animate-fade">
      <AgentAvatar agent={agent} className="mb-5 size-16 rounded-xl2 shadow-float" iconSize={30} />
      {/* h2 而非 h1:文档唯一的 h1 是 App 里给读屏定位的 sr-only 会话标题,欢迎页标题在
          语义上从属于当前会话;两个并列 h1 会稀释"我在哪个会话"的定位(shell 审计 S-10)。 */}
      <h2 className="text-[26px] font-semibold tracking-tight text-fg">{agent.name}</h2>
      <p className="mt-2 max-w-md text-[15px] leading-relaxed text-muted">{agent.description}</p>
      <Button
        variant="secondary"
        size="sm"
        shape="pill"
        onClick={onChangeAgent}
        className="mt-4 gap-1.5 text-muted"
      >
        <ArrowLeftRight size={13} />
        换一个智能体
      </Button>

      <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
        {(agent.starters?.length ? agent.starters : FALLBACK_STARTERS).map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => onPrefill(s)}
            // 手机竖屏放不下 4 张卡(占满整屏视口):前 2 张足以下手,其余 md 起恢复。
            className={`group rounded-xl border border-border bg-surface p-3.5 text-left text-[14px] leading-relaxed text-muted outline-none transition-[transform,box-shadow,border-color,color] duration-200 ease-standard hover:-translate-y-0.5 hover:border-border-strong hover:text-fg hover:shadow-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg${
              i >= 2 ? " hidden md:block" : ""
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      {onOpenGoal && (
        // 走 Button 原语而不是裸 <button>:11px 纯文字链接的命中区远低于 44px,原语在触屏下
        // 自带 min-h-11 兜底(shell 审计 S-09);视觉仍是文字链接。
        <Button
          variant="link"
          size="sm"
          className="mt-4 px-0 text-caption font-normal text-muted"
          onClick={onOpenGoal}
        >
          为这次会话设定目标
        </Button>
      )}
    </div>
  );
}
