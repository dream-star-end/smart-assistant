import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  type SkillShadowSelectionEvent,
  isSkillShadowEnabled,
  skillShadowContainerEnv,
  skillShadowSampleRate,
  upsertSkillShadowEvent,
  validateSkillShadowEvent,
} from '../http/internalSkillShadow.js'
import type { QueryRunner } from '../http/internalSkillUsage.js'

const TRACE = 'a'.repeat(32)
const HASH = 'b'.repeat(64)

function selection(): SkillShadowSelectionEvent {
  return {
    kind: 'selection',
    traceId: TRACE,
    sessionKey: 'agent:main:webchat:dm:p1',
    agentId: 'main',
    messageHash: HASH,
    sampleRate: 0.1,
    status: 'ok',
    routes: {
      existing_keyword_fallback: ['office-spreadsheet'],
      zh_lexical: ['office-spreadsheet'],
      char_ngram: ['office-spreadsheet'],
      bm25_multiquery: ['office-spreadsheet'],
    },
    catalogSize: 40,
    elapsedMs: 12,
  }
}

describe('internal skill shadow', () => {
  test('master gate is fail-safe off and matches explicit numeric/default values', () => {
    assert.equal(isSkillShadowEnabled({}), false)
    assert.equal(skillShadowSampleRate({ OC_SKILL_SHADOW_SAMPLE_RATE: '0' }), 0)
    assert.equal(skillShadowSampleRate({ OC_SKILL_SHADOW_SAMPLE_RATE: 'invalid' }), 0)
    assert.equal(skillShadowSampleRate({ OC_SKILL_SHADOW_SAMPLE_RATE: 'default' }), 0.1)
    assert.equal(skillShadowSampleRate({ OC_SKILL_SHADOW_SAMPLE_RATE: '0.25' }), 0.25)
    assert.equal(isSkillShadowEnabled({ OC_SKILL_SHADOW_SAMPLE_RATE: '0.1' }), true)
    assert.deepEqual(skillShadowContainerEnv({}), [])
    assert.deepEqual(skillShadowContainerEnv({ OC_SKILL_SHADOW_SAMPLE_RATE: 'default' }), [
      'OC_SKILL_SHADOW_SAMPLE_RATE=0.1',
    ])
    assert.deepEqual(skillShadowContainerEnv({ OC_SKILL_SHADOW_SAMPLE_RATE: '0.25' }), [
      'OC_SKILL_SHADOW_SAMPLE_RATE=0.25',
    ])
  })

  test('validates privacy-minimal selection and usage shapes', () => {
    assert.deepEqual(validateSkillShadowEvent(selection()), selection())
    assert.deepEqual(
      validateSkillShadowEvent({ kind: 'usage', traceId: TRACE, skillName: 'office-spreadsheet' }),
      { kind: 'usage', traceId: TRACE, skillName: 'office-spreadsheet' },
    )
    assert.equal(
      validateSkillShadowEvent({ ...selection(), rawMessage: 'must not be stored' }),
      null,
    )
    assert.equal(validateSkillShadowEvent({ ...selection(), messageHash: 'raw text' }), null)
    assert.equal(
      validateSkillShadowEvent({
        ...selection(),
        routes: { ...selection().routes, zh_lexical: new Array(6).fill('office-spreadsheet') },
      }),
      null,
    )
  })

  test('selection upsert stores hash/rankings but no raw message', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = []
    const runner: QueryRunner = {
      async query(sql, params) {
        calls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      },
    }
    assert.equal(await upsertSkillShadowEvent(runner, 42, selection()), 1)
    assert.equal(calls.length, 1)
    assert.match(calls[0].sql, /ON CONFLICT \(trace_id\) DO UPDATE/)
    assert.ok(calls[0].params?.includes(HASH))
    assert.ok(!JSON.stringify(calls[0]).includes('rawMessage'))
  })

  test('usage upsert is order-independent and deduplicates actual skill names', async () => {
    let sql = ''
    let params: readonly unknown[] | undefined
    const runner: QueryRunner = {
      async query(statement, values) {
        sql = statement
        params = values
        return { rows: [], rowCount: 1 }
      },
    }
    assert.equal(
      await upsertSkillShadowEvent(runner, 42, {
        kind: 'usage',
        traceId: TRACE,
        skillName: 'office-spreadsheet',
      }),
      1,
    )
    assert.match(sql, /VALUES \(\$1, \$2, 'pending'/)
    assert.match(sql, /WHEN \$3 = ANY/)
    assert.deepEqual(params, [42, TRACE, 'office-spreadsheet'])
  })
})
