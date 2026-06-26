import { AlertTriangle, RotateCcw, Sparkles, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentGatePhase } from "../hooks/useAgentGate";
import { Button, Spinner } from "./ui";

/**
 * 对话前置引导面板（Aurora）。按 useAgentGate 的 phase 渲染：检查中 / 引导开通 /
 * 开机中（provisioning banner）/ 余额不足 / 运行时不可用 / 出错。当 phase 为
 * ready|dormant|idle 时返回 null —— 此时由对话区正常渲染。
 *
 * 该面板是「能进对话区 + 容器就绪门」的可视化前置：在容器 running 之前占据对话区，
 * 同时调用方据 gate.access 禁用 Composer，保证 P4 的 WS 不会在容器未就绪时连接。
 */
function Panel({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12 text-center animate-fade">
      <div className="mb-5 flex size-16 items-center justify-center rounded-xl2 bg-surface text-fg shadow-float">
        {icon}
      </div>
      <h1 className="text-[22px] font-semibold tracking-tight text-fg">{title}</h1>
      {desc && <p className="mt-2 max-w-md text-[14.5px] leading-relaxed text-muted">{desc}</p>}
      {children && <div className="mt-6 flex flex-col items-center gap-2">{children}</div>}
    </div>
  );
}

export function AgentGate({
  phase,
  onOpen,
  onRetry,
  onTopUp,
}: {
  phase: AgentGatePhase;
  /** 开通智能体（POST /api/agent/open）。 */
  onOpen: () => void;
  /** 重新查询状态（runtime-unavailable / error 重试）。 */
  onRetry: () => void;
  /** 去充值（402 余额不足）—— 当前打开设置/计费中心（P3.5）。 */
  onTopUp: () => void;
}) {
  switch (phase.kind) {
    case "checking":
      return (
        <Panel
          icon={<Spinner size={26} className="text-accent" />}
          title="正在检查智能体状态"
          desc="确认你的订阅与专属容器状态，稍候片刻…"
        />
      );

    case "unsubscribed":
      return (
        <Panel
          icon={<Sparkles size={30} className="text-accent" />}
          title="开通你的专属智能体"
          desc="开通后将为你启动一个独立、隔离的运行环境，即可使用全部模型与工具，按用量计费。"
        >
          <Button variant="accent" size="lg" shape="pill" onClick={onOpen}>
            <Sparkles size={16} /> 开通智能体
          </Button>
        </Panel>
      );

    case "opening":
      return (
        <Panel
          icon={<Spinner size={26} className="text-accent" />}
          title="正在开通"
          desc="正在为你创建订阅并启动专属容器…"
        />
      );

    case "provisioning":
      // provisioning banner：容器冷启硬前置，running 前不放行对话。
      return (
        <Panel
          icon={<Spinner size={26} className="text-accent" />}
          title="正在启动专属容器"
          desc="首次开机通常需要几十秒，就绪后即可开始对话，请稍候…"
        />
      );

    case "insufficient":
      return (
        <Panel
          icon={<Wallet size={28} className="text-warning" />}
          title="余额不足"
          desc={
            phase.shortfall
              ? `开通智能体所需积分不足，还差 ${phase.shortfall} 积分。充值后即可开通。`
              : "开通智能体所需积分不足，充值后即可开通。"
          }
        >
          <Button variant="accent" size="lg" shape="pill" onClick={onTopUp}>
            <Wallet size={16} /> 去充值
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpen} className="text-muted">
            充值后重试开通
          </Button>
        </Panel>
      );

    case "runtime-unavailable":
      return (
        <Panel
          icon={<AlertTriangle size={28} className="text-warning" />}
          title="智能体服务暂未就绪"
          desc="系统的智能体运行时正在准备中，请稍后再试。"
        >
          <Button variant="secondary" size="md" shape="pill" onClick={onRetry}>
            <RotateCcw size={15} /> 重试
          </Button>
        </Panel>
      );

    case "error":
      return (
        <Panel
          icon={<AlertTriangle size={28} className="text-danger" />}
          title="出错了"
          desc={
            <>
              {phase.message}
              {phase.requestId && (
                <span className="mt-1 block select-all font-mono text-[11px] text-faint">
                  追踪号 {phase.requestId}
                </span>
              )}
            </>
          }
        >
          <Button variant="secondary" size="md" shape="pill" onClick={onRetry}>
            <RotateCcw size={15} /> 重试
          </Button>
        </Panel>
      );

    default:
      // ready | dormant | idle：由对话区正常渲染，本面板不出现。
      return null;
  }
}
