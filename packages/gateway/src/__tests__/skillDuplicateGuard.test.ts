// The skill library grew to 84 skills for one agent while reads concentrated on
// two of them (2026-07-21..26: 135 skill_view calls, 75% on two names, 20 of the
// stored skills single-incident `*-debug` notes). Saving cost one call; finding
// an existing skill required guessing its exact name. This guard closes that gap.
//
// OPENCLAUDE_HOME must be redirected before storage/paths is evaluated.
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const TEST_HOME = await mkdtemp(join(tmpdir(), 'oc-skill-test-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

const { SkillStore, isSameDomainSkillName, skillNameTokens } = await import('@openclaude/storage')

after(async () => {
  await rm(TEST_HOME, { recursive: true, force: true })
})

describe('skillNameTokens', () => {
  it('splits on hyphens, underscores and spaces', () => {
    assert.deepEqual(skillNameTokens('v5-turn_refund debug'), ['v5', 'turn', 'refund', 'debug'])
  })

  it('is case-insensitive and drops empties', () => {
    assert.deepEqual(skillNameTokens('V5--Turn-'), ['v5', 'turn'])
  })
})

describe('isSameDomainSkillName', () => {
  it('flags the real near-duplicate pair that motivated this guard', () => {
    assert.equal(
      isSameDomainSkillName(
        'v5-turn-refund-idle-timeout-debug',
        'v5-turn-dispatch-sink-staged-debug',
      ),
      true,
      'three shared tokens (v5, turn, debug)',
    )
  })

  it('flags a name that only reorders an existing one', () => {
    assert.equal(isSameDomainSkillName('v5-commercial-deploy', 'deploy-commercial-v5'), true)
  })

  it('does not flag unrelated skills that share one generic prefix', () => {
    assert.equal(isSameDomainSkillName('v5-file-upload-format-debug', 'v5-inbox-broadcast'), false)
    assert.equal(isSameDomainSkillName('zsxq-publish', 'weibo-publish'), false)
  })

  it('does not flag a skill against itself-free empty input', () => {
    assert.equal(isSameDomainSkillName('', 'v5-commercial-deploy'), false)
  })
})

describe('SkillStore.save duplicate guard', () => {
  const store = new SkillStore('guard-test-agent')

  it('accepts the first skill in a fresh domain', async () => {
    const r = await store.save(
      { name: 'v5-turn-dispatch-sink-staged-debug', description: 'first' },
      'body',
    )
    assert.equal(r.ok, true)
  })

  it('rejects a same-domain new skill and names the collision', async () => {
    const r = await store.save(
      { name: 'v5-turn-refund-idle-timeout-debug', description: 'near duplicate' },
      'body',
    )
    assert.equal(r.ok, false)
    assert.deepEqual(r.similar, ['v5-turn-dispatch-sink-staged-debug'])
    assert.match(r.error ?? '', /skill_view/)
  })

  it('never blocks an update to an existing skill', async () => {
    const r = await store.save(
      { name: 'v5-turn-dispatch-sink-staged-debug', description: 'updated' },
      'new body',
    )
    assert.equal(r.ok, true, 'updating in place is the outcome the guard is steering toward')
  })

  it('lets the caller through with an explicit override', async () => {
    const r = await store.save(
      { name: 'v5-turn-refund-idle-timeout-debug', description: 'genuinely different' },
      'body',
      { allowSimilar: true },
    )
    assert.equal(r.ok, true)
  })

  it('still accepts an unrelated new skill without ceremony', async () => {
    const r = await store.save({ name: 'zsxq-publish', description: 'unrelated' }, 'body')
    assert.equal(r.ok, true)
  })

  it('reports similar names through findSimilarSkills without saving', async () => {
    const similar = await store.findSimilarSkills('v5-turn-something-else-debug')
    assert.ok(similar.includes('v5-turn-dispatch-sink-staged-debug'))
    assert.ok(similar.includes('v5-turn-refund-idle-timeout-debug'))
  })
})
