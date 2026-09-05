import { ArrowLeftRight } from "lucide-react";
import type { Agent } from "../lib/agents";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui";

export function EmptyState({
  agent,
  onPrefill,
  onChangeAgent,
}: {
  agent: Agent;
  onPrefill: (text: string) => void;
  onChangeAgent: () => void;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12 text-center animate-fade">
      <AgentAvatar agent={agent} className="mb-5 size-16 rounded-xl2 shadow-float" iconSize={30} />
      <h1 className="text-[26px] font-semibold tracking-tight text-fg">{agent.name}</h1>
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
        {(agent.starters ?? []).map((s, i) => (
          <button
            key={s}
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
    </div>
  );
}
