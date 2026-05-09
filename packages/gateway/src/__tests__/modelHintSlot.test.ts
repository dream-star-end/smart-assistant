/**
 * Per-model extra system prompt slot — buildModelHintSlot + setModelHintProvider 行为契约。
 *
 * 设计契约(改前先改测试):
 *   - 无 provider 注入 → 永远 null
 *   - 无 ctx.model    → null(没东西可查)
 *   - provider 返 null/undefined → null(模型未配置)
 *   - provider 返非对象 / 缺 id / 缺 text → null(防御外部脏数据 + 旧 string 接口)
 *   - provider 返 { id, text:空白 } → null(trim 后为空)
 *   - provider 抛错  → null + warn(不能拖死 prompt 构建)
 *   - provider 返合法 { id, text } → slot.name='MODEL_HINT' + 包含 heading + 不复述提示 + 原文
 *   - slot.canonicalId === provider 返回的 id(给 buildPromptContext 当 metric label)
 *
 *   - buildPromptContext 返回 PromptContextResult { content, applied }
 *   - applied 列表里 MODEL_HINT 在 TOOLS 之后(若都命中)
 *   - applied 项含 bytes(UTF-8 字节数) + sha256(64 字符 hex)
 *   - MODEL_HINT 的 applied 项 meta.model_id === canonicalId(防 raw model 污染 Prom label)
 *
 * 测试隔离:每个 test 后 setModelHintProvider(null) 防交叉污染(模块级状态)。
 */
import * as assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  buildModelHintSlot,
  buildPromptContext,
  setModelHintProvider,
} from '../promptSlots.js'

afterEach(() => {
  setModelHintProvider(null)
})

