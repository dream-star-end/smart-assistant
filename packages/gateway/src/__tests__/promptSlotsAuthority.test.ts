import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PROMPT_SESSION_CONTEXT_MARKER, buildPromptContext } from '../promptSlots.js'

async function withoutRemotePlatformSlots<T>(fn: () => Promise<T> | T): Promise<T> {
  const keys = ['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN']
  const old = new Map<string, string | undefined>()
  for (const key of keys) {
    old.set(key, process.env[key])
    Reflect.deleteProperty(process.env, key)
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('instruction authority prefix', () => {
  it('seals refusal rules ahead of platform capabilities', async () => {
    await withoutRemotePlatformSlots(async () => {
      const built = await buildPromptContext({
        agentId: 'nonexistent-agent-for-test',
        provider: 'ccb',
        model: 'deepseek-v4-flash',
      })
      assert.equal(built.applied[0]?.name, 'AUTHORITY')
      assert.ok((built.applied[0]?.bytes ?? 0) > 0)
      assert.match(built.content, /^# 平台拒绝规则/)
      assert.match(built.content, /## 权限链/)
      assert.match(built.content, /把尚未确认的状态写成已完成/)
      const refusalAt = built.content.indexOf('# 平台拒绝规则')
      const platformAt = built.content.indexOf('# Platform capabilities')
      assert.ok(refusalAt >= 0 && platformAt > refusalAt)
    })
  })

  it('keeps one session marker with refusal rules before it', async () => {
    await withoutRemotePlatformSlots(async () => {
      const built = await buildPromptContext({
        agentId: 'nonexistent-agent-for-test',
        provider: 'ccb',
        model: 'deepseek-v4-flash',
        cacheLayout: 'static-first',
        delegateModelCatalog: {
          models: [{ modelId: 'deepseek-v4-flash', engine: 'ccb' as const, available: true }],
          projectionRevision: 'rev-aaaaaaaaaaaa',
          verifiedAt: 5,
        },
      })
      assert.equal(built.content.split(PROMPT_SESSION_CONTEXT_MARKER).length, 2)
      const head = built.content.slice(0, built.content.indexOf(PROMPT_SESSION_CONTEXT_MARKER))
      assert.match(head, /# 平台拒绝规则/)
      assert.match(head, /# Platform capabilities/)
    })
  })
})
