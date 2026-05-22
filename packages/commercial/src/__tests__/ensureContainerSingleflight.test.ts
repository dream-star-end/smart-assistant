/**
 * agent-sandbox/ensureContainerSingleflight.ts 单测。
 *
 * 覆盖的关键不变量(/api/media-signed 冷启动护栏的安全前提):
 *   1) 同 uid 并发 → 共享同一 underlying call,在 settle 前不重复触发
 *   2) 同 uid 顺序(前一个 settle 后再调)→ 触发 underlying call 第 2 次
 *   3) 不同 uid 并发 → 各自独立触发 underlying call
 *   4) underlying reject → 所有 in-flight waiter 拿到同一个错误;之后重试
 *      重新触发 underlying call
 *   5) settle 后 inflight map 自动清空(无 memory leak)
 *
 * 这条单测的存在动机:防止有人改 singleflight 实现时打破并发合并语义。
 * 历史问题:用户 reload 页面 → <img> 并发 → 裸 ensureRunning DB INSERT race
 * → 输家被翻 ContainerUnreadyError("provisioning") → 用户看 broken image。
 * 这个 wrapper 是 v1.0.191 PDF 下载 P1 fix 的关键部分,语义出错 = 回到事故现场。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { makeUidSingleflight } from '../agent-sandbox/ensureContainerSingleflight.js'

function defer<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('makeUidSingleflight', () => {
  test('同 uid 并发:underlying 只被调一次,所有 waiter 拿同一结果', async () => {
    let calls = 0
    const d = defer<{ ok: true }>()
    const underlying = async (uid: bigint): Promise<{ ok: true }> => {
      calls += 1
      // 借 uid 不丢的 sanity check
      assert.equal(uid, 7n)
      return d.promise
    }
    const sf = makeUidSingleflight(underlying)

    const p1 = sf(7n)
    const p2 = sf(7n)
    const p3 = sf(7n)

    assert.equal(calls, 1, '并发只触发 1 次 underlying')
    d.resolve({ ok: true })

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    assert.deepEqual(r1, { ok: true })
    assert.equal(r1, r2, 'waiter 必须拿同一对象')
    assert.equal(r2, r3)
    assert.equal(calls, 1)
  })

  test('同 uid 顺序:第一个 settle 后第二次调触发新 underlying', async () => {
    let calls = 0
    const underlying = async (_uid: bigint): Promise<number> => {
      calls += 1
      return calls
    }
    const sf = makeUidSingleflight(underlying)

    const r1 = await sf(11n)
    const r2 = await sf(11n)
    assert.equal(r1, 1)
    assert.equal(r2, 2, 'settle 后 unwrap,重试应触发新 underlying')
    assert.equal(calls, 2)
  })

  test('不同 uid 并发:各自独立,calls = 唯一 uid 数', async () => {
    let calls = 0
    const seenUids: bigint[] = []
    const underlying = async (uid: bigint): Promise<void> => {
      calls += 1
      seenUids.push(uid)
      // 让所有调用都 microtask defer 一下,确认并发不串扰
      await new Promise<void>((r) => setImmediate(r))
    }
    const sf = makeUidSingleflight(underlying)

    await Promise.all([sf(1n), sf(2n), sf(3n), sf(1n), sf(2n)])
    assert.equal(calls, 3, '3 个唯一 uid → 3 次 underlying call')
    assert.deepEqual([...seenUids].sort(), [1n, 2n, 3n])
  })

  test('underlying reject:所有 in-flight waiter 拿同一错误,之后重试重新触发', async () => {
    let calls = 0
    const d = defer<void>()
    const underlying = async (_uid: bigint): Promise<void> => {
      calls += 1
      if (calls === 1) {
        return d.promise // 第一次 reject
      }
      return // 第二次 success
    }
    const sf = makeUidSingleflight(underlying)

    const p1 = sf(42n)
    const p2 = sf(42n)
    assert.equal(calls, 1)

    const boom = new Error('provisioning')
    d.reject(boom)

    const got1 = await p1.then(
      () => null,
      (e) => e,
    )
    const got2 = await p2.then(
      () => null,
      (e) => e,
    )
    assert.equal(got1, boom, 'waiter 1 必须拿同一 error 对象')
    assert.equal(got2, boom, 'waiter 2 必须拿同一 error 对象')

    // 等 finally microtask 跑完,确保 inflight map 已清
    await new Promise<void>((r) => setImmediate(r))

    // 重试应触发新 underlying call(第二次,success)
    await sf(42n)
    assert.equal(calls, 2, 'reject settle 后 unwrap,重试应触发新 underlying')
  })

  test('settle 后 inflight map 自动清空(无 memory leak)', async () => {
    // 间接验证:跑 100 个不同 uid → 都 settle → 第 101 个调用仍能正常触发
    // (如果 map 累积不清,内部 Map 会无限长,虽然不会语义出错,但每次调用都
    // 在 map 里翻 100 项;这条主要是 sanity)
    let calls = 0
    const underlying = async (_uid: bigint): Promise<void> => {
      calls += 1
    }
    const sf = makeUidSingleflight(underlying)

    for (let i = 0n; i < 100n; i += 1n) {
      await sf(i)
    }
    // 让所有 finally 跑完
    await new Promise<void>((r) => setImmediate(r))

    // 再调 uid=50n,应该触发新 call(map 已清,不会复用旧 settled Promise)
    await sf(50n)
    assert.equal(calls, 101)
  })
})
