/**
 * Admin users must not receive marked platform-baseline restriction blocks.
 * Run: npx tsx --test src/__tests__/promptSlotsAdminRestrict.test.ts
 */
import * as assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  BASELINE_RESTRICT_END,
  BASELINE_RESTRICT_START,
  resolvePromptUserRole,
  stripBaselineRestrictions,
} from '../promptSlots.js'

describe('resolvePromptUserRole', () => {
  const saved = process.env.OC_USER_ROLE
  after(() => {
    if (saved === undefined) delete process.env.OC_USER_ROLE
    else process.env.OC_USER_ROLE = saved
  })

  it('defaults to user', () => {
    delete process.env.OC_USER_ROLE
    assert.equal(resolvePromptUserRole(), 'user')
    assert.equal(resolvePromptUserRole({}), 'user')
    assert.equal(resolvePromptUserRole({ userRole: 'user' }), 'user')
  })

  it('accepts ctx.userRole=admin over env', () => {
    process.env.OC_USER_ROLE = 'user'
    assert.equal(resolvePromptUserRole({ userRole: 'admin' }), 'admin')
  })

  it('reads OC_USER_ROLE=admin when ctx omitted', () => {
    process.env.OC_USER_ROLE = 'admin'
    assert.equal(resolvePromptUserRole(), 'admin')
  })

  it('treats unknown env as user', () => {
    process.env.OC_USER_ROLE = 'owner'
    assert.equal(resolvePromptUserRole(), 'user')
  })
})

describe('stripBaselineRestrictions', () => {
  it('is a no-op without markers', () => {
    assert.equal(stripBaselineRestrictions('hello\n'), 'hello\n')
  })

  it('removes a marked restriction block', () => {
    const src = [
      'keep-before',
      BASELINE_RESTRICT_START,
      '你不做什么',
      BASELINE_RESTRICT_END,
      'keep-after',
      '',
    ].join('\n')
    const out = stripBaselineRestrictions(src)
    assert.ok(out.includes('keep-before'))
    assert.ok(out.includes('keep-after'))
    assert.ok(!out.includes('你不做什么'))
    assert.ok(!out.includes(BASELINE_RESTRICT_START))
  })

  it('leaves text unchanged when markers are unbalanced', () => {
    const src = `${BASELINE_RESTRICT_START}\norphan\n`
    assert.equal(stripBaselineRestrictions(src), src)
  })
})
