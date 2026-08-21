import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TutorialEvalError,
  DEFAULT_EVAL_LEASE_MS,
  evaluateTutorialRubric,
  hashTutorialMaterials,
  validateCaseSpecPayload,
} from '../tutorials/tutorialEval.js'

test('case spec requires source URL, collection time, frozen materials and machine rubric', () => {
  const good = {
    publicId: 'bike-demand',
    title: '公开自行车需求回归',
    sourceUrl: 'https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset',
    sourcePlatform: 'UCI',
    collectedAt: new Date().toISOString(),
    frozenPrompt: '使用冻结数据完成回归并交付报告与图表。',
    frozenMaterials: { items: [{ name: 'hour.csv', sha256: 'a'.repeat(64) }] },
    authScope: 'synthetic_eval' as const,
    rubric: {
      checks: [{ id: 'r2', method: 'contains', passCriterion: 'R2=0.90' }],
    },
  }
  validateCaseSpecPayload(good)

  assert.throws(
    () => validateCaseSpecPayload({ ...good, sourceUrl: 'ftp://x.test/a' }),
    (error: unknown) => error instanceof TutorialEvalError && error.code === 'BAD_SPEC',
  )
  assert.throws(
    () => validateCaseSpecPayload({ ...good, rubric: { checks: [] } }),
    (error: unknown) => error instanceof TutorialEvalError && error.code === 'BAD_SPEC',
  )
  assert.throws(
    () => validateCaseSpecPayload({ ...good, frozenMaterials: { items: 'nope' } }),
    (error: unknown) => error instanceof TutorialEvalError && error.code === 'BAD_SPEC',
  )
  assert.equal(evaluateTutorialRubric(good.rubric, '结果 R2=0.90').passed, true)
  assert.equal(evaluateTutorialRubric(good.rubric, '结果不达标').passed, false)
  assert.equal(DEFAULT_EVAL_LEASE_MS, 45 * 60 * 1000)
  assert.equal(
    hashTutorialMaterials({ items: [{ b: 2, a: 1 }] }),
    hashTutorialMaterials({ items: [{ a: 1, b: 2 }] }),
  )
})
