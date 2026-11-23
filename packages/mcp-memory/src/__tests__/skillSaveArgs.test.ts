/**
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/skillSaveArgs.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeSkillSaveArgs } from '../skillSaveArgs.js'

describe('normalizeSkillSaveArgs', () => {
  it('passes well-formed args through unchanged', () => {
    const r = normalizeSkillSaveArgs({
      name: 'my-skill',
      description: 'When to use.',
      body: '# Body',
      tags: ['a', 'b'],
      force: true,
    })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.deepEqual(r.args, {
        name: 'my-skill',
        description: 'When to use.',
        body: '# Body',
        tags: ['a', 'b'],
        force: true,
      })
    }
  })

  it('accepts `content` as an alias for body (CCB ExecuteExtraTool skips schema validation)', () => {
    const r = normalizeSkillSaveArgs({ name: 'x-y', description: 'd', content: '# md' })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.args.body, '# md')
  })

  it('rejects missing body with a field-name hint instead of crashing on .trim()', () => {
    const r = normalizeSkillSaveArgs({ name: 'x-y', description: 'd' })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /body required.*`body` field/)
  })

  it('rejects missing/non-string description', () => {
    const r = normalizeSkillSaveArgs({ name: 'x-y', body: '# md', description: 42 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /description required/)
  })

  it('coerces comma-separated tags string instead of crashing on tags.join', () => {
    const r = normalizeSkillSaveArgs({ name: 'x-y', description: 'd', body: 'b', tags: 'a, b ,c' })
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.args.tags, ['a', 'b', 'c'])
  })

  it('rejects non-array/non-string tags', () => {
    const r = normalizeSkillSaveArgs({ name: 'x-y', description: 'd', body: 'b', tags: { a: 1 } })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /tags must be an array/)
  })

  it('drops non-string tag items and omits tags when none remain', () => {
    const r = normalizeSkillSaveArgs({ name: 'x-y', description: 'd', body: 'b', tags: [null, '', 7, 'ok'] })
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.args.tags, ['7', 'ok'])
    const none = normalizeSkillSaveArgs({ name: 'x-y', description: 'd', body: 'b' })
    assert.equal(none.ok, true)
    if (none.ok) assert.equal('tags' in none.args, false)
  })

  it('validates the name up front', () => {
    const r = normalizeSkillSaveArgs({ name: 'Bad Name', description: 'd', body: 'b' })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /lowercase/)
    const missing = normalizeSkillSaveArgs(null)
    assert.equal(missing.ok, false)
  })

  it('OCV5-865: preserves optional version and related_skills and rejects non-string version', () => {
    const ok = normalizeSkillSaveArgs({
      name: 'research-pipeline',
      description: 'desc',
      body: '# body',
      version: ' 1.2.3 ',
      related_skills: 'oc-cite, oc-docx',
    })
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.equal(ok.args.version, '1.2.3')
      assert.deepEqual(ok.args.related_skills, ['oc-cite', 'oc-docx'])
    }
    const bad = normalizeSkillSaveArgs({
      name: 'research-pipeline',
      description: 'desc',
      body: '# body',
      version: 123,
    })
    assert.equal(bad.ok, false)
  })
})
