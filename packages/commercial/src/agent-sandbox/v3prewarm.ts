/**
 * 邮箱验证成功 → fire-and-forget 触发 v3 容器 pre-warm,降首消冷启延迟。
 *
 * 背景:`makeV3EnsureRunning(uid)` 同步等 docker run + healthz/WS readiness
 * (self 10s / remote 25s 上限,实测 5-8s)。若由用户首条 WS 消息触发,延迟
 * 全摊在体感上。改在 `POST /api/auth/verify-email` 成功时异步起容器,p50
 * 215s 的"验证 → 首消息"间隔足够覆盖冷启,首条消息直接命中 running。
 *
 * 抽到单独 helper 而非 inline 在 index.ts 装配处的原因:
 *   - 可独立单测 "async rejection 必须被 `.catch` 接住" 的关键不变量,
 *     不必构造完整 commercial gateway。
 *   - handler 层(handlers.ts:handleVerifyEmail)只看到 `(uid: bigint) => void`
 *     接口,与 v3 supervisor 解耦。v3Deps 未配时整个能力直接 undefined。
 */

import type { Logger } from "../logging/logger.js";

/**
 * 把 async `ensureRunning(uid)` 包成 fire-and-forget 调用器。
 *
 * **关键不变量**:async rejection 必须用 `.catch` 显式接住 —— 外层同步
 * try/catch 接不住 promise rejection(rejection 是异步事件)。漏接会触发
 * unhandledRejection,在 strict process 下 crash gateway。
 *
 * 返回的函数同步 return void,**绝不抛**(任何错误转日志吞掉),保证调用方
 * `prewarmContainer(uid)` 不需要 try/catch 包裹。
 */
export function makePrewarmContainer(
  ensureRunning: (uid: bigint) => Promise<unknown>,
  log: Pick<Logger, "warn">,
  recordFailure?: (input: { userId: bigint; correlation: string; latencyMs: number }) => void,
): (uid: bigint) => void {
  return function prewarm(uid: bigint): void {
    const startedAt = Date.now();
    const correlation = `${uid.toString()}:${startedAt}`;
    void ensureRunning(uid).catch((err: unknown) => {
      recordFailure?.({
        userId: uid,
        correlation,
        latencyMs: Date.now() - startedAt,
      });
      log.warn("prewarm failed", {
        uid: uid.toString(),
        errorClass: err instanceof Error ? err.name : typeof err,
      });
    });
  };
}