describe('buildModelHintSlot', () => {
  it('returns null when no provider is registered', () => {
    setModelHintProvider(null)
    const slot = buildModelHintSlot({ agentId: 'a', model: 'deepseek-v4-pro' })
    assert.equal(slot, null)
  })

  it('returns null when ctx.model is undefined', () => {
    setModelHintProvider(() => ({ id: 'm', text: 'should not be called without model' }))
    const slot = buildModelHintSlot({ agentId: 'a' })
    assert.equal(slot, null)
  })

  it('returns null when provider returns null', () => {
    setModelHintProvider(() => null)
    const slot = buildModelHintSlot({ agentId: 'a', model: 'claude-opus-4-7' })
    assert.equal(slot, null)
  })

  it('returns null when provider returns undefined', () => {
    setModelHintProvider(() => undefined)
    const slot = buildModelHintSlot({ agentId: 'a', model: 'claude-opus-4-7' })
    assert.equal(slot, null)
  })

  it('returns null when provider returns a non-object (defensive — old string interface)', () => {
    // @ts-expect-error — 故意构造脏数据 / 旧 string 接口被错误接入
    setModelHintProvider(() => 'just a string')
    const slot = buildModelHintSlot({ agentId: 'a', model: 'm' })
    assert.equal(slot, null)
  })

  it('returns null when provider returns object missing id', () => {
    // @ts-expect-error — 故意构造脏数据
    setModelHintProvider(() => ({ text: 'no id here' }))
    const slot = buildModelHintSlot({ agentId: 'a', model: 'm' })
    assert.equal(slot, null)
  })

  it('returns null when provider returns object with empty id', () => {
    setModelHintProvider(() => ({ id: '', text: 'has text but no id' }))
    const slot = buildModelHintSlot({ agentId: 'a', model: 'm' })
    assert.equal(slot, null)
  })

  it('returns null when provider returns object missing text', () => {
    // @ts-expect-error — 故意构造脏数据
    setModelHintProvider(() => ({ id: 'canonical-m' }))
    const slot = buildModelHintSlot({ agentId: 'a', model: 'm' })
    assert.equal(slot, null)
  })

  it('returns null when provider returns whitespace-only text', () => {
    setModelHintProvider(() => ({ id: 'canonical-m', text: '  \n\t  ' }))
    const slot = buildModelHintSlot({ agentId: 'a', model: 'm' })
    assert.equal(slot, null)
  })

  it('returns null when provider throws (does NOT crash prompt build)', () => {
    setModelHintProvider(() => {
      throw new Error('boom')
    })
    const slot = buildModelHintSlot({ agentId: 'a', model: 'm' })
    assert.equal(slot, null)
  })

  it('returns slot with MODEL_HINT name + heading + body + canonicalId when provider returns valid result', () => {
    const text = '完成一个步骤后,不要 yield,继续推进至全部目标完成,除非遇到必须用户决策的事'
    setModelHintProvider(() => ({ id: 'deepseek-v4-pro', text }))
    const slot = buildModelHintSlot({ agentId: 'a', model: 'deepseek-v4-pro-20260315' })
    assert.ok(slot)
    assert.equal(slot!.name, 'MODEL_HINT')
    // canonicalId 来自 provider 返的 id(已归一化),不是入参 raw model
    assert.equal(slot!.canonicalId, 'deepseek-v4-pro')
    assert.match(slot!.content, /^# 模型行为补丁/)
    // 不复述提示必须出现 — 防止 model 把这段守则原样回显给用户
    assert.match(slot!.content, /不要在回答中复述/)
    assert.ok(slot!.content.includes(text), 'slot content must include the raw provider text')
  })

  it('trims provider text before injection', () => {
    setModelHintProvider(() => ({ id: 'm', text: '\n\n  hello  \n' }))
    const slot = buildModelHintSlot({ agentId: 'a', model: 'm' })
    assert.ok(slot)
    // trimmed body should appear without surrounding whitespace
    assert.match(slot!.content, /\nhello$/)
  })

  it('provider receives the exact ctx.model string (no canonicalize at slot layer)', () => {
    // canonicalize 是 provider 内部职责(commercial 那侧 PricingCache 走 canonicalizeModelId);
    // slot 这一层不主动归一,保证未来可加 alias 时只改 provider 不改 promptSlots。
    let received: string | undefined
    setModelHintProvider((m) => {
      received = m
      return { id: 'canonical-x', text: 'x' }
    })
    buildModelHintSlot({ agentId: 'a', model: 'claude-opus-4-7-20260101' })
    assert.equal(received, 'claude-opus-4-7-20260101')
  })
})

describe('buildPromptContext result shape', () => {
  it('returns { content, applied } and applied items have bytes + sha256(64 hex)', async () => {
    const result = await buildPromptContext({ agentId: 'nonexistent-agent-for-test' })
    assert.equal(typeof result.content, 'string')
    assert.ok(Array.isArray(result.applied))
    assert.ok(result.applied.length > 0, 'at least AGENTS + TOOLS slots always emit')
    for (const slot of result.applied) {
      assert.equal(typeof slot.name, 'string')
      assert.equal(typeof slot.bytes, 'number')
      assert.ok(slot.bytes > 0)
      assert.match(slot.sha256, /^[0-9a-f]{64}$/, `sha256 must be 64-char lowercase hex (got ${slot.sha256})`)
    }
  })

  it('applied[].name list reflects slot order (AGENTS … TOOLS … MODEL_HINT … RESEARCH)', async () => {
    setModelHintProvider(() => ({ id: 'deepseek-v4-pro', text: 'model-default-tweak' }))
    const result = await buildPromptContext({
      agentId: 'nonexistent-agent-for-test',
      model: 'deepseek-v4-pro',
      effortLevel: 'max', // 触发 RESEARCH
    })
    const names = result.applied.map((s) => s.name)
    const toolsIdx = names.indexOf('TOOLS')
    const hintIdx = names.indexOf('MODEL_HINT')
    const researchIdx = names.indexOf('RESEARCH')
    assert.notEqual(toolsIdx, -1, 'TOOLS slot must always be emitted')
    assert.notEqual(hintIdx, -1, 'MODEL_HINT must be emitted when provider returns text')
    assert.notEqual(researchIdx, -1, 'RESEARCH must be emitted when effortLevel=max')
    assert.ok(toolsIdx < hintIdx, `MODEL_HINT (${hintIdx}) must come after TOOLS (${toolsIdx})`)
    assert.ok(hintIdx < researchIdx, `RESEARCH (${researchIdx}) must come after MODEL_HINT (${hintIdx})`)
  })

  it('content actually contains the model hint heading when MODEL_HINT slot fires', async () => {
    setModelHintProvider(() => ({ id: 'deepseek-v4-pro', text: '禁止早 yield' }))
    const result = await buildPromptContext({
      agentId: 'nonexistent-agent-for-test',
      model: 'deepseek-v4-pro',
    })
    assert.match(result.content, /# 模型行为补丁/)
    assert.match(result.content, /禁止早 yield/)
  })

  it('MODEL_HINT applied entry surfaces canonical id via meta.model_id (NOT raw input)', async () => {
    // 关键安全契约:metric label 必须用 canonical id 不能用入参 raw model,
    // 否则外部可控字符串(如带任意日期 alias)能撑爆 Prom counter cardinality。
    // provider 已归一化 → meta.model_id 必须 == provider.id,与 ctx.model 入参可不同。
    setModelHintProvider(() => ({ id: 'deepseek-v4-pro', text: '禁止早 yield' }))
    const result = await buildPromptContext({
      agentId: 'nonexistent-agent-for-test',
      model: 'deepseek-v4-pro-20260315-evil-suffix-AAAAAA', // 模拟 raw 入参 cardinality 攻击
    })
    const hint = result.applied.find((s) => s.name === 'MODEL_HINT')
    assert.ok(hint, 'MODEL_HINT must be emitted')
    assert.ok(hint!.meta, 'MODEL_HINT applied must carry meta')
    assert.equal(
      hint!.meta!.model_id,
      'deepseek-v4-pro',
      'meta.model_id must be the canonical id from provider, not the raw spawn input',
    )
  })

  it('no MODEL_HINT in applied when provider not registered', async () => {
    setModelHintProvider(null)
    const result = await buildPromptContext({
      agentId: 'nonexistent-agent-for-test',
      model: 'deepseek-v4-pro',
    })
    const names = result.applied.map((s) => s.name)
    assert.equal(names.includes('MODEL_HINT'), false)
    assert.equal(/# 模型行为补丁/.test(result.content), false)
  })
})
