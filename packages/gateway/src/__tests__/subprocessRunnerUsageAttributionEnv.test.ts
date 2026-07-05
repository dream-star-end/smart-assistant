/**
 * delegate 子会话计费归因 — spawn-time CLAUDE_CODE_EXTRA_METADATA env 注入测试。
 *
 * 验证(镜像 subprocessRunnerSpawnTraceEnv.test.ts 的三段式):
 *   1. `_buildCcbUsageAttributionEnv` 纯 helper:delegate tag → oc_* JSON;
 *      undefined → 空串(**不是** key-omission —— env 块以 `...process.env` 起,
 *      省 key 会让 gateway 进程 env 里意外的 CLAUDE_CODE_EXTRA_METADATA 泄进
 *      CCB;CCB 对空串按未设置处理)。
 *   2. 值截断:parentSessionId ≤128 / delegateAgentId ≤64,守 proxy 侧
 *      metadata.user_id 512 字节 zod 预算。
 *   3. **结构**断言:backend.spawn({ env: { … } }) 调用点 spread
 *      `_buildCcbUsageAttributionEnv(this.opts.usageAttribution)` 恰好一次 ——
 *      重构丢 spread 会静默丢掉整条 delegate 归因链,这里强制可见。
 *
 * 与 resolveDelegateParentClientSessionId(server.ts,注入值的解析链)的测试
 * 在 delegateUsageAttribution.test.ts。
 *
 * Run:
 *   npx tsx --test packages/gateway/src/__tests__/subprocessRunnerUsageAttributionEnv.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { _buildCcbUsageAttributionEnv, type UsageAttributionTag } from '../subprocessRunner.js'

// ── _buildCcbUsageAttributionEnv unit tests ──

test('buildCcbUsageAttributionEnv: 完整 delegate tag → oc_mode / oc_delegate_agent_id / oc_parent_session_id JSON', () => {
  const env = _buildCcbUsageAttributionEnv({
    mode: 'delegate',
    parentSessionId: 'web-mo7ho2z4-0fojstsu',
    delegateAgentId: 'hidden-reviewer',
  })
  assert.deepEqual(JSON.parse(env.CLAUDE_CODE_EXTRA_METADATA), {
    oc_mode: 'delegate',
    oc_delegate_agent_id: 'hidden-reviewer',
    oc_parent_session_id: 'web-mo7ho2z4-0fojstsu',
  })
})

test('buildCcbUsageAttributionEnv: 无 parentSessionId → 键省略(master 侧落 NULL),其余照常', () => {
  const env = _buildCcbUsageAttributionEnv({
    mode: 'delegate',
    delegateAgentId: 'coding-assistant',
  })
  const parsed = JSON.parse(env.CLAUDE_CODE_EXTRA_METADATA) as Record<string, string>
  assert.deepEqual(parsed, {
    oc_mode: 'delegate',
    oc_delegate_agent_id: 'coding-assistant',
  })
  assert.ok(!('oc_parent_session_id' in parsed))
})

test('buildCcbUsageAttributionEnv: undefined(普通 chat/cron/webhook 会话)→ 空串,NOT key omission', () => {
  const env = _buildCcbUsageAttributionEnv(undefined)
  assert.deepEqual(env, { CLAUDE_CODE_EXTRA_METADATA: '' })
  assert.ok(
    'CLAUDE_CODE_EXTRA_METADATA' in env,
    'key must be present even when value is empty(覆盖 process.env 继承)',
  )
})

test('buildCcbUsageAttributionEnv: 超长值截断(parent ≤128 / agent ≤64,守 512 字节 user_id 预算)', () => {
  const tag: UsageAttributionTag = {
    mode: 'delegate',
    parentSessionId: 'p'.repeat(300),
    delegateAgentId: 'a'.repeat(100),
  }
  const parsed = JSON.parse(
    _buildCcbUsageAttributionEnv(tag).CLAUDE_CODE_EXTRA_METADATA,
  ) as Record<string, string>
  assert.equal(parsed.oc_parent_session_id, 'p'.repeat(128))
  assert.equal(parsed.oc_delegate_agent_id, 'a'.repeat(64))
})

// ── 结构断言:spawn env 块 spread 恰好一次 ──

test('subprocessRunner.ts spawn env 块 spread _buildCcbUsageAttributionEnv(this.opts.usageAttribution) 恰好一次', () => {
  const src = readFileSync(
    new URL('../subprocessRunner.ts', import.meta.url),
    'utf8',
  )
  const spreads = src.match(
    /\.\.\._buildCcbUsageAttributionEnv\(this\.opts\.usageAttribution\)/g,
  )
  assert.equal(
    spreads?.length,
    1,
    'backend.spawn env 必须 spread _buildCcbUsageAttributionEnv 恰好一次(丢 spread = 整条 delegate 归因链静默失效)',
  )
})
