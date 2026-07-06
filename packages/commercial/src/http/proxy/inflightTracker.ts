/**
 * per-model 在飞请求计量(0106,admin「模型与服务商」运维页容量数据源)。
 *
 * 进程内存快照:v5 拓扑下容器 /v1/messages 由 egress 进程独占,egress 的计数即全量;
 * master 同模块常年 ~0(admin 经 GET /internal/v5/egress-stats 取 egress 快照,
 * 不可达时 fail-soft 回落本进程快照并标注 source)。
 *
 * - current:res 'close' 单次递减 —— 正常完结/断流/超时都触发,无泄漏面;
 * - peak:自进程启动累计(egress 重启归零,UI 已标注口径),给扩容看"到过多高"。
 * 不落 DB、不进 Prometheus(scrape 周期抓不住秒级并发尖峰;这里是实时快照语义)。
 */

const current = new Map<string, number>();
const peaks = new Map<string, { count: number; at: string }>();
const startedAt = new Date().toISOString();

export function trackModelRequestStart(model: string): void {
  const next = (current.get(model) ?? 0) + 1;
  current.set(model, next);
  const p = peaks.get(model);
  if (!p || next > p.count) peaks.set(model, { count: next, at: new Date().toISOString() });
}

export function trackModelRequestEnd(model: string): void {
  const cur = current.get(model) ?? 0;
  if (cur <= 1) {
    current.delete(model);
  } else {
    current.set(model, cur - 1);
  }
}

export interface InflightSnapshot {
  started_at: string;
  total_current: number;
  by_model: Record<string, { current: number; peak: number; peak_at: string }>;
}

export function snapshotInflight(): InflightSnapshot {
  const byModel: InflightSnapshot["by_model"] = {};
  const models = new Set([...current.keys(), ...peaks.keys()]);
  let total = 0;
  for (const m of models) {
    const cur = current.get(m) ?? 0;
    const p = peaks.get(m);
    byModel[m] = { current: cur, peak: p?.count ?? cur, peak_at: p?.at ?? startedAt };
    total += cur;
  }
  return { started_at: startedAt, total_current: total, by_model: byModel };
}

/** 仅测试用:清空计量状态(模块单例,测试间隔离)。 */
export function _resetInflightForTests(): void {
  current.clear();
  peaks.clear();
}
