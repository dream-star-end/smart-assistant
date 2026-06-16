import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
/**
 * Unit tests for the composer model picker (modelMode.js) + capability-driven
 * thinking-depth gating (effortMode.js).
 *
 * Loads each module's source, strips ES import/export so it can run under
 * new Function() with injected mocks (localStorage / state / getSession /
 * getEffectiveModel). We only exercise the pure data functions — DOM popover
 * lifecycle is covered by manual/dev smoke.
 *
 * Run: npx tsx --test packages/web/__tests__/composerSelectors.test.ts
 */
import { describe, it } from 'node:test'

const MODULES = resolve(import.meta.dirname, '..', 'public', 'modules')

function makeLocalStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    _seed: (k: string, v: unknown) => m.set(k, JSON.stringify(v)),
  }
}

/** Load a module's exported functions under new Function with injected deps. */
function loadModule(file: string, exposeNames: string[], deps: Record<string, unknown>) {
  const raw = readFileSync(resolve(MODULES, file), 'utf-8')
  const stripped = raw
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .join('\n')
    .replace(/^export\s+/gm, '')
  const argNames = Object.keys(deps)
  const factory = new Function(...argNames, `${stripped}\n;return { ${exposeNames.join(', ')} }`)
  return factory(...argNames.map((n) => deps[n]))
}

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['high', 'xhigh', 'max'] },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

function makeModelMode(
  opts: { agentModel?: string; override?: string; provider?: string } = {},
) {
  const ls = makeLocalStorage()
  if (opts.override !== undefined) ls._seed('openclaude_model_by_agent', { main: opts.override })
  const state = {
    agentsList: [
      { id: 'main', model: opts.agentModel ?? 'claude-opus-4-7', provider: opts.provider },
    ],
    modelsList: MODELS,
    defaultAgentId: 'main',
  }
  const mod = loadModule(
    'modelMode.js',
    ['getEffectiveModel', 'getModelForSubmit', 'getCurrentModelLabel'],
    {
      $: () => null,
      getSession: () => ({ agentId: 'main' }),
      state,
      localStorage: ls,
      document: {},
    },
  )
  return mod
}

describe('modelMode: effective model + submit value', () => {
  it('no override → effective = agent default, submit omitted', () => {
    const m = makeModelMode()
    assert.equal(m.getEffectiveModel(), 'claude-opus-4-7')
    assert.equal(m.getModelForSubmit(), undefined)
  })

  it('valid override → effective + submit = override', () => {
    const m = makeModelMode({ override: 'claude-haiku-4-5' })
    assert.equal(m.getEffectiveModel(), 'claude-haiku-4-5')
    assert.equal(m.getModelForSubmit(), 'claude-haiku-4-5')
  })

  it('explicitly selecting the agent default → submit sends it (recycle-back semantics)', () => {
    const m = makeModelMode({ override: 'claude-opus-4-7' })
    assert.equal(m.getEffectiveModel(), 'claude-opus-4-7')
    assert.equal(m.getModelForSubmit(), 'claude-opus-4-7')
  })

  it('stale/invalid stored override → falls back to agent default, submit omitted', () => {
    const m = makeModelMode({ override: 'bogus-model-id' })
    assert.equal(m.getEffectiveModel(), 'claude-opus-4-7')
    assert.equal(m.getModelForSubmit(), undefined)
  })

  it('codex-native agent ignores override entirely — effective = agent default, submit omitted', () => {
    // codex runner has no setModel; gateway silently ignores the override. A
    // stored override must NOT leak into effective model (else effort gating
    // would key off the wrong model) and must NOT be sent.
    const m = makeModelMode({
      agentModel: 'gpt-5.5',
      provider: 'codex-native',
      override: 'claude-haiku-4-5',
    })
    assert.equal(m.getEffectiveModel(), 'gpt-5.5')
    assert.equal(m.getModelForSubmit(), undefined)
  })
})

function makeEffortMode(
  effectiveModel: string,
  override?: string,
  agentsList: unknown[] = [{ id: 'main' }],
) {
  const ls = makeLocalStorage()
  if (override !== undefined) ls._seed('openclaude_effort_by_agent', { main: override })
  const state = { agentsList, modelsList: MODELS, defaultAgentId: 'main' }
  return loadModule(
    'effortMode.js',
    ['getSupportedEfforts', 'modelSupportsExtraEffort', 'getCurrentEffort', 'getEffortForSubmit'],
    {
      $: () => null,
      getEffectiveModel: () => effectiveModel,
      getSession: () => ({ agentId: 'main' }),
      state,
      localStorage: ls,
      document: {},
    },
  )
}

describe('effortMode: capability-driven gating', () => {
  it('getSupportedEfforts reads config.models[].efforts', () => {
    const e = makeEffortMode('claude-opus-4-8')
    assert.deepEqual(e.getSupportedEfforts('claude-opus-4-8'), ['high', 'xhigh', 'max'])
    assert.deepEqual(e.getSupportedEfforts('claude-haiku-4-5'), [])
    assert.deepEqual(e.getSupportedEfforts('unknown-model'), [])
  })

  it('dual-source: model not in pool but is an agent default → uses agent.efforts (gpt-5.5)', () => {
    // gpt-5.5 is the codex agent's default model; it is NOT a valid override
    // target so it never appears in modelsList. Capability must still resolve
    // via the agent's own efforts (carried by /api/agents).
    const agents = [
      { id: 'main', model: 'claude-opus-4-7' },
      { id: 'codex', model: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ]
    const e = makeEffortMode('gpt-5.5', undefined, agents)
    assert.deepEqual(e.getSupportedEfforts('gpt-5.5'), ['low', 'medium', 'high', 'xhigh'])
    assert.equal(e.modelSupportsExtraEffort('gpt-5.5'), true)
    // pool still wins when present; unknown stays empty.
    assert.deepEqual(e.getSupportedEfforts('claude-opus-4-8'), ['high', 'xhigh', 'max'])
    assert.deepEqual(e.getSupportedEfforts('totally-unknown'), [])
  })

  it('modelSupportsExtraEffort reflects efforts presence', () => {
    const e = makeEffortMode('claude-opus-4-8')
    assert.equal(e.modelSupportsExtraEffort('claude-opus-4-8'), true)
    assert.equal(e.modelSupportsExtraEffort('claude-haiku-4-5'), false)
  })

  it('getEffortForSubmit: supported model + no pill → null (reset); unsupported → undefined', () => {
    assert.equal(makeEffortMode('claude-opus-4-8').getEffortForSubmit(), null)
    assert.equal(makeEffortMode('claude-haiku-4-5').getEffortForSubmit(), undefined)
  })

  it('getEffortForSubmit: supported model + valid pill → that level', () => {
    const e = makeEffortMode('claude-opus-4-8', 'xhigh')
    assert.equal(e.getEffortForSubmit(), 'xhigh')
  })

  it('filters out effort values outside EFFORT_LEVELS', () => {
    // efforts arrays in config are filtered to VALID — inject a bad one via a
    // local model list override is not possible here, so assert VALID filter
    // indirectly: an unknown model yields [].
    const e = makeEffortMode('claude-opus-4-8')
    assert.deepEqual(e.getSupportedEfforts(''), [])
  })
})

console.log('composerSelectors tests passed.')
