/**
 * 自动重试说实话(W3 FE-errors)。master 的自动恢复把真实进度放在 `retryStatus` 里
 * (`sys.recovery_decision`、自动恢复的 `outbound.ack`、`sys.recovery_status`、时间线
 * automaticRecoveries 快照)。这里按 rootClientMessageId 归并成会话上的一条状态,渲染层读它显示
 * 「正在自动重试（n/N）」。
 *
 * N 只认服务端给的实际上限。旧路径里的 `_turnStatus.max` 是兼容常量 10,不是这一轮的上限,
 * 这里从不拿它显示。没有服务端进度时不写次数(OCV5-523:各重试层不再各自计数),只说「正在自动重试…」。
 *
 * 实时帧(决定、ack、recovery_status)由 socket.ts 分发;本模块只提供入口函数,接线见
 * CONTINUE-20261029-rf-fe-errors「对外契约」。
 */
import {
  automaticRetryStatus,
  type AutomaticRetryStatus,
} from "@openclaude/protocol/browser";
import type { RecoveryStatusWire } from "./frames";
import { STATUS } from "../ui/statusTone";
import { isRetryingTurnStatus, type ChatSession, type TurnStatusState } from "./model";

export type SessionRetryStatus = NonNullable<ChatSession["_automaticRetryStatus"]>;

const STATES = new Set<AutomaticRetryStatus["state"]>(["scheduled", "running", "paused", "exhausted", "declined"]);

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 只认协议里的五种状态。服务端文案优先;缺文案的旧回包按同一个协议函数补。 */
export function readRetryStatus(value: unknown): AutomaticRetryStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<AutomaticRetryStatus>;
  if (!v.state || !STATES.has(v.state)) return undefined;
  const local = automaticRetryStatus(v.state, count(v.attempt), count(v.maxAttempts));
  return typeof v.message === "string" && v.message.trim() ? { ...local, message: v.message } : local;
}

function lineageRoot(sess: ChatSession, clientMessageId: string | undefined): string | undefined {
  if (!clientMessageId) return undefined;
  const user = sess.messages.find((m) => m.role === "user" && m.id === clientMessageId);
  return user?._automaticRecoveryRootClientMessageId || user?._recoveryOfClientMessageId || clientMessageId;
}

/**
 * 记下一条重试状态。同一根消息只留最新的一条;重放或乱序到达的旧状态(时间更早,或次数更小)
 * 不会把已经显示的进度往回拨。
 */
export function rememberRetryStatus(
  sess: ChatSession,
  ids: { rootClientMessageId?: string; sourceClientMessageId?: string; clientMessageId?: string },
  value: unknown,
  ts: number = Date.now(),
): boolean {
  const status = readRetryStatus(value);
  const root = ids.rootClientMessageId || lineageRoot(sess, ids.sourceClientMessageId ?? ids.clientMessageId);
  if (!status || !root) return false;
  const prev = sess._automaticRetryStatus;
  if (prev && prev.rootClientMessageId === root) {
    if (prev.ts > ts) return false;
    if ((prev.status.attempt ?? 0) > (status.attempt ?? 0) && status.state !== "exhausted" && status.state !== "paused") {
      return false;
    }
  }
  sess._automaticRetryStatus = {
    rootClientMessageId: root,
    ...(ids.sourceClientMessageId ? { sourceClientMessageId: ids.sourceClientMessageId } : {}),
    ...(ids.clientMessageId ? { clientMessageId: ids.clientMessageId } : {}),
    status,
    ts,
  };
  return true;
}

/** `sys.recovery_status`:master 把恢复子轮交给容器后广播的「正在重试」。 */
export function applyRecoveryStatusFrame(sess: ChatSession, frame: RecoveryStatusWire): boolean {
  return rememberRetryStatus(sess, {
    rootClientMessageId: frame.rootClientMessageId,
    sourceClientMessageId: frame.sourceClientMessageId,
    clientMessageId: frame.clientMessageId,
  }, frame.retryStatus, typeof frame.ts === "number" ? frame.ts : Date.now());
}

function belongsToActiveTurn(sess: ChatSession, retry: SessionRetryStatus): boolean {
  const active = sess._activeClientMessageId ?? sess._deferredTerminalErrorClientMessageId;
  if (!active) return false;
  if (active === retry.clientMessageId || active === retry.sourceClientMessageId) return true;
  return lineageRoot(sess, active) === retry.rootClientMessageId;
}

/** 当前回合的阶段状态;正在自动重试时附上这一轮的真实进度(只有属于当前回合的才附)。 */
export function activeTurnStatus(sess: ChatSession): TurnStatusState | null {
  const status = sess._turnStatus ?? null;
  const retry = sess._automaticRetryStatus;
  if (!isRetryingTurnStatus(status) || !retry || !belongsToActiveTurn(sess, retry)) return status;
  return { ...status, retryStatus: retry.status };
}

/** 重试行的文案。服务端给了进行中的状态就用它(「正在自动重试（n/N）」);否则不写次数。 */
export function retryActivityLabel(turnStatus: { retryStatus?: AutomaticRetryStatus }): string {
  const status = turnStatus.retryStatus;
  if (status && (status.state === "scheduled" || status.state === "running")) return status.message;
  return `${STATUS.retrying.label}…`;
}
