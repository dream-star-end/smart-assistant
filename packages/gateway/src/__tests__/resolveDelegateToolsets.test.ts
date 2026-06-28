import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { capMarketplaceToolsets, resolveDelegateToolsets } from '../toolsetIntent.js'

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

describe('resolveDelegateToolsets — caller cap (RFC D2.7 / Codex BLOCKER#2)', () => {
  it('caps the delegated toolsets to the caller effective set (intersection)', () => {
    // Caller only has ['core']; even though intent (browser) + request (research)
    // would expand the sub-agent, it is capped to what the caller itself has.
    const out = resolveDelegateToolsets(
      coreMember,
      config,
      ['research'],
      '打开网页 https://example.com 并点击登录',
      ['core'],
    )
    assert.deepEqual(out, ['core'])
  })

  it('lets a caller grant a toolset it also has', () => {
    assert.deepEqual(
      resolveDelegateToolsets(coreMember, config, ['research'], '搜集资料', ['core', 'research']),
      ['core', 'research'],
    )
  })

  it('does NOT cap when the caller is unrestricted (undefined = trusted platform default)', () => {
    assert.deepEqual(
      resolveDelegateToolsets(
        coreMember,
        config,
        ['research'],
        '打开网页 https://example.com',
        undefined,
      ),
      ['core', 'browser', 'research'],
    )
  })

  it('caps a no-baseline sub-agent to the caller set instead of mounting all (no bypass)', () => {
    // A capped caller must not be able to escalate by delegating to a no-toolset
    // sub-agent (which would otherwise return undefined = "mount all").
    const noToolsetSub: any = { id: 'x' }
    const noDefaults: any = { toolsets: config.toolsets }
    assert.deepEqual(
      resolveDelegateToolsets(noToolsetSub, noDefaults, ['browser'], 'x', ['core']),
      ['core'],
    )
  })

  it('caps to empty when the caller and sub-agent share nothing', () => {
    // Caller has only ['research']; sub-agent core + browser-by-intent → ∩ research = []
    assert.deepEqual(
      resolveDelegateToolsets(coreMember, config, ['browser'], '打开网页 https://x.com', [
        'research',
      ]),
      [],
    )
  })
})

describe('capMarketplaceToolsets — agent self-path ceiling (RFC D2)', () => {
  it('caps a marketplace agent core-only intent-expansion back to its manifest toolsets', () => {
    // The normal message path would expand ['core'] → ['core','browser'] on a URL,
    // but a marketplace agent must stay within its declared manifest toolsets.
    assert.deepEqual(capMarketplaceToolsets('marketplace', ['core'], ['core', 'browser']), ['core'])
  })

  it('does NOT cap a platform/user agent (no source marker)', () => {
    assert.deepEqual(capMarketplaceToolsets(undefined, ['core'], ['core', 'browser']), [
      'core',
      'browser',
    ])
  })

  it('bounds a marketplace agent even if effective is undefined (mount-all)', () => {
    assert.deepEqual(capMarketplaceToolsets('marketplace', ['core'], undefined), ['core'])
  })
})
