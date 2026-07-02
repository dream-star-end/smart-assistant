import assert from 'node:assert'
import { test } from 'node:test'
import {
  computeBenchmark,
  emptyUsage,
  gradesToAssertions,
  parseGraderJson,
  type SkillEvalCaseResult,
} from '../skillEval.js'

const CASE = { id: 'c1', prompt: 'p', assertions: ['一', '二', '三'] }

test('parseGraderJson tolerates fences and surrounding prose', () => {
  const text = `好的,评分如下:\n\`\`\`json\n{"grades":{"A":[{"assertion":1,"passed":true,"evidence":"引文"}],"B":[{"assertion":1,"passed":false,"evidence":"缺失"}]},"preference":"B"}\n\`\`\`\n以上。`
  const p = parseGraderJson(text)
  assert.ok(p)
  assert.equal(p?.grades.A?.[0]?.passed, true)
  assert.equal(p?.preference, 'B')
})

test('parseGraderJson returns null on garbage', () => {
  assert.equal(parseGraderJson('no json here'), null)
  assert.equal(parseGraderJson('{"grades": "nope"}'), null)
})

test('gradesToAssertions demotes evidence-free PASS and fills missing as FAIL', () => {
  const graded = [
    { assertion: 1, passed: true, evidence: '有证据' },
    { assertion: 2, passed: true, evidence: '' },
  ]
  const out = gradesToAssertions(CASE, graded)
  assert.deepEqual(
    out.map((a) => a.passed),
    [true, false, false],
  )
  assert.ok(out[1].evidence.includes('按 FAIL 计'))
})

function res(arm: 'with' | 'without' | 'draft', passed: number, total: number): SkillEvalCaseResult {
  return {
    caseId: 'c1',
    arm,
    output: 'o',
    usage: { ...emptyUsage(), outputTokens: 100 },
    assertions: Array.from({ length: total }, (_, i) => ({
      text: `a${i}`,
      passed: i < passed,
      evidence: i < passed ? 'e' : 'f',
    })),
  }
}

test('computeBenchmark baseline verdicts', () => {
  const up = computeBenchmark([res('without', 1, 4), res('with', 3, 4)], { draftMode: false })
  assert.ok(up.verdict.includes('技能有效'))
  assert.equal(up.passRate.with, 0.75)
  const down = computeBenchmark([res('without', 3, 4), res('with', 1, 4)], { draftMode: false })
  assert.ok(down.verdict.includes('反而更差'))
  const flat = computeBenchmark([res('without', 2, 4), res('with', 2, 4)], { draftMode: false })
  assert.ok(flat.verdict.includes('未带来'))
})

test('computeBenchmark draft mode uses preference on tie and skips errored results', () => {
  const tie = computeBenchmark(
    [res('with', 2, 4), res('draft', 2, 4), { ...res('draft', 0, 4), error: 'x' }],
    { draftMode: true, preferences: ['draft'] },
  )
  assert.ok(tie.verdict.includes('盲测更偏好草稿'))
  const worse = computeBenchmark([res('with', 3, 4), res('draft', 1, 4)], {
    draftMode: true,
    preferences: [],
  })
  assert.ok(worse.verdict.includes('不建议合并'))
})
