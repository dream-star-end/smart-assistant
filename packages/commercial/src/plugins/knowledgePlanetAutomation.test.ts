import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import {
  KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER,
  KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION,
} from './knowledgePlanetAutomation.js'
import {
  KNOWLEDGE_PLANET_AUTOMATION_DISCLOSURE,
  classifyKnowledgePlanetAutomationTopicForTest,
  composeKnowledgePlanetAutomationReplyForTest,
  knowledgePlanetAutomationSourceDigestForTest,
  parseKnowledgePlanetAutomationDecisionForTest,
} from './knowledgePlanetAutomationScheduler.js'

describe('Knowledge Planet unattended automation policy', () => {
  test('is independently consented, default-off and bounded in the migration', async () => {
    assert.equal(KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION, 1)
    assert.match(KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER, /无人值守/)
    assert.match(KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER, /AI 自动生成/)
    assert.match(KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER, /计费/)
    assert.match(KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER, /结果不明确/)
    assert.match(
      KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER,
      /不会自动发主题、上传媒体、点赞、编辑或删除/,
    )

    const migration = await readFile(
      new URL('../db/migrations/0168_knowledge_planet_automation.sql', import.meta.url),
      'utf8',
    )
    assert.match(migration, /enabled BOOLEAN NOT NULL DEFAULT FALSE/g)
    assert.match(migration, /account_daily_limit BETWEEN 1 AND 30/)
    assert.match(migration, /daily_limit BETWEEN 1 AND 10/)
    assert.match(migration, /cooldown_minutes BETWEEN 5 AND 1440/)
    assert.match(migration, /max_reply_chars BETWEEN 100 AND 1200/)
    assert.match(migration, /UNIQUE \(rule_id, source_topic_id\)/)
    assert.match(migration, /dispatch_claim_token UUID/)
    assert.match(migration, /dispatch_owner_token UUID/)
    assert.match(migration, /dispatch_claim_token IS NULL OR status = 'ready'/)
    assert.match(migration, /dispatch_owner_token IS NULL OR status = 'dispatching'/)
    assert.match(migration, /plugin_automation_runs_one_dispatching_per_account/)
    assert.match(migration, /WHERE deleted_at IS NULL/)
    assert.match(
      migration,
      /'reserved','generating','ready','dispatching','succeeded','skipped','failed','unknown'/,
    )
    assert.match(
      migration,
      /status <> 'dispatching'[\s\S]*dispatch_armed_at IS NOT NULL[\s\S]*dispatch_owner_token IS NOT NULL/,
    )
  })

  test('accepts only the exact no-tools reply decision contract', () => {
    assert.deepEqual(parseKnowledgePlanetAutomationDecisionForTest('{"decision":"skip"}'), {
      decision: 'skip',
    })
    assert.deepEqual(
      parseKnowledgePlanetAutomationDecisionForTest('{"decision":"reply","text":"你好"}'),
      { decision: 'reply', text: '你好' },
    )
    assert.equal(
      parseKnowledgePlanetAutomationDecisionForTest(
        '{"decision":"reply","text":"你好","tool":"delete"}',
      ),
      null,
    )
    assert.equal(
      parseKnowledgePlanetAutomationDecisionForTest('{"decision":"skip","text":"hidden"}'),
      null,
    )
    assert.equal(parseKnowledgePlanetAutomationDecisionForTest('not json'), null)
  })

  test('always appends a visible AI disclosure inside the configured character cap', () => {
    const reply = composeKnowledgePlanetAutomationReplyForTest('  这是自动回复正文  ', 100)
    assert.ok(reply)
    assert.ok(reply.endsWith(KNOWLEDGE_PLANET_AUTOMATION_DISCLOSURE))
    assert.ok(reply.length <= 100)
    assert.equal(composeKnowledgePlanetAutomationReplyForTest('', 100), null)
    const truncated = composeKnowledgePlanetAutomationReplyForTest('甲'.repeat(2_000), 120)
    assert.equal(truncated?.length, 120)
    assert.ok(truncated?.endsWith(KNOWLEDGE_PLANET_AUTOMATION_DISCLOSURE))
  })

  test('fails closed for unknown authors, self-authored topics and trigger mismatches', () => {
    const selfId = '123456'
    assert.equal(
      classifyKnowledgePlanetAutomationTopicForTest({}, selfId, 'new_topic'),
      'AUTHOR_UNKNOWN',
    )
    assert.equal(
      classifyKnowledgePlanetAutomationTopicForTest(
        { author: { id: selfId } },
        selfId,
        'new_topic',
      ),
      'SELF_AUTHORED',
    )
    assert.equal(
      classifyKnowledgePlanetAutomationTopicForTest(
        { author: { id: '654321' }, type: 'talk' },
        selfId,
        'new_question',
      ),
      'TRIGGER_MISMATCH',
    )
    assert.equal(
      classifyKnowledgePlanetAutomationTopicForTest(
        { author: { id: '654321' }, question: '请问如何使用？' },
        selfId,
        'new_question',
      ),
      null,
    )
  })

  test('binds a generated reply to the exact projected source content', () => {
    const original = {
      id: '123456',
      createdAt: '2026-07-17T00:00:00.000Z',
      text: '原内容',
      images: [{ id: '111111' }],
    }
    assert.equal(
      knowledgePlanetAutomationSourceDigestForTest(original),
      knowledgePlanetAutomationSourceDigestForTest({
        images: [{ id: '111111' }],
        text: '原内容',
        createdAt: '2026-07-17T00:00:00.000Z',
        id: '123456',
      }),
    )
    assert.notEqual(
      knowledgePlanetAutomationSourceDigestForTest(original),
      knowledgePlanetAutomationSourceDigestForTest({ ...original, text: '已编辑' }),
    )
  })
})
