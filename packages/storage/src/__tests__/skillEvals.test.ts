import assert from 'node:assert'
import { test } from 'node:test'
import { MAX_EVAL_CASES, parseSkillEvalsJson, serializeSkillEvals } from '../skillEvals.js'

const good = {
  version: 1,
  cases: [
    { id: 'c1', prompt: '把摘要翻成英文', assertions: ['输出是英文', '保留数字'] },
    { id: 'edge-1', prompt: '空输入怎么办', assertions: ['明确说明输入为空'], expectedOutput: '提示补充' },
  ],
}

test('parseSkillEvalsJson accepts a valid file and round-trips via serialize', () => {
  const p = parseSkillEvalsJson(JSON.stringify(good))
  assert.ok(p.ok)
  if (!p.ok) return
  assert.equal(p.file.cases.length, 2)
  assert.equal(p.file.cases[1].expectedOutput, '提示补充')
  const p2 = parseSkillEvalsJson(serializeSkillEvals(p.file))
  assert.ok(p2.ok)
})

test('parseSkillEvalsJson rejects structural violations with reasons', () => {
  for (const [mut, needle] of [
    [{ ...good, version: 2 }, 'version'],
    [{ version: 1, cases: [] }, '至少 1 个'],
    [{ version: 1, cases: Array.from({ length: MAX_EVAL_CASES + 1 }, (_, i) => good.cases[0] && { ...good.cases[0], id: `c${i}` }) }, '最多'],
    [{ version: 1, cases: [{ id: 'BAD_ID', prompt: 'x', assertions: ['a'] }] }, 'id'],
    [{ version: 1, cases: [{ id: 'c1', prompt: '', assertions: ['a'] }] }, 'prompt'],
    [{ version: 1, cases: [{ id: 'c1', prompt: 'x', assertions: [] }] }, 'assertions'],
    [{ version: 1, cases: [good.cases[0], good.cases[0]] }, '重复'],
  ] as const) {
    const p = parseSkillEvalsJson(JSON.stringify(mut))
    assert.ok(!p.ok, JSON.stringify(mut).slice(0, 80))
    if (!p.ok) assert.ok(p.errors.some((e) => e.includes(needle as string)), p.errors.join(';'))
  }
})

test('parseSkillEvalsJson rejects non-JSON and autoRegression type errors', () => {
  assert.ok(!parseSkillEvalsJson('not json').ok)
  const p = parseSkillEvalsJson(JSON.stringify({ ...good, autoRegression: 'yes' }))
  assert.ok(!p.ok)
  const p2 = parseSkillEvalsJson(JSON.stringify({ ...good, autoRegression: true }))
  assert.ok(p2.ok && p2.file.autoRegression === true)
})
