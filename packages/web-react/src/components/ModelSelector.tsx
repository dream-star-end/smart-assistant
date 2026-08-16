import {
  DEFAULT_CODEX_ENGINE_MODEL,
  DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME,
} from "@openclaude/protocol";
import { AlertTriangle, Check, ChevronDown, Cpu, Users, Zap } from "lucide-react";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { PublicModel } from "../lib/types";
import { cn } from "../lib/utils";
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui";
import type { PreferenceEffort } from "../lib/modelPreferences";
import { EFFORT_OPTIONS } from "./settings/labels";

/**
 * 模型是否被后端标注为降级(0108 provider 健康度)。前端类型宽松透传,运行时 narrowing。
 */
export function isDegraded(m: PublicModel): boolean {
  return (m as { degraded?: unknown }).degraded === true;
}

/**
 * 模型展示名。后端 PublicModel.display_name 是权威标签（pricing.ts），但前端类型
 * 宽松透传（`{ id: string; [k]: unknown }`），故运行时做一次 string narrowing，
 * 缺失/非串时退回 model id —— 绝不臆造映射，避免与后端两套权威源漂移。
 */
export function modelLabel(m: PublicModel): string {
  const dn = (m as { display_name?: unknown }).display_name;
  return typeof dn === "string" && dn.trim() ? dn : m.id;
}

/**
 * 团队模式队长引擎的展示名。引擎 id 权威 = @openclaude/protocol 的
 * DEFAULT_CODEX_ENGINE_MODEL（与 master bridge teamMode 强制覆盖的常量同源，
 * 见 commercial ws/userChatBridge.ts「teamMode.main」分支）；展示名优先取
 * /api/public/models 里同 id 模型的 display_name，列表未含该模型时退回固定标签。
 */
export function teamEngineLabel(models: PublicModel[]): string {
  const m = models.find((x) => x.id === DEFAULT_CODEX_ENGINE_MODEL);
  return m ? modelLabel(m) : DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME;
}

/**
 * 对话模型选择器（Aurora 顶栏）。完全由 GET /api/public/models 的结果驱动，
 * 不持有任何硬编码/demo 模型列表（demo 预览的 fixture 由调用方注入）。选中的 model id
 * 上抛给 App 顶层状态，P4 的 WS inbound.message 据此发送（前端只发 agentId + model，
 * agent→model 的最终权威在后端）。
 *
 * teamEngineActive（团队模式 × main 会话）时后端 bridge 会把实际执行模型强制覆盖为
 * 队长引擎（teamEngineLabel）——此时触发器如实显示实际生效引擎而非用户自选模型，
 * 菜单顶部追加不可选说明态；用户自选模型仍保留选中记忆（团队模式关闭后生效）。
 * 显示诚信原则：用户看到的必须是真的。
 */
