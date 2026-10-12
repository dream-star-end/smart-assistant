import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PROMPT_SESSION_CONTEXT_MARKER, buildPromptContext } from '../promptSlots.js'
import { usesStaticFirstPromptLayout } from '../subprocessRunner.js'

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

const catalog = (revision: string, id: string) => ({
  models: [{ modelId: id, engine: 'ccb' as const, available: true }],
  projectionRevision: revision,
  verifiedAt: 5,
})

describe('static-first prompt layout (OCV5-383)', () => {
  it('puts the same static text before the marker for different sessions', async () => {
    await withoutRemotePlatformSlots(async () => {
      const a = await buildPromptContext({
        agentId: 'nonexistent-agent-for-test',
        provider: 'ccb',
        model: 'deepseek-v4-flash',
        cacheLayout: 'static-first',
        delegateModelCatalog: catalog('rev-aaaaaaaaaaaa', 'deepseek-v4-flash'),
      })
      const b = await buildPromptContext({
        agentId: 'nonexistent-agent-for-test',
        provider: 'ccb',
        model: 'deepseek-v4-flash',
        cacheLayout: 'static-first',
        delegateModelCatalog: catalog('rev-bbbbbbbbbbbb', 'kimi-k3'),
      })
      const [aStatic, aDynamic] = a.content.split(PROMPT_SESSION_CONTEXT_MARKER)
      const [bStatic, bDynamic] = b.content.split(PROMPT_SESSION_CONTEXT_MARKER)
      assert.equal(a.content.split(PROMPT_SESSION_CONTEXT_MARKER).length, 2)
      assert.equal(aStatic, bStatic)
      assert.notEqual(aDynamic, bDynamic)
      assert.match(aStatic!, /# Platform capabilities/)
      assert.match(aStatic!, /# 学习系统/)
      assert.match(aDynamic!, /## 委派可用型号/)
      assert.doesNotMatch(aStatic!, /## 委派可用型号|rev-aaaa/)
      assert.ok(a.applied.some((slot) => slot.name === 'AGENTS_DYNAMIC'))
    })
  })

  it('keeps the legacy order and no marker when the layout is not requested', async () => {
    await withoutRemotePlatformSlots(async () => {
      const legacy = await buildPromptContext({
        agentId: 'nonexistent-agent-for-test',
        provider: 'ccb',
        model: 'deepseek-v4-flash',
        delegateModelCatalog: catalog('rev-aaaaaaaaaaaa', 'deepseek-v4-flash'),
      })
      assert.doesNotMatch(legacy.content, /oc:session-context/)
      assert.ok(
        legacy.content.indexOf('## 委派可用型号') < legacy.content.indexOf('# 学习系统'),
        'delegate models stay inside AGENTS, before TOOLS',
      )
      assert.ok(!legacy.applied.some((slot) => slot.name === 'AGENTS_DYNAMIC'))
    })
  })

  it('is used only for the CCB harness outside the Box-resident CLI', () => {
    assert.equal(usesStaticFirstPromptLayout('ccb', false), true)
    assert.equal(usesStaticFirstPromptLayout('ccb', undefined), true)
    assert.equal(usesStaticFirstPromptLayout('ccb', true), false)
    assert.equal(usesStaticFirstPromptLayout('official-cc', false), false)
  })
})
