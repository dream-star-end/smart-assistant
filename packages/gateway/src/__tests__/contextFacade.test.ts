/**
 * OpenViking P1 (B1): gateway-only context authority + façade.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/contextFacade.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'oc-context-facade-'))
process.env.OPENCLAUDE_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const { contextAccess } = await import('@openclaude/storage')
const { ContextAuthorityRegistry } = await import('../contextAuthority.js')
const { buildMemoryContextView, contextFacadeEnabled, readGatewayContext, readTurnContext } = await import('../contextFacade.js')

const here = dirname(fileURLToPath(import.meta.url))
const INDEX = '<!-- oc-memdir-index v1 -->\n- [Prefers tabs](feedback_tabs.md) — use tabs\n'

function registry() {
  let id = 0
  let clock = 1_000
  const r = new ContextAuthorityRegistry({ randomId: () => `id-${++id}`, now: () => clock, domainId: 'd', root: home })
  return { r, tick: (ms: number) => { clock += ms }, now: () => clock }
}
const turnInput = (extra: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  agentId: 'main',
  chatProjectId: null,
  memoryPolicy: { allowed: true, reason: 'on_demand_session' as const },
  promptPrivacyFingerprint: 'privacy-a',
  ...extra,
})
const reader = (text: string | null, onRead?: () => void) => () => ({
  renderForInjectionReadonly: async () => { onRead?.(); return text },
})

describe('ContextAuthorityRegistry', () => {
  it('A2: a fresh random turnId per submit; rotate retires the earlier authority', () => {
    const { r, now } = registry()
    const turn = r.beginTurn(turnInput())
    const first = r.mintTurn('s1')
    assert.ok(first)
    assert.equal(first.authority.turnId, turn.turnId)
    assert.equal(contextAccess(first.authority, { enabled: true, today: '2026-10-28', now }).allowed, true)
    turn.rotate()
    assert.notEqual(turn.turnId, first.authority.turnId)
    assert.equal(first.authority.revoked, true)
    assert.deepEqual(contextAccess(first.authority, { enabled: true, today: '2026-10-28', now }),
      { allowed: false, reason: 'authority_unavailable' })
    const second = r.mintTurn('s1')
    assert.equal(second?.authority.revoked, false)
    turn.end()
    const next = r.beginTurn(turnInput())
    assert.notEqual(next.turnId, turn.turnId)
  })

  it('A3/A4: stop retires the turn; a later turn of the same session never revives it', () => {
    const { r } = registry()
    const t1 = r.beginTurn(turnInput())
    const old = r.mintTurn('s1')
    assert.ok(old)
    t1.end()
    assert.equal(r.mintTurn('s1'), null)
    assert.equal(old.authority.revoked, true)
    r.beginTurn(turnInput({ chatProjectId: 'project-b' }))
    assert.equal(old.authority.revoked, true, 'project rebind on the next turn must not revive a stopped authority')
    const fresh = r.mintTurn('s1')
    assert.ok(fresh)
    assert.notEqual(fresh.authority.authorityEpoch, old.authority.authorityEpoch)
  })

  it('A3: identity alias change bumps the agent generation for live and panel authorities', () => {
    const { r } = registry()
    r.beginTurn(turnInput({ identity: { fingerprint: 'alias-1' } }))
    const panel = r.mintPanel('main')
    const live = r.mintTurn('s1')
    assert.ok(live)
    r.beginTurn(turnInput({ sessionId: 's2', identity: { fingerprint: 'alias-2' } }))
    assert.equal(panel.revoked, true)
    assert.equal(live.authority.revoked, true)
    assert.equal(r.mintPanel('main').revoked, false)
    r.bumpAgent('main')
    assert.equal(r.mintTurn('s2')?.authority.revoked, false, 'a freshly minted authority is current')
  })

  it('policy fingerprint binds memory decision and prompt privacy; other agents are untouched', () => {
    const { r } = registry()
    r.beginTurn(turnInput())
    r.beginTurn(turnInput({ sessionId: 's2', promptPrivacyFingerprint: 'privacy-b' }))
    r.beginTurn(turnInput({ sessionId: 's3', agentId: 'other' }))
    const a = r.mintTurn('s1')?.authority
    const b = r.mintTurn('s2')?.authority
    assert.ok(a && b)
    assert.notEqual(a.policyFingerprint, b.policyFingerprint)
    assert.deepEqual(r.activeTurns('main').map((t) => t.sessionId), ['s1', 's2'])
    r.bumpAgent('other')
    assert.equal(a.revoked, false)
  })

  it('authorities are frozen and expire after the read window', () => {
    const { r, tick, now } = registry()
    const panel = r.mintPanel('main')
    assert.throws(() => { (panel as { turnId: string }).turnId = 'forged' })
    tick(120_001)
    assert.deepEqual(contextAccess(panel, { enabled: true, today: '2026-10-28', now }),
      { allowed: false, reason: 'authority_unavailable' })
  })
})

describe('context façade', () => {
  it('panel read returns the core index source under a gateway authority', async () => {
    const { r, now } = registry()
    const result = await readGatewayContext(r.mintPanel('main'), { enabled: true, now, today: '2026-10-28', reader: reader(INDEX) })
    assert.equal(result.status, 'ready')
    assert.equal(result.status === 'ready' && result.sources[0]?.kind, 'core-index')
  })

  it('kill switch: OC_CONTEXT_FACADE=0|off disables; unset enables', async () => {
    assert.equal(contextFacadeEnabled({}), true)
    assert.equal(contextFacadeEnabled({ OC_CONTEXT_FACADE: '0' }), false)
    assert.equal(contextFacadeEnabled({ OC_CONTEXT_FACADE: 'OFF' }), false)
    const { r, now } = registry()
    let reads = 0
    const result = await readGatewayContext(r.mintPanel('main'),
      { enabled: false, now, today: '2026-10-28', reader: reader(INDEX, () => reads++) })
    assert.deepEqual(result, { status: 'unavailable', reason: 'disabled' })
    assert.equal(reads, 0)
  })

  it('CLI callers stay cli_lease_blocked even with the façade on', async () => {
    let reads = 0
    for (const runtime of ['cli-managed', 'cli-unmanaged'] as const) {
      const result = await readGatewayContext({ runtime, lease: { forged: true } } as never,
        { enabled: true, today: '2026-10-28', reader: reader(INDEX, () => reads++) })
      assert.deepEqual(result, { status: 'unavailable', reason: 'cli_lease_blocked' })
    }
    assert.equal(reads, 0)
  })

  it('turn read honours the turn policy: explicit_ignore is denied before any read', async () => {
    const { r, now } = registry()
    r.beginTurn(turnInput({ memoryPolicy: { allowed: false, reason: 'explicit_ignore' } }))
    let reads = 0
    const result = await readTurnContext('s1', { registry: r, enabled: true, now, today: '2026-10-28', reader: reader(INDEX, () => reads++) })
    assert.deepEqual(result, { status: 'unavailable', reason: 'policy_denied' })
    assert.equal(reads, 0)
    assert.equal(await readTurnContext('missing', { registry: r, enabled: true, now, today: '2026-10-28' }), null)
  })

  it('A4: a turn stopped during the async read loses its sources', async () => {
    const { r, now } = registry()
    const turn = r.beginTurn(turnInput())
    const result = await readTurnContext('s1',
      { registry: r, enabled: true, now, today: '2026-10-28', reader: reader(INDEX, () => turn.end()) })
    assert.deepEqual(result, { status: 'unavailable', reason: 'authority_unavailable' })
  })

  it('MemoryPanel view: metadata only, live turns with their policy, CLI marked blocked', async () => {
    const { r, now } = registry()
    r.beginTurn(turnInput({ chatProjectId: 'p1' }))
    r.beginTurn(turnInput({ sessionId: 's2', memoryPolicy: { allowed: false, reason: 'explicit_ignore' } }))
    const view = await buildMemoryContextView('main', { registry: r, enabled: true, now, today: '2026-10-28', reader: reader(INDEX) })
    assert.equal(view.facade, 'enabled')
    assert.equal(view.cli, 'cli_lease_blocked')
    assert.equal(view.mode, 'legacy')
    assert.equal(view.panel.status, 'ready')
    assert.ok(view.panel.status === 'ready')
    assert.deepEqual(Object.keys(view.panel.sources[0]).sort(), ['bytes', 'expires', 'kind', 'locator', 'sourceVersion'])
    assert.ok(view.panel.sources[0].bytes > 0)
    assert.match(view.panel.sources[0].sourceVersion, /^[0-9a-f]{12}$/)
    assert.equal(JSON.stringify(view).includes('Prefers tabs'), false, 'no source content in the view')
    assert.deepEqual(view.turns.map((t) => [t.projectBound, t.memoryPolicy.reason, t.context.status]),
      [[true, 'on_demand_session', 'ready'], [false, 'explicit_ignore', 'unavailable']])
    assert.equal(JSON.stringify(view).includes('id-'), false, 'no turnId or session id leaks to the browser')
    const off = await buildMemoryContextView('main', { registry: r, enabled: false, now, today: '2026-10-28', reader: reader(INDEX) })
    assert.equal(off.facade, 'disabled')
    assert.deepEqual(off.panel, { status: 'unavailable', reason: 'disabled' })
  })
})

describe('sessionSubmit wiring', () => {
  const src = readFileSync(join(here, '..', 'sessionSubmit.ts'), 'utf8')
  const at = (s: string) => {
    const i = src.indexOf(s)
    assert.ok(i > 0, `missing: ${s}`)
    return i
  }
  it('turn authority starts after the policy lease is written and ends before it stops', () => {
    assert.ok(at('contextTurn = contextAuthorities.beginTurn(') > at('memoryTurnPolicyLease = await startMemoryTurnPolicyLease('))
    assert.ok(at("logicalTurnAbort.signal.addEventListener('abort', () => contextTurn?.rotate()") > at('contextTurn = contextAuthorities.beginTurn('))
    assert.ok(at('contextTurn?.end()') < at('await memoryTurnPolicyLease?.stop()'))
    assert.ok(at('contextTurn?.end()') > at('logicalTurnAbort.signal.addEventListener'))
  })
})