export function ModelSelector({
  models,
  selectedId,
  onSelect,
  loading,
  teamEngineActive,
}: {
  models: PublicModel[];
  selectedId?: string;
  onSelect: (id: string) => void;
  loading?: boolean;
  /** 团队模式已开启且当前会话是 main（队长引擎覆盖生效）。由 App 的 teamMode 单一状态推导。 */
  teamEngineActive?: boolean;
}) {
  const selected = models.find((m) => m.id === selectedId);
  // 已选模型被降级(且非团队模式覆盖态)→ 菜单顶部提示条建议换模;可用替代 = 下方未降级模型。
  const selectedDegraded = selected ? isDegraded(selected) : false;
  const hasAlternatives = models.some(
    (m) => !isDegraded(m) && m.id !== selectedId,
  );
  const engineLabel = teamEngineLabel(models);
  // 团队态标签拆前缀/主体:移动端只显引擎名(前缀与头部 chip 冗余,Users 图标已表意),
  // sm+ 恢复"团队模式 · "全称。
  const baseLabel = selected
    ? modelLabel(selected)
    : loading
      ? "加载模型…"
      : models[0]
        ? modelLabel(models[0])
        : "暂无可用模型";
  const label = teamEngineActive ? engineLabel : baseLabel;
  const disabled = loading || models.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-product-feature={PRODUCT_CAPABILITIES.models.id}
          disabled={disabled}
          aria-label="选择对话模型"
          className={cn(
            "flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[13.5px] font-medium text-muted outline-none transition-colors",
            "hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]",
            "disabled:pointer-events-none disabled:opacity-50",
            teamEngineActive && "text-accent hover:text-accent",
          )}
        >
          {teamEngineActive ? (
            <Users size={14} className="text-accent" />
          ) : (
            <Cpu size={14} className="text-faint" />
          )}
          {teamEngineActive && (
            <span className="hidden sm:inline">{"团队模式 · "}</span>
          )}
          <span className="max-w-[6.5rem] truncate sm:max-w-[180px]">
            {label}
          </span>
          <ChevronDown size={14} className="text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        data-product-feature={PRODUCT_CAPABILITIES.models.id}
        className="min-w-[15rem]"
      >
        <DropdownMenuLabel>对话模型</DropdownMenuLabel>
        {teamEngineActive && (
          <div
            role="note"
            className="mx-1 mb-1 rounded-md bg-accent-soft px-2.5 py-2 text-xs leading-relaxed"
          >
            <span className="flex items-center gap-1.5 font-medium text-accent">
              <Users size={12} className="shrink-0" /> 团队模式 · 队长引擎{" "}
              {engineLabel}
            </span>
            <span className="mt-0.5 block text-muted">
              当前会话按 {engineLabel}{" "}
              执行与计费；下方自选模型将在团队模式关闭后生效。
            </span>
          </div>
        )}
        {selectedDegraded && !teamEngineActive && (
          <div
            role="note"
            className="mx-1 mb-1 rounded-md bg-danger-soft px-2.5 py-2 text-xs leading-relaxed"
          >
            <span className="flex items-center gap-1.5 font-medium text-danger">
              <AlertTriangle size={12} className="shrink-0" /> 当前模型暂不可用
            </span>
            <span className="mt-0.5 block text-muted">
              {hasAlternatives
                ? "该服务商暂时降级,建议改用下方可用模型。"
                : "该服务商暂时降级,暂无同类可用模型,请稍后重试。"}
            </span>
          </div>
        )}
        {models.map((m) => {
          const active = m.id === selectedId;
          const degraded = isDegraded(m);
          return (
            <DropdownMenuItem
              key={m.id}
              data-model-id={m.id}
              disabled={degraded}
              onSelect={degraded ? undefined : () => onSelect(m.id)}
              className="justify-between"
            >
              <span className="truncate">{modelLabel(m)}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {degraded && <Badge tone="danger">暂不可用</Badge>}
                {active && !degraded && (
                  <>
                    {teamEngineActive && (
                      <span className="text-[11px] text-faint">
                        团队模式关闭后生效
                      </span>
                    )}
                    <Check size={14} className="shrink-0 text-accent" />
                  </>
                )}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 思考档位选择器(聊天头,与 ModelSelector 并排)。
 *
 * - 数据驱动:选项 = 当前执行模型的 supported_efforts ∩ EFFORT_OPTIONS(平台 5 档
 *   全集);空集(该模型不暴露任何档)→ 调用方不渲染本组件。
 * - 选择状态由 App 顶层持有(per-session 显式选择,null = 跟随模型默认);「当前生效
 *   档」的解析(显式选择 ?? 全局偏好,并按模型支持集过滤)也在 App 侧完成,本组件
 *   只展示 + 上抛,不持第二份状态。
 * - effortLevel 是 inbound.message 顶层路由字段:每条消息携带,档位变化在下一条
 *   消息生效(引擎侧切换 = 重建 runner env,由后端处理)。
 */
export function EffortSelector({
  supportedEfforts,
  activeEffort,
  onSelect,
  disabled,
}: {
  /** 当前执行模型 API 投影的 supported_efforts(空数组由调用方过滤,不渲染本组件)。 */
  supportedEfforts: readonly string[];
  /** 当前生效档:null/undefined = 跟随模型默认(该项打勾);否则对应档位打勾。 */
  activeEffort?: PreferenceEffort | null;
  onSelect: (value: PreferenceEffort | null) => void;
  disabled?: boolean;
}) {
  const options = EFFORT_OPTIONS.filter((o) => supportedEfforts.includes(o.value));
  const followActive = activeEffort == null;
  const label = followActive
    ? "思考 · 跟随"
    : `思考 · ${EFFORT_OPTIONS.find((o) => o.value === activeEffort)?.label ?? activeEffort}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-product-control
          disabled={disabled}
          aria-label="选择思考档位"
          title="思考档位:控制模型回答前的思考深度"
          className={cn(
            "flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[13.5px] font-medium text-muted outline-none transition-colors",
            "hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <Zap size={14} className="text-faint" />
          <span className="max-w-[6rem] truncate sm:max-w-none">{label}</span>
          <ChevronDown size={14} className="text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        <DropdownMenuLabel>思考档位</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onSelect(null)} className="justify-between">
          <span>跟随模型默认</span>
          {followActive && <Check size={14} className="shrink-0 text-accent" />}
        </DropdownMenuItem>
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            data-effort={o.value}
            onSelect={() => onSelect(o.value)}
            className="justify-between"
          >
            <span>{o.label}</span>
            {activeEffort === o.value && <Check size={14} className="shrink-0 text-accent" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
