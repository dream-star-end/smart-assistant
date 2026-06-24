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
