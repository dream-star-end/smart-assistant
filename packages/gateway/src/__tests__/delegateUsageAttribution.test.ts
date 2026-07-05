/**
 * delegate 计费归因 — 父客户端会话 id 解析链(resolveDelegateParentClientSessionId)
 * 行为测试。
 *
 * 该值经 handleDelegateTask → sessions.getOrCreate({ usageAttribution }) →
 * runner CLAUDE_CODE_EXTRA_METADATA env(见 subprocessRunnerUsageAttributionEnv.
 * test.ts)→ master 计费点落 usage_records.parent_session_id。解析优先级:
 * 能拿到 web-* 客户端会话 id 就绝不落容器内部键。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateUsageAttribution.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveDelegateParentClientSessionId } from '../server.js'

describe('resolveDelegateParentClientSessionId — 优先级链', () => {
  it('1. 父是内存中的 webchat 会话 → progressPeerId(web-* 客户端会话 id)', () => {
    assert.equal(
      resolveDelegateParentClientSessionId({
        progressPeerId: 'web-mo7ho2z4-0fojstsu',
        parentRepoSessionId: 'web-should-not-win',
        parentSessionKey: 'agent:main:webchat:dm:web-should-not-win-either',
      }),
      'web-mo7ho2z4-0fojstsu',
    )
  })

  it('2. 嵌套 delegate(父是 delegate 会话)→ parentRepoSessionId(根 webchat 会话 id)', () => {
    assert.equal(
      resolveDelegateParentClientSessionId({
        progressPeerId: undefined,
        parentRepoSessionId: 'web-root-session',
        parentSessionKey: 'agent:coding-assistant:delegate:main:1783300000000',
      }),
      'web-root-session',
    )
  })

  it('3. 父会话不在内存但 key 是 webchat 形状 → 截取第 4 段(gateway 重启兜底)', () => {
    assert.equal(
      resolveDelegateParentClientSessionId({
        parentSessionKey: 'agent:main:webchat:dm:web-mo7to5ey-jmehrqba',
      }),
      'web-mo7to5ey-jmehrqba',
    )
  })

  it('4. 非 webchat 形状的 parentSessionKey(cron/webhook 父等)→ 原样返回(内部键,文档化映射链)', () => {
    const key = 'agent:main:cron:daily-report:1783300000000'
    assert.equal(resolveDelegateParentClientSessionId({ parentSessionKey: key }), key)
  })

  it('5. 全部缺失 / 非 string parentSessionKey → undefined(parent_session_id 落 NULL)', () => {
    assert.equal(resolveDelegateParentClientSessionId({}), undefined)
    assert.equal(
      resolveDelegateParentClientSessionId({ parentSessionKey: 42 }),
      undefined,
    )
    assert.equal(
      resolveDelegateParentClientSessionId({ parentSessionKey: '' }),
      undefined,
    )
  })

  it('空串 progressPeerId / parentRepoSessionId 不占优先级(falsy 跳过)', () => {
    assert.equal(
      resolveDelegateParentClientSessionId({
        progressPeerId: '',
        parentRepoSessionId: '',
        parentSessionKey: 'agent:main:webchat:dm:web-fallthrough',
      }),
      'web-fallthrough',
    )
  })
})
