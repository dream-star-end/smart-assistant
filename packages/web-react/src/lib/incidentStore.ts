/**
 * 自愈事故前端 store（切片①）——渲染树之外的模块级单例，消费 `sys.incident` 帧驱动
 * 用户端异常横幅 + 恢复通知。socket.ts 收到帧即 `ingest`；App 经 `useActiveIncidents`
 * 订阅当前活跃事故渲染横幅，经 `onResolved` 订阅一次性恢复事件弹 toast。
 *
 * ── rev 幂等（唯一权威不变量）─────────────────────────────────────────────
 * 按 `incidentId` 记住**见过的最高 rev**；到达帧 `rev <= 已记录` 一律丢弃。
 * 这根治重连乱序 / at-least-once 重投：迟到的低 rev `open` 帧不会把一个已 `resolved`
 * 的事故重新挂回横幅（RFC §5 [解 M4]）。最高 rev 记录跨 open/resolved 共用，故
 * “open(rev=3) → resolved(rev=4) → 迟到 open(rev=3)” 中最后那帧被 rev 守卫直接吃掉。
 *
 * ── resolved 事件（一次性副作用）──────────────────────────────────────────
 * 恢复是 fire-and-forget 的 toast，不是持久渲染态，故走命令式 pub/sub 而非 render state。
 * **只对本会话内确实活跃过的事故**发恢复事件（`wasActive`）——避免用户刚连上就收到一条
 * 自己从没见过“异常”的事故的“已恢复”提示（噪声）。消费者晚挂载时用缓冲冲刷，不丢事件。
 *
 * getSnapshot 引用稳定：仅在活跃集合真正变化时重建快照数组，useSyncExternalStore 不空转。
 */
import { useSyncExternalStore } from "react";
import type { IncidentWire } from "./chat/frames";

export type IncidentSeverity = "info" | "warning" | "critical";

/** 当前活跃（open/updated）事故的渲染投影。 */
export type ActiveIncident = {
  incidentId: string;
  rev: number;
  severity: IncidentSeverity;
  surface: string;
  title: string;
  message: string;
  ts: number;
};

/** 一次性恢复事件（供 toast）。title/message 为服务端恢复态文案。 */
export type ResolvedIncident = {
  incidentId: string;
  surface: string;
  title: string;
  message: string;
  ts: number;
};

/** severity 渲染排序权重（critical 最靠前）。 */
const SEVERITY_RANK: Record<IncidentSeverity, number> = { critical: 0, warning: 1, info: 2 };

const EMPTY: ReadonlyArray<ActiveIncident> = [];

class IncidentStore {
  /** incidentId → 见过的最高 rev（跨 open/resolved 共用，rev 幂等的权威）。 */
  private highestRev = new Map<string, number>();
  /** incidentId → 当前活跃事故。 */
  private active = new Map<string, ActiveIncident>();
  /** getSnapshot 稳定引用缓存；仅活跃集合变化时重建。 */
  private snapshot: ReadonlyArray<ActiveIncident> = EMPTY;
  private listeners = new Set<() => void>();
  private resolvedListeners = new Set<(e: ResolvedIncident) => void>();
  /** 无消费者时暂存恢复事件，首个 onResolved 订阅时冲刷（晚挂载不丢）。 */
  private resolvedBuffer: ResolvedIncident[] = [];

  /** 消费一帧 sys.incident。非法帧 / 旧 rev 一律 no-op。 */
  ingest(frame: IncidentWire): void {
    if (!frame || typeof frame.incidentId !== "string" || typeof frame.rev !== "number") return;
    const id = frame.incidentId;
    const prev = this.highestRev.get(id);
    if (prev !== undefined && frame.rev <= prev) return; // 旧 / 重复 rev → 丢弃
    this.highestRev.set(id, frame.rev);

    if (frame.status === "resolved") {
      const wasActive = this.active.delete(id);
      if (wasActive) {
        this.rebuild();
        this.emitResolved({
          incidentId: id,
          surface: frame.surface,
          title: frame.title,
          message: frame.message,
          ts: frame.ts,
        });
      }
      return;
    }

    // open / updated：写入或就地更新（severity/message 可随 rev 升级，如 warning→critical）。
    this.active.set(id, {
      incidentId: id,
      rev: frame.rev,
      severity: frame.severity,
      surface: frame.surface,
      title: frame.title,
      message: frame.message,
      ts: frame.ts,
    });
    this.rebuild();
  }

  // ── useSyncExternalStore 接口（活跃事故列表）──
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ReadonlyArray<ActiveIncident> => this.snapshot;

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
    this.highestRev.clear();
    this.active.clear();
    this.snapshot = EMPTY;
    this.resolvedBuffer = [];
    this.resolvedListeners.clear();
    for (const fn of this.listeners) fn();
  }

  private rebuild(): void {
    const list = [...this.active.values()].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.ts - b.ts,
    );
    this.snapshot = list.length === 0 ? EMPTY : list;
    for (const fn of this.listeners) fn();
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

/** 订阅当前活跃事故列表（横幅渲染用）。 */
export function useActiveIncidents(): ReadonlyArray<ActiveIncident> {
  return useSyncExternalStore(
    incidentStore.subscribe,
    incidentStore.getSnapshot,
    incidentStore.getSnapshot,
  );
}
