/**
 * 按角色的模型窗口分档策略(modelRolePolicy)单测。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/modelRolePolicy.test.ts
 *
 * 契约(改前先改测试):
 *   - 登记表命中 + role='user' → contextWindow 收窄到 min(机制窗口, 登记上限);
 *     admin → 机制窗口原样;未登记模型全角色原样;null(codex 行)原样透传。
 *   - `ModelCatalogSnapshot.listForUser` 是策略的投影落点:同一模型 admin/user 两个
 *     scope 看到不同 contextWindow,且 **projectionRevisionFor 因此按角色分叉**
 *     (master 下发与 egress 重算共用该方法 → 策略天然进对账哈希,双端一致;
 *     这条断言钉死"策略必须走 listForUser、不得旁路"的结构)。
 *   - snapshot.resolve() **不受影响**(机制描述符;角色投影发生在签发边界,见
 *     userChatBridge resolveAuthorityExecOrReject 尾部)。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  type ModelCatalogEntry,
  type ModelCatalogPricing,
  ModelCatalogSnapshot,
} from '../billing/modelCatalog.js'
import {
  NON_ADMIN_CONTEXT_WINDOW_LIMITS,
  projectContextWindowForRole,
} from '../billing/modelRolePolicy.js'

// ─── 纯函数契约 ──────────────────────────────────────────────────────────
//
// 结构 guard(勿删):projectContextWindowForRole 是列表轴与**执行轴**共用的唯一纯函数。
// 执行轴(userChatBridge 按 JWT 角色签发 descriptor.contextWindow)**从不进 409 对账**——
// 它的一致性没有对账兜底,唯一防线就是这个纯函数 + 两处落点单测(本文件 / modelAuthority
// Bridge.test.ts:431 bridge 签发)。删掉本 describe = 拆掉执行轴唯一防线的一半;新增任何按
// 角色投影模型窗口的消费方,必须同步扩这里的契约用例。
describe('projectContextWindowForRole — 纯函数契约', () => {
  test('kimi-k3:admin 1M 原样,user 收窄 500k(512000)', () => {
    assert.equal(projectContextWindowForRole('kimi-k3', 1_048_576, 'admin'), 1_048_576)
    assert.equal(projectContextWindowForRole('kimi-k3', 1_048_576, 'user'), 512_000)
  })
  test('登记上限只收窄不放大:机制窗口 < 上限 → 原样', () => {
    // 若未来 kimi-k3 机制窗口被下调到 500k 以下,登记表不得把它放大回去。
    assert.equal(projectContextWindowForRole('kimi-k3', 200_000, 'user'), 200_000)
  })
  test('未登记模型全角色原样(glm-5.2 1M 不受影响)', () => {
    assert.equal(projectContextWindowForRole('glm-5.2', 1_000_000, 'user'), 1_000_000)
    assert.equal(projectContextWindowForRole('glm-5.2', 1_000_000, 'admin'), 1_000_000)
  })
  test('contextWindow=null(codex 行)原样透传,不参与 min', () => {
    assert.equal(projectContextWindowForRole('kimi-k3', null, 'user'), null)
  })
  test('登记表:值必须为正整数(防手误登负数/零把模型打死)', () => {
    for (const [modelId, limit] of Object.entries(NON_ADMIN_CONTEXT_WINDOW_LIMITS)) {
      assert.ok(Number.isInteger(limit) && limit > 0, `${modelId} 上限非法: ${limit}`)
    }
  })
})

// ─── listForUser 投影落点 ────────────────────────────────────────────────

function entry(
  over: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, 'entryId' | 'modelId'>,
): ModelCatalogEntry {
  return {
    engine: 'ccb',
    providerId: 'moonshot',
    upstreamModelId: null,
    contextWindow: 1_048_576,
    capabilityProfile: {
      supportsVision: true,
      reasoning: { supported: [], codexModelDefault: null },
      ccb: { capabilityZero: true, supportsThinking: true },
    },
    capabilitySchemaVersion: 1,
    state: 'active',
    lockVersion: 0,
    ...over,
  }
}

function price(modelId: string, over: Partial<ModelCatalogPricing> = {}): ModelCatalogPricing {
  return {
    modelId,
    displayName: `名字:${modelId}`,
    inputPerMtok: 1000n,
    outputPerMtok: 5000n,
    cacheReadPerMtok: 100n,
    cacheWritePerMtok: 0n,
    multiplier: '1.000',
    visibility: 'public',
    sortOrder: 89,
    defaultEffort: null,
    ...over,
  }
}

function snapshotWith(): ModelCatalogSnapshot {
  const entries = [
    entry({ entryId: 1, modelId: 'kimi-k3' }),
    entry({ entryId: 2, modelId: 'glm-5.2', providerId: 'ark', contextWindow: 1_000_000 }),
  ]
  return new ModelCatalogSnapshot({
    entries,
    aliases: new Map(),
    pricing: new Map([
      ['kimi-k3', price('kimi-k3')],
      ['glm-5.2', price('glm-5.2', { sortOrder: 84 })],
    ]),
    securityEpoch: 7n,
  })
}

describe('listForUser — 角色分档窗口投影', () => {
  const snap = snapshotWith()
  const adminScope = { uid: 1n, role: 'admin' as const, grantedModelIds: new Set<string>() }
  const userScope = { uid: 42n, role: 'user' as const, grantedModelIds: new Set<string>() }

  test('kimi-k3:admin 见 1048576,user 见 512000;glm-5.2 两角色同窗', () => {
    const byIdAdmin = new Map(snap.listForUser(adminScope).map((r) => [r.modelId, r]))
    const byIdUser = new Map(snap.listForUser(userScope).map((r) => [r.modelId, r]))
    assert.equal(byIdAdmin.get('kimi-k3')?.contextWindow, 1_048_576)
    assert.equal(byIdUser.get('kimi-k3')?.contextWindow, 512_000)
    assert.equal(byIdAdmin.get('glm-5.2')?.contextWindow, 1_000_000)
    assert.equal(byIdUser.get('glm-5.2')?.contextWindow, 1_000_000)
  })

  test('projectionRevision 因窗口分档按角色分叉(策略进对账哈希)', () => {
    // 同 uid 不同 role 的 revision 必不同 —— 若有人把策略从 listForUser 挪走/旁路,
    // 两个 revision 会变回只差 uid 字段,egress 重算与 master 下发也会漂移,这条先挡住。
    const revAdmin = snap.projectionRevisionFor({ ...adminScope, uid: 1n })
    const revUserSameUid = snap.projectionRevisionFor({
      uid: 1n,
      role: 'user',
      grantedModelIds: new Set(),
    })
    assert.notEqual(revAdmin, revUserSameUid)
  })

  test('resolve() 不受角色投影影响(机制描述符保持 1M)', () => {
    assert.equal(snap.resolve('kimi-k3')?.contextWindow, 1_048_576)
  })
})
