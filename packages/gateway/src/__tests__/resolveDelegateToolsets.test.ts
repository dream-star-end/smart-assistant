import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveDelegateToolsets } from '../toolsetIntent.js'

// Mirrors the in-container config the entrypoint ensures: core (empty marker) +
// browser + research/web_context toolset definitions.
const config: any = {
  defaults: { toolsets: ['core'] },
  toolsets: {
    core: [],
    browser: ['browser'],
    research: ['scansci-pdf', 'web-context'],
    web_context: ['web-context'],
  },
}

const coreMember: any = { id: 'researcher', toolsets: ['core'] }

describe('resolveDelegateToolsets', () => {
  it('keeps a non-empty baseline when there is no intent and no request', () => {
    // The whole point post-migration: a core-only member never returns undefined
    // (which would mean "mount all"), and a generic goal adds nothing.
    assert.deepEqual(
      resolveDelegateToolsets(coreMember, config, undefined, '汇总分析黄金市场资料'),
      ['core'],
    )
  })

  it('grants browser on demand from interactive browser intent (symmetry with WS path)', () => {
    assert.deepEqual(
      resolveDelegateToolsets(coreMember, config, undefined, '打开网页 https://example.com 并点击登录'),
      ['core', 'browser'],
    )
  })

  it('grants web_context on demand from URL extraction intent', () => {
    assert.deepEqual(
      resolveDelegateToolsets(coreMember, config, undefined, '帮我读取这个链接 https://example.com/report'),
      ['core', 'web_context'],
    )
  })

  it('honors an explicit leader request as an additive grant of a DEFINED toolset', () => {
    // Intent ("搜集资料") does not trigger auto-mount, but the leader explicitly
    // asked for research → granted additively because it's defined in config.
    assert.deepEqual(
      resolveDelegateToolsets(coreMember, config, ['research'], '搜集黄金市场资料'),
      ['core', 'research'],
    )
  })

  it('ignores an unknown/undefined requested toolset instead of failing', () => {
    // The old code returned a hard 400 "delegate toolsets not allowed"; now an
    // unknown name is simply dropped and the baseline survives.
    assert.deepEqual(
      resolveDelegateToolsets(coreMember, config, ['totally-made-up'], '搜集资料'),
      ['core'],
    )
  })

  it('treats an empty / non-array request as no request (never fatal)', () => {
    assert.deepEqual(resolveDelegateToolsets(coreMember, config, [], '搜集资料'), ['core'])
    assert.deepEqual(resolveDelegateToolsets(coreMember, config, 'nope', '搜集资料'), ['core'])
  })

  it('does not duplicate a requested toolset already in the resolved set', () => {
    assert.deepEqual(
      resolveDelegateToolsets(coreMember, config, ['core', 'research'], '搜集资料'),
      ['core', 'research'],
    )
  })

  it('combines intent + leader request additively, never escalating to all-tools', () => {
    const out = resolveDelegateToolsets(
      coreMember,
      config,
      ['research'],
      '打开网页 https://example.com 并点击登录',
    )
    assert.deepEqual(out, ['core', 'browser', 'research'])
    // A configured baseline must never collapse to undefined ("mount all").
    assert.notEqual(out, undefined)
  })

  it('falls back to config.defaults.toolsets as the baseline when the member has none', () => {
    const member: any = { id: 'researcher' } // no toolsets
    assert.deepEqual(resolveDelegateToolsets(member, config, ['research'], '搜集资料'), [
      'core',
      'research',
    ])
  })

  it('returns undefined (inherit / mount all) only when neither member nor defaults configure toolsets', () => {
    const member: any = { id: 'researcher' }
    const noDefaults: any = { toolsets: config.toolsets }
    assert.equal(resolveDelegateToolsets(member, noDefaults, ['research'], '搜集资料'), undefined)
  })

  it('does not mutate the member toolsets array', () => {
    const member: any = { id: 'researcher', toolsets: ['core'] }
    resolveDelegateToolsets(member, config, ['research'], '打开网页 https://example.com')
    assert.deepEqual(member.toolsets, ['core'], 'member.toolsets must stay unchanged')
  })
})
