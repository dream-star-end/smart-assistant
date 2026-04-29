/**
 * Per-host 5min 滑动窗口请求计数器 — 进程内,**不**持久化。
 *
 * 用途:admin UI hosts table 的 "5min req" 列。给 boss 一个直观的"哪台机
 * 现在最忙"信号,不上 prom-client(那是给运维 dashboard 的另一条线)。
 *
 * **语义**:仅统计 anthropicProxy 上行 `/v1/messages` 请求 — 即用户容器内
 * OpenClaude 发往 Anthropic 的 LLM 调用,在 master 经身份双因子鉴别后命中
 * `recordHostRequest(ctx.hostUuid)`。WebSocket bridge / health probe / 后台
 * 任务**不**计入 — 它们不算"用户请求",会污染流量图。
 *
 * 实现:
 *   - `Map<hostUuid, number[]>` 存最近请求时间戳(ms)
 *   - 写时 push;数组膨胀到 1000 时立即 lazy-prune 防长流量 host 失控
 *   - 读时先 prune 再返 length(精确到毫秒)
 *   - 60s setInterval GC 兜底:扫所有 host,删空数组释放 map slot
 *
 * 复杂度:
 *   - record:O(1) 摊销(prune 触发时 O(n) 但摊销到每次 push 仍 O(1))
 *   - get:O(prune-cost) ≈ O(老元素数)
 *
 * 不做:
 *   - 跨进程聚合(master 单进程,这是事实;若以后 cluster 化才需要 redis)
 *   - 持久化历史(boss 看的是"现在",历史走 prom + grafana)
 *   - 平滑/EMA(boss 要的是 raw count,过滤会撒谎)
 */

const WINDOW_MS = 5 * 60 * 1000;
const PRUNE_THRESHOLD = 1000;
const GC_INTERVAL_MS = 60 * 1000;

const counts = new Map<string, number[]>();

/**
 * 记录一次请求。hook 点:`anthropicProxy.handle` 在 verifyContainerIdentity
 * 成功之后立即调用 — 此时 ctx.hostUuid 已 trusted(self/mTLS 双轨过)。
 */
export function recordHostRequest(hostUuid: string, nowMs: number = Date.now()): void {
  let arr = counts.get(hostUuid);
  if (!arr) {
    arr = [];
    counts.set(hostUuid, arr);
  }
  arr.push(nowMs);
  if (arr.length > PRUNE_THRESHOLD) prune(arr, nowMs);
}

/**
 * 当前 5min 窗口内 hostUuid 的请求数。
 */
export function getHostReqCount5m(hostUuid: string, nowMs: number = Date.now()): number {
  const arr = counts.get(hostUuid);
  if (!arr) return 0;
  prune(arr, nowMs);
  return arr.length;
}

/**
 * 全量快照,主要给测试用。
 */
export function _snapshotAll(nowMs: number = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, arr] of counts) {
    prune(arr, nowMs);
    out.set(k, arr.length);
  }
  return out;
}

/**
 * 仅测试用 — 重置全局状态。
 */
export function _resetForTests(): void {
  counts.clear();
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}

function prune(arr: number[], nowMs: number): void {
  const cutoff = nowMs - WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i]! < cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

// ─── GC 后台 tick:删空数组防止 map 无限增长 ──────────────────────
//
// 写在模块加载即启动 — 与 hook 点的生命周期一致(master 进程级)。
// .unref() 让定时器不阻塞 process.exit。

let gcTimer: NodeJS.Timeout | null = null;

function startGcTick(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of counts) {
      prune(arr, now);
      if (arr.length === 0) counts.delete(k);
    }
  }, GC_INTERVAL_MS);
  if (typeof gcTimer.unref === "function") gcTimer.unref();
}

// 测试环境(NODE_ENV=test)不自启,避免进程残留。生产/dev 默认起。
if (process.env.NODE_ENV !== "test") {
  startGcTick();
}
