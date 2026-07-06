/**
 * P2 债C/3.5 — 委派资源闸 per-parent 分桶 + 硬编排 review 保留槽的行为测试。
 *
 * 直接驱动真实的 _checkDelegateResourceGate / _tryReserveDelegateSlot /
 * _releaseDelegateSlot(Object.create(Gateway.prototype) 脚手架,沿用
 * delegateResourceQueue.test.ts 先例),断言:
 *   - 保留槽:非 review 委派最多用到 (MAX − 保留槽);review 委派可用满 MAX;
 *   - per-parent 桶:单父非 review 委派达上限即 concurrency 拦;review 豁免该桶;
 *   - reserve/release 对 _activeDelegations 与 per-parent 运行计数严格对称。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegatePerParentGate.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Gateway } from '../server.js'

// MAX_CONCURRENT_DELEGATIONS=5, DELEGATE_REVIEW_RESERVED_SLOTS=1(私有 static,常量在 server.ts)。
// 非 review 全局上限 = 5 − 1 = 4;review 全局上限 = 5。per-parent 默认 3(env 可配)。
const NONREVIEW_GLOBAL_CAP = 4
const GLOBAL_CAP = 5
const PER_PARENT_CAP = 3

function makeGate(): any {
  const gw = Object.create(Gateway.prototype) as any
  gw._activeDelegations = 0
  gw._runningDelegationsByParent = new Map()
  // 关掉内存水位分支(测试只关心并发/分桶闸)。
  gw._readDelegateMemoryPressure = () => null
  return gw
}

describe('delegate 资源闸 — review 保留槽(全局)', () => {
  it('非 review 委派在 (MAX−保留槽) 处被拦,review 委派此时仍可过', () => {
    const gw = makeGate()
    gw._activeDelegations = NONREVIEW_GLOBAL_CAP // = 4
    assert.deepEqual(
      gw._checkDelegateResourceGate({ isReview: false }),
      { kind: 'concurrency' },
      '非 review 到 4 就该被拦(给 review 留第 5 槽)',
    )
    assert.equal(
      gw._checkDelegateResourceGate({ isReview: true }),
      null,
      'review 委派此时应能拿到保留槽',
    )
  })

  it('review 委派在 MAX 处也被拦', () => {
    const gw = makeGate()
    gw._activeDelegations = GLOBAL_CAP // = 5
    assert.deepEqual(gw._checkDelegateResourceGate({ isReview: true }), { kind: 'concurrency' })
  })
})

describe('delegate 资源闸 — per-parent 分桶', () => {
  it('单父非 review 达 per-parent 上限即被拦;review 豁免;他父不受影响', () => {
    const gw = makeGate()
    gw._activeDelegations = PER_PARENT_CAP // 3,未达非 review 全局 4
    gw._runningDelegationsByParent = new Map([['p1', PER_PARENT_CAP]])
    assert.deepEqual(
      gw._checkDelegateResourceGate({ parentBucketKey: 'p1', isReview: false }),
      { kind: 'concurrency' },
      'p1 已跑满 per-parent 上限 → 拦',
    )
    assert.equal(
      gw._checkDelegateResourceGate({ parentBucketKey: 'p1', isReview: true }),
      null,
      'review 豁免 per-parent 桶',
    )
    assert.equal(
      gw._checkDelegateResourceGate({ parentBucketKey: 'p2', isReview: false }),
      null,
      '他父 p2 桶为空,不受 p1 影响',
    )
  })

  it('无 parentBucketKey(cron/webhook 父)只受全局闸,不分桶', () => {
    const gw = makeGate()
    gw._activeDelegations = 1
    gw._runningDelegationsByParent = new Map([['p1', 99]])
    assert.equal(gw._checkDelegateResourceGate({ isReview: false }), null)
  })
})

describe('delegate 资源闸 — reserve/release 对称', () => {
  it('非 review reserve 同步 bump 全局 + per-parent;release 精确回退', () => {
    const gw = makeGate()
    const opts = { parentBucketKey: 'p1', isReview: false }
    assert.equal(gw._tryReserveDelegateSlot(opts), null)
    assert.equal(gw._activeDelegations, 1)
    assert.equal(gw._runningDelegationsByParent.get('p1'), 1)
    assert.equal(gw._tryReserveDelegateSlot(opts), null)
    assert.equal(gw._runningDelegationsByParent.get('p1'), 2)
    gw._releaseDelegateSlot(opts)
    assert.equal(gw._activeDelegations, 1)
    assert.equal(gw._runningDelegationsByParent.get('p1'), 1)
    gw._releaseDelegateSlot(opts)
    assert.equal(gw._activeDelegations, 0)
    assert.equal(gw._runningDelegationsByParent.has('p1'), false, '归零后应删键防泄漏')
  })

  it('review reserve 占全局槽但不进 per-parent 桶', () => {
    const gw = makeGate()
    const opts = { parentBucketKey: 'p1', isReview: true }
    assert.equal(gw._tryReserveDelegateSlot(opts), null)
    assert.equal(gw._activeDelegations, 1)
    assert.equal(gw._runningDelegationsByParent.has('p1'), false, 'review 不占 per-parent 桶')
    gw._releaseDelegateSlot(opts)
    assert.equal(gw._activeDelegations, 0)
  })
})
