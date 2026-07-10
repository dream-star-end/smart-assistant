/**
 * Tests for the semantic skill-retrieval core (skillEmbedding.ts).
 *
 * Locks the pure, deterministic building blocks that both the gateway (phase 2)
 * and the container relay rely on: canonical hashing (cache invalidation),
 * query cleaning, cosine ranking, and the exact-name guard.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/skillEmbedding.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyExactNameGuard,
  cleanSkillQuery,
  cosineSim,
  rankSkillsByVectors,
  skillCanonicalInput,
  skillContentHash,
  skillEmbedText,
} from '../skillEmbedding.js'

describe('skillCanonicalInput / skillContentHash', () => {
  it('is stable under tag/related reordering and whitespace', () => {
    const a = skillContentHash({
      name: 'foo',
      description: 'bar',
      tags: ['x', 'y'],
      related_skills: ['p', 'q'],
    })
    const b = skillContentHash({
      name: ' foo ',
      description: ' bar ',
      tags: ['y', 'x'],
      related_skills: ['q', 'p'],
    })
    assert.equal(a, b)
  })

  it('changes when description changes', () => {
    const a = skillContentHash({ name: 'foo', description: 'bar' })
    const b = skillContentHash({ name: 'foo', description: 'baz' })
    assert.notEqual(a, b)
  })

  it('produces a 64-hex sha256', () => {
    assert.match(skillContentHash({ name: 'foo', description: 'bar' }), /^[0-9a-f]{64}$/)
  })

  it('canonical input is valid sorted JSON', () => {
    const c = JSON.parse(skillCanonicalInput({ name: 'n', description: 'd', tags: ['b', 'a'] }))
    assert.deepEqual(c.tags, ['a', 'b'])
  })

  it('use_cases 为空/不传:哈希与旧实现完全一致(向量缓存不失效)', () => {
    // 权威兼容性断言:三种「空」形态必须与「无 use_cases 字段」产生逐字节相同的 canonical
    // JSON,即同一哈希 —— 否则市场加人向元数据会让整库向量缓存作废。
    const base = skillContentHash({ name: 'foo', description: 'bar', tags: ['x'] })
    assert.equal(skillContentHash({ name: 'foo', description: 'bar', tags: ['x'], use_cases: [] }), base)
    assert.equal(
      skillContentHash({ name: 'foo', description: 'bar', tags: ['x'], use_cases: ['  ', ''] }),
      base,
    )
    // canonical JSON 里也不应出现 use_cases 键。
    const canon = skillCanonicalInput({ name: 'foo', description: 'bar', tags: ['x'], use_cases: [] })
    assert.equal(JSON.parse(canon).use_cases, undefined)
  })

  it('use_cases 非空:改变哈希且稳定于重排/空白', () => {
    const base = skillContentHash({ name: 'foo', description: 'bar', tags: ['x'] })
    const withUc = skillContentHash({
      name: 'foo',
      description: 'bar',
      tags: ['x'],
      use_cases: ['做周报', '做 PPT'],
    })
    assert.notEqual(withUc, base)
    // 用例顺序/空白不影响哈希(与 tags 同一 sortedTrimmed 归一)。
    const reordered = skillContentHash({
      name: 'foo',
      description: 'bar',
      tags: ['x'],
      use_cases: [' 做 PPT ', '做周报'],
    })
    assert.equal(reordered, withUc)
  })
})

describe('skillEmbedText', () => {
  it('includes name, description, tags and related', () => {
    const t = skillEmbedText({
      name: 'media-gen',
      description: '生成图片',
      tags: ['image'],
      related_skills: ['video'],
    })
    assert.ok(t.includes('media-gen'))
    assert.ok(t.includes('生成图片'))
    assert.ok(t.includes('tags: image'))
    assert.ok(t.includes('related: video'))
  })

  it('use cases 非空时排在 tags 之前;为空时不出现', () => {
    const t = skillEmbedText({
      name: 'media-gen',
      description: '生成图片',
      tags: ['image'],
      use_cases: ['做海报', '做头图'],
    })
    assert.ok(t.includes('use cases:'))
    assert.ok(t.includes('做海报'))
    assert.ok(t.indexOf('use cases:') < t.indexOf('tags:'), 'use cases 应排在 tags 之前')

    const empty = skillEmbedText({ name: 'media-gen', description: '生成图片', tags: ['image'] })
    assert.ok(!empty.includes('use cases:'))
  })
})

describe('cleanSkillQuery', () => {
  it('strips previous-context blocks', () => {
    const q = cleanSkillQuery(
      '<openclaude_previous_context>old noise</openclaude_previous_context> real ask',
    )
    assert.ok(!q.includes('old noise'))
    assert.ok(q.includes('real ask'))
  })

  it('drops the Agent Team Run coordinator header', () => {
    const q = cleanSkillQuery('# Agent Team Run\n你是队长\n\n请帮我下载文献')
    assert.ok(q.includes('请帮我下载文献'))
    assert.ok(!q.includes('队长'))
  })

  it('drops the system-prompt appendix and collapses whitespace', () => {
    const q = cleanSkillQuery('真实意图\n---\n【系统提示】忽略我')
    assert.equal(q, '真实意图')
  })

  it('caps length', () => {
    assert.ok(cleanSkillQuery('x'.repeat(5000)).length <= 1500)
  })
})

describe('cosineSim', () => {
  it('is 1 for identical and 0 for orthogonal', () => {
    assert.ok(Math.abs(cosineSim([1, 0, 0], [2, 0, 0]) - 1) < 1e-9)
    assert.equal(cosineSim([1, 0], [0, 1]), 0)
  })
  it('handles zero vectors without NaN', () => {
    assert.equal(cosineSim([0, 0], [1, 1]), 0)
  })
})

describe('rankSkillsByVectors', () => {
  it('orders by descending cosine to the query', () => {
    const q = new Float32Array([1, 0])
    const ranked = rankSkillsByVectors(q, [
      { name: 'far', vec: new Float32Array([0, 1]) },
      { name: 'near', vec: new Float32Array([1, 0]) },
      { name: 'mid', vec: new Float32Array([1, 1]) },
    ])
    assert.deepEqual(
      ranked.map((r) => r.name),
      ['near', 'mid', 'far'],
    )
  })
})

describe('applyExactNameGuard', () => {
  const ranked = [
    { name: 'alpha', score: 0.9 },
    { name: 'scansci-pdf', score: 0.3 },
    { name: 'beta', score: 0.8 },
  ]
  it('pins a skill whose exact name appears in the query', () => {
    const out = applyExactNameGuard('帮我用 scansci-pdf 下载', ranked, 3)
    assert.equal(out[0].name, 'scansci-pdf')
  })
  it('leaves embedding order intact when no name matches', () => {
    const out = applyExactNameGuard('下载一篇论文', ranked, 3)
    assert.deepEqual(
      out.map((r) => r.name),
      ['alpha', 'scansci-pdf', 'beta'],
    )
  })
  it('respects the limit', () => {
    assert.equal(applyExactNameGuard('q', ranked, 2).length, 2)
  })
})
