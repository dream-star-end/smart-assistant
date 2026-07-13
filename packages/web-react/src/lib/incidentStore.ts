/**
 * 审批后恢复通知 store。
 *
 * 内部 incident 的 open/update/resolved 生命周期不再是用户 UI 信号。这里只接受
 * `status='resolved' + noticeKind='approved_recovery'`：该标记仅由 master 的
 * userNoticeApproval 在可信全自动修复、精确影响证据、企微审批和在线收件人门禁全部通过后
 * 发送。普通 incident 在写入幂等状态前即忽略，不能压掉后续合法通知。
 *
 * 合法通知按 incidentId 记录最高 rev；重复或更低 rev 一律丢弃。恢复提示是一次性 toast，
 * 因而使用命令式 pub/sub；消费者晚挂载时用缓冲冲刷，避免首屏初始化竞态丢通知。
 */
import type { IncidentWire } from "./chat/frames";

/** 一次性审批恢复事件（供 success toast）。 */
export type ResolvedIncident = {
  incidentId: string;
  surface: string;
  title: string;
  message: string;
  ts: number;
};

class IncidentStore {
  /** incidentId → 已展示审批恢复通知的最高 rev。 */
  private highestApprovedRev = new Map<string, number>();
  private resolvedListeners = new Set<(e: ResolvedIncident) => void>();
  /** 无消费者时暂存恢复事件，首个 onResolved 订阅时冲刷。 */
  private resolvedBuffer: ResolvedIncident[] = [];

  /** 消费一帧 sys.incident；非审批恢复、非法帧、旧 rev 一律 no-op。 */
  ingest(frame: IncidentWire): void {
    if (
      !frame || frame.status !== "resolved" || frame.noticeKind !== "approved_recovery" ||
      typeof frame.incidentId !== "string" || typeof frame.rev !== "number"
    ) return;

    const id = frame.incidentId;
    const prev = this.highestApprovedRev.get(id);
    if (prev !== undefined && frame.rev <= prev) return;
    this.highestApprovedRev.set(id, frame.rev);
    this.emitResolved({
      incidentId: id,
      surface: frame.surface,
      title: frame.title,
      message: frame.message,
      ts: frame.ts,
    });
  }

  /** 订阅一次性恢复事件；返回退订函数。首订阅冲刷缓冲。 */
  onResolved = (fn: (e: ResolvedIncident) => void): (() => void) => {
    this.resolvedListeners.add(fn);
    if (this.resolvedBuffer.length > 0) {
      const buffered = this.resolvedBuffer;
      this.resolvedBuffer = [];
      for (const e of buffered) fn(e);
    }
    return () => this.resolvedListeners.delete(fn);
  };

  /** 仅测试用：清空全部状态。 */
  _resetForTest(): void {
    this.highestApprovedRev.clear();
    this.resolvedBuffer = [];
    this.resolvedListeners.clear();
  }

  private emitResolved(e: ResolvedIncident): void {
    if (this.resolvedListeners.size === 0) {
      this.resolvedBuffer.push(e);
      return;
    }
    for (const fn of this.resolvedListeners) fn(e);
  }
}

export const incidentStore = new IncidentStore();
