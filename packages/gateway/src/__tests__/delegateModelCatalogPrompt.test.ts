import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DELEGATE_MODEL_SECTION_HEADING,
  DELEGATE_MODEL_SECTION_UNAVAILABLE,
  expandCursorPatterns,
  parseCursorSlug,
  renderCursorFamilies,
  renderDelegateModelSection,
  suggestDelegateModels,
} from '../delegateModelCatalogPrompt.js'
import { buildAgentsSlot } from '../promptSlots.js'
import { _internals as _platformPromptInternals } from '../platformPrompts.js'

// 真实投影里 cursor 家族的形状(2026-09 LKG):fable 没有 -fast、gemini 只有 low/medium/high、
// grok/opus 有全档位 + -fast、sonnet 全档位无 -fast。压缩必须逐个还原,不能拼出不存在的组合。
const CURSOR_REAL = [
  'cursor-gemini-3.8-flash-high', 'cursor-gemini-3.8-flash-low', 'cursor-gemini-3.8-flash-medium',
  'cursor-grok-4.6-high', 'cursor-grok-4.6-high-fast', 'cursor-grok-4.6-low', 'cursor-grok-4.6-low-fast',
  'cursor-grok-4.6-medium', 'cursor-grok-4.6-medium-fast', 'cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh-fast',
  'cursor-opus-4.8-high', 'cursor-opus-4.8-high-fast', 'cursor-opus-4.8-low', 'cursor-opus-4.8-low-fast',
  'cursor-opus-4.8-max', 'cursor-opus-4.8-max-fast', 'cursor-opus-4.8-medium', 'cursor-opus-4.8-medium-fast',
  'cursor-opus-4.8-xhigh', 'cursor-opus-4.8-xhigh-fast',
  'cursor-opus-5-high', 'cursor-opus-5-high-fast', 'cursor-opus-5-low', 'cursor-opus-5-low-fast',
  'cursor-opus-5-max', 'cursor-opus-5-max-fast', 'cursor-opus-5-medium', 'cursor-opus-5-medium-fast',
  'cursor-opus-5-xhigh', 'cursor-opus-5-xhigh-fast',
  'cursor-fable-5.1-high', 'cursor-fable-5.1-low', 'cursor-fable-5.1-max', 'cursor-fable-5.1-medium', 'cursor-fable-5.1-xhigh',
  'cursor-sonnet-5-high', 'cursor-sonnet-5-low', 'cursor-sonnet-5-max', 'cursor-sonnet-5-medium', 'cursor-sonnet-5-xhigh',
]

const mk = (ids: readonly string[], engine: 'ccb' | 'codex' | 'grok' | 'cursor', available = true) =>
  ids.map((modelId) => ({ modelId, engine, available }))

describe('parseCursorSlug', () => {
  it('拆出 family / effort / fast', () => {
    assert.deepEqual(parseCursorSlug('cursor-opus-5-high-fast'), { family: 'cursor-opus-5', effort: 'high', fast: true })
    assert.deepEqual(parseCursorSlug('cursor-fable-5.1-xhigh'), { family: 'cursor-fable-5.1', effort: 'xhigh', fast: false })
  })
  it('非 cursor / 未知档位 → null(原样列出,不进压缩)', () => {
    assert.equal(parseCursorSlug('gpt-6-astra'), null)
    assert.equal(parseCursorSlug('cursor-foo-ultra'), null)
    assert.equal(parseCursorSlug('cursor-high'), null)
  })
})

describe('renderCursorFamilies:压缩后展开必须与输入集合逐个相等', () => {
  it('真实 41 个 cursor slug 往返无损', () => {
    const patterns = renderCursorFamilies(CURSOR_REAL)
    const expanded = expandCursorPatterns(patterns).sort()
    assert.deepEqual(expanded, [...CURSOR_REAL].sort())
  })
  it('fable 无 -fast、gemini 缺 xhigh/max:不会拼出不存在的组合', () => {
    const patterns = renderCursorFamilies(CURSOR_REAL)
    const joined = patterns.join('\n')
    assert.match(joined, /^cursor-fable-5\.1-\{low,medium,high,xhigh,max\}$/m)
    assert.doesNotMatch(joined, /cursor-fable-5\.1-\{[^}]*\}\[-fast\]/)
    assert.match(joined, /^cursor-gemini-3\.8-flash-\{low,medium,high\}$/m)
    assert.match(joined, /^cursor-opus-5-\{low,medium,high,xhigh,max\}\[-fast\]$/m)
    assert.match(joined, /^cursor-grok-4\.6-\{low,medium,high,xhigh\}\[-fast\]$/m)
    const expanded = new Set(expandCursorPatterns(patterns))
    assert.ok(!expanded.has('cursor-fable-5.1-high-fast'))
    assert.ok(!expanded.has('cursor-gemini-3.8-flash-max'))
    assert.ok(!expanded.has('cursor-grok-4.6-max'))
  })
  it('plain 与 fast 档位集不同 → 分两行精确列出', () => {
    const patterns = renderCursorFamilies(['cursor-x-1-low', 'cursor-x-1-high', 'cursor-x-1-high-fast'])
    assert.deepEqual(patterns, ['cursor-x-1-{low,high}', 'cursor-x-1-high-fast'])
    assert.deepEqual(expandCursorPatterns(patterns).sort(), ['cursor-x-1-high', 'cursor-x-1-high-fast', 'cursor-x-1-low'])
  })
  it('解析不出的 cursor slug 原样附在末尾', () => {
    const patterns = renderCursorFamilies(['cursor-weird', 'cursor-opus-5-high'])
    assert.deepEqual(patterns, ['cursor-opus-5-high', 'cursor-weird'])
  })
})

