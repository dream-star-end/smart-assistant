/**
 * 全站状态语义表(UI-SPEC §4.3)。
 *
 * UI 只管「长什么样」:同一个状态在侧栏、顶栏、过程行、右栏、插件状态里的文案、色调、图标
 * 都从这里取,不再各处各写一套。**什么时候切换状态**由状态源决定(FE-jitter 去抖、
 * FE-recovery 权威状态、CX5 重试 n/N);状态的数据结构变了,只改本文件的映射函数,不动组件。
 *
 * 色调只有五个,对应 styles.css 的 `--status-*` 别名(值目前指向既有语义 token)。
 * 组件只写别名(`bg-status-running` …),换视觉方向时改别名的值即可,调用方不动。
 */
import {
  Check,
  CircleAlert,
  CircleQuestionMark,
  Clock,
  Info,
  type LucideIcon,
  RefreshCw,
  Square,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type { SidebarDotKind } from "../sessionStatus";

/** 状态色调。running = 进行中 / 未读;attention = 需要处理;done = 完成的勾;failed = 失败;idle = 中性。 */
export type SemanticTone = "running" | "attention" | "done" | "failed" | "idle";

export type StatusKind =
  | "queued"
  | "running"
  | "background"
  | "needs_you"
  | "retrying"
  | "done"
  | "stopped"
  | "failed"
  | "disconnected"
  | "unread"
  | "service_restart";

export type StatusSpec = {
  /** 默认文案;带变量的写法见下方 *Label 函数。 */
  label: string;
  tone: SemanticTone;
  /** 点加文字形态里的图标;null = 用圆点。只有点的形态一律画点。 */
  icon: LucideIcon | null;
  /** 图标单独取色(「已完成」文字是中性的,勾用 done 色)。缺省同 tone。 */
  iconTone?: SemanticTone;
  /** 实心图标(「已停止」是实心圆角方块,不再是像未勾复选框的空心框)。 */
  filled?: boolean;
  /** 圆点呼吸(进行中)。减少动态效果时静止。 */
  breathe?: boolean;
};

export const STATUS: Record<StatusKind, StatusSpec> = {
  queued: { label: "待发送", tone: "idle", icon: Clock },
  running: { label: "运行中", tone: "running", icon: null, breathe: true },
  background: { label: "后台运行中", tone: "running", icon: null, breathe: true },
  needs_you: { label: "等你回答", tone: "attention", icon: CircleQuestionMark },
  retrying: { label: "正在自动重试", tone: "attention", icon: RefreshCw },
  done: { label: "完成", tone: "idle", icon: Check, iconTone: "done" },
  stopped: { label: "已停止", tone: "idle", icon: Square, filled: true },
  failed: { label: "没完成", tone: "failed", icon: TriangleAlert },
  disconnected: { label: "连接已断开，回合可能仍在后台运行", tone: "attention", icon: Unplug },
  unread: { label: "未读", tone: "running", icon: null },
  service_restart: { label: "服务重启中断，可继续", tone: "attention", icon: null },
};

/** 「正在写 Q4 汇报.pptx」;没有动作时退回「运行中」。 */
export function runningLabel(action?: string): string {
  const a = action?.trim();
  return a ? `正在${a}` : STATUS.running.label;
}

export function needsYouLabel(reason: "answer" | "approval"): string {
  return reason === "approval" ? "等你批准" : STATUS.needs_you.label;
}

/** 「正在自动重试（第 2 次，共 3 次）」;次数来自 CX5。 */
export function retryingLabel(attempt: number, total: number): string {
  return `${STATUS.retrying.label}（第 ${attempt} 次，共 ${total} 次）`;
}

/** 「完成 · 3 分 04 秒」。 */
export function doneLabel(duration?: string): string {
  return duration ? `${STATUS.done.label} · ${duration}` : STATUS.done.label;
}

/** 「没完成：模型服务暂时不可用」。原因由 FE-errors 的错误目录给,这里不翻译错误码。 */
export function failedLabel(reason?: string): string {
  return reason ? `${STATUS.failed.label}：${reason}` : STATUS.failed.label;
}

/** 侧栏行首点(sessionStatus.resolveSidebarDot 的判定结果)→ 语义状态。 */
export const SIDEBAR_DOT_STATUS: Record<Exclude<SidebarDotKind, "none">, StatusKind> = {
  running: "running",
  unread: "unread",
  error: "failed",
  service_restart: "service_restart",
};

/**
 * 时间线内提示(ui/Notice)的五种语气。图标和色调与上表同源:进行中 = 呼吸点、
 * 失败 = 三角叹号、已停止 = 实心方块;info / attention 是提示语气,不对应某个运行状态。
 */
export type NoticeTone = "info" | "progress" | "attention" | "failed" | "stopped";

export const NOTICE_TONES: Record<NoticeTone, Pick<StatusSpec, "tone" | "icon" | "filled" | "breathe">> = {
  info: { tone: "idle", icon: Info },
  progress: { tone: STATUS.running.tone, icon: STATUS.running.icon, breathe: true },
  attention: { tone: "attention", icon: CircleAlert },
  failed: { tone: STATUS.failed.tone, icon: STATUS.failed.icon },
  stopped: { tone: STATUS.stopped.tone, icon: STATUS.stopped.icon, filled: true },
};
