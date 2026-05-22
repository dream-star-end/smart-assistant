/**
 * v1.0.191 — per-uid singleflight wrapper for `ensureContainerReady`。
 *
 * 背景:`/api/media-signed` 在用户 reload 页面时被并发拉(5~20 张 <img>)。
 * 裸 `makeV3EnsureRunning` 在并发场景下走 DB INSERT race + provision 路径,
 * 只有 1 个赢家走 provision,输家被翻成 `ContainerUnreadyError("provisioning")` 仍 503。
 *
 * 本 wrapper 合并同 uid 的 in-flight Promise:所有 caller 共享同一个底层 ensure 调用,
 * 要么一起成功要么一起拿到同一个 ContainerUnreadyError。settle 后立刻 unwrap,
 * 后续重试不复用旧结果。
 *
 * 作用域(round-3 修订):**默认装配下 HTTP `/api/media-signed` 与 WS bridge
 * `resolveContainerEndpoint` 共享同一个 wrapper 的 in-flight map**。原因:用户
 * reload 页面瞬间,WS connect 与 <img> burst 是同 process 内的并发拉,若各自闭包
 * → makeV3EnsureRunning 的 DB INSERT race(只一个赢家做 provision)会让另一路
 * 成为输家被翻 ContainerUnreadyError("provisioning")。装配代码见 commercial/src/index.ts
 * `sharedEnsureRunning` 闭包。
 *
 * prewarm 路径保留独立闭包(发生在邮箱验证那一刻,与 reload 不同步)。
 */
export function makeUidSingleflight<R>(
  underlying: (uid: bigint) => Promise<R>,
): (uid: bigint) => Promise<R> {
  const inflight = new Map<string, Promise<R>>()
  return (uid: bigint): Promise<R> => {
    const key = String(uid)
    const existing = inflight.get(key)
    if (existing) return existing
    const p = underlying(uid)
    inflight.set(key, p)
    // settle 后清除(成功或失败),让下次重试重新触发。
    // identity check(`inflight.get(key) === p`):理论上 settle 与 set 都是单线程串行
    // microtask,新 Promise 不会在 settle 前就 set 进同 key,但保险起见只删自己。
    p.finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    }).catch(() => {})
    return p
  }
}