describe('renderDelegateModelSection', () => {
  const models = [
    ...mk(['glm-5.3-zai', 'kimi-k3'], 'ccb'),
    ...mk(['gpt-6-astra', 'gpt-5.6-sol'], 'codex'),
    ...mk(['glm-5.3'], 'ccb', false), // 不可用:不得出现
    ...mk(['grok-build'], 'grok'),
    ...mk(CURSOR_REAL, 'cursor'),
  ]
  it('按 engine 分组、只列 available、标注投影与核验状态、声明服务端重校验', () => {
    const s = renderDelegateModelSection({ models, projectionRevision: 'rev-42', verifiedAt: 1 })
    assert.ok(s.startsWith(DELEGATE_MODEL_SECTION_HEADING))
    assert.match(s, /投影 rev-42,已在线核验/)
    assert.match(s, /服务端仍会重新校验/)
    assert.match(s, /^- CCB: `glm-5\.3-zai`, `kimi-k3`$/m)
    assert.match(s, /^- Codex: `gpt-5\.6-sol`, `gpt-6-astra`$/m)
    assert.match(s, /^- Grok: `grok-build`$/m)
    assert.match(s, /^- Cursor: .*`cursor-fable-5\.1-\{low,medium,high,xhigh,max\}`/m)
    assert.ok(!/`glm-5\.3`[,\n]/.test(s), '不可用型号不得列出')
  })
  it('verifiedAt=0 → 标注仅本地缓存', () => {
    const s = renderDelegateModelSection({ models, projectionRevision: 'r', verifiedAt: 0 })
    assert.match(s, /仅本地缓存,可能滞后/)
  })
  it('投影为空 → 明确提示不要填 model', () => {
    const s = renderDelegateModelSection({ models: [], projectionRevision: 'r', verifiedAt: 1 })
    assert.match(s, /没有可用型号;委派时不要填 `model`/)
  })
  it('整段 token 预算:真实规模投影 < 900 字符', () => {
    const s = renderDelegateModelSection({ models, projectionRevision: 'rev-42', verifiedAt: 1 })
    assert.ok(s.length < 900, `section too long: ${s.length}`)
  })
})

describe('suggestDelegateModels(DELEGATE_MODEL_UNKNOWN 自愈候选)', () => {
  const pool = [
    ...mk(['gpt-6-astra', 'gpt-6-astra-1m', 'gpt-5.6-sol', 'qwen3.8-max'], 'codex'),
    ...mk(['glm-5.3-zai', 'kimi-k3'], 'ccb'),
    ...mk(['gpt-6-secret'], 'codex', false),
  ]
  it("'gpt-6' → 前缀命中 gpt-6-astra / gpt-6-astra-1m,不含不可用型号", () => {
    const s = suggestDelegateModels('gpt-6', pool)
    assert.deepEqual(s.slice(0, 2), ['gpt-6-astra', 'gpt-6-astra-1m'])
    assert.ok(!s.includes('gpt-6-secret'))
  })
  it('拼写小错 → 编辑距离命中', () => {
    assert.deepEqual(suggestDelegateModels('kimi-k4', pool), ['kimi-k3'])
    assert.deepEqual(suggestDelegateModels('glm-5.3-zai ', pool)[0], 'glm-5.3-zai')
  })
  it('完全不相关 → 空数组(调用方引导看列表)', () => {
    assert.deepEqual(suggestDelegateModels('claude-opus-9', pool), [])
    assert.deepEqual(suggestDelegateModels('', pool), [])
  })
  it('最多 limit 个', () => {
    assert.equal(suggestDelegateModels('gpt', pool, 2).length, 2)
  })
})

describe('buildAgentsSlot 注入「委派可用型号」', () => {
  it('ctx 注入投影 → 段出现在 slot 里', async () => {
    const slot = await buildAgentsSlot({
      agentId: 'main',
      model: 'glm-5.3-zai',
      delegateModelCatalog: {
        models: mk(['gpt-6-astra'], 'codex'),
        projectionRevision: 'p1',
        verifiedAt: 5,
      },
    })
    assert.match(slot.content, /## 委派可用型号/)
    assert.match(slot.content, /- Codex: `gpt-6-astra`/)
  })
  it('无投影(null)→ 提示行而非静默消失', async () => {
    const slot = await buildAgentsSlot({ agentId: 'main', model: 'glm-5.3-zai', delegateModelCatalog: null })
    assert.ok(slot.content.includes(DELEGATE_MODEL_SECTION_UNAVAILABLE))
  })
  it('false → 整段不注入', async () => {
    const slot = await buildAgentsSlot({ agentId: 'main', model: 'glm-5.3-zai', delegateModelCatalog: false })
    assert.doesNotMatch(slot.content, /## 委派可用型号/)
  })
  it('静态契约四条 + 最小示例随 platform-capabilities 进入 slot', async () => {
    // 容器里 OPENCLAUDE_PLATFORM_PROMPTS_DIR 指向已部署(旧)bundle;这里断言的是源码 fallback。
    const saved = process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
    delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
    _platformPromptInternals.resetForTests()
    try {
      const slot = await buildAgentsSlot({ agentId: 'main', model: 'glm-5.3-zai', delegateModelCatalog: false })
      assertStaticContract(slot.content)
    } finally {
      if (saved !== undefined) process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = saved
      _platformPromptInternals.resetForTests()
    }
  })
})

function assertStaticContract(content: string): void {
  assert.match(content, /委派参数契约/)
  assert.match(content, /唯一必填字段是 `goal`/)
  assert.match(content, /`agentId` 是平台成员 id/)
  assert.match(content, /allowSelf: true/)
  assert.match(content, /`gpt-6` 不是 `gpt-6-astra`/)
  assert.match(content, /delegate_task\(\{ goal: "\.\.\.", agentId: "coding-assistant" \}\)/)
}
