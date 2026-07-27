import { ArrowLeftRight, CornerDownLeft, Puzzle, SendHorizonal, Wrench } from "lucide-react";
import { useState } from "react";
import type { Agent } from "../lib/agents";
import { reportClientFriction } from "../lib/clientFriction";
import type { ClickToRunStarter } from "../lib/starters";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui";

function outcomeTone(starter: ClickToRunStarter): string {
  return starter.deliverable === "chat" ? "text-faint" : "text-accent";
}

export function EmptyState({
  agent,
  onPrefill,
  onRun,
  onChangeAgent,
  getToken,
}: {
  agent: Agent;
  onPrefill: (text: string) => void;
  /** 请求 Composer 发送其当前正文；正文只有 Composer 这一份权威状态。 */
  onRun?: () => void;
  onChangeAgent: () => void;
  getToken?: () => string | null;
}) {
  const starters = agent.starters ?? [];
  const [armed, setArmed] = useState<ClickToRunStarter | null>(null);

  const armStarter = (starter: ClickToRunStarter) => {
    onPrefill(starter.prompt);
    setArmed(starter);
    reportClientFriction(
      {
        surface: "activation",
        stage: "first_screen",
        code: "FIRST_TASK_CLICKED",
        outcome: "succeeded",
      },
      getToken?.(),
    );
  };

  const runArmed = () => {
    if (!armed || !onRun) return;
    // 这里只发一个单调 submit signal，不能提前宣告“已发送”。Composer 是正文、
    // 附件上传和 disabled 状态的唯一权威：本次不能发送时保持正文，用户修正后可再次确认。
    onRun();
  };

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

      {starters.length > 0 ? (
        <>
          <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
            {starters.map((starter) => {
              const isArmed = armed?.id === starter.id;
              return (
                <button
                  key={starter.id}
                  type="button"
                  data-starter-id={starter.id}
                  aria-pressed={isArmed}
                  onClick={() => armStarter(starter)}
                  className={`group rounded-xl border p-3.5 text-left outline-none transition-[transform,box-shadow,border-color,color] duration-200 ease-standard hover:-translate-y-0.5 hover:shadow-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
                    isArmed
                      ? "border-accent bg-accent-soft text-fg"
                      : "border-border bg-surface text-muted hover:border-border-strong hover:text-fg"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <starter.icon size={14} className="shrink-0 text-accent" />
                    <span className="text-[13px] font-semibold text-fg">{starter.label}</span>
                    <span className={`ml-auto text-[11.5px] ${outcomeTone(starter)}`}>
                      {starter.outcome}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-[13.5px] leading-relaxed">
                    {starter.prompt}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            className="mt-4 flex min-h-[56px] w-full max-w-2xl items-center justify-center"
            aria-live="polite"
          >
            {armed && onRun ? (
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
                <Button
                  variant="primary"
                  shape="pill"
                  onClick={runArmed}
                  className="gap-1.5"
                >
                  <SendHorizonal size={15} />
                  发送并开跑
                </Button>
                <span className="text-[12.5px] text-faint">
                  已填进下方输入框，可以先改；发出后开始干活并消耗积分
                </span>
              </div>
            ) : (
              <span className="flex items-center gap-1.5 text-[12.5px] text-faint">
                <CornerDownLeft size={13} />
                点一张卡会先填进下方输入框，确认后再发出
              </span>
            )}
          </div>
        </>
      ) : (
        <AgentCapabilityHint agent={agent} />
      )}
    </div>
  );
}

function AgentCapabilityHint({ agent }: { agent: Agent }) {
  const capabilities = agent.capabilities ?? [];
  return (
    <div className="mt-8 w-full max-w-2xl">
      {capabilities.length > 0 && (
        <>
          <p className="text-[13px] font-semibold text-fg">它带了这些能力</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {capabilities.map((capability) => (
              <span
                key={`${capability.kind}:${capability.slug}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] ${
                  capability.ready
                    ? "border-border bg-surface text-muted"
                    : "border-warning/40 bg-surface text-warning"
                }`}
              >
                {capability.kind === "plugin" ? <Puzzle size={12} /> : <Wrench size={12} />}
                {capability.slug}
                {!capability.ready && <span className="text-[11px]">待授权</span>}
              </span>
            ))}
          </div>
        </>
      )}
      <p className="mt-4 text-[13.5px] leading-relaxed text-muted">
        直接把要办的事讲给它：说清楚你要什么、希望交付成什么（文件、代码或带来源的调研），
        它会自己拆步骤去做完。
      </p>
    </div>
  );
}
