/**
 * Tests for the strict agent manifest allowlist validator (RFC M3 / D2).
 *
 * Run: npx tsx --test packages/commercial/src/marketplace/__tests__/agentManifest.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  VETTED_AGENT_TOOLSETS,
  canonicalizeAgentManifest,
  validateAgentManifest,
} from '../agentManifest.js'

const allowedModels = new Set(['glm-5.2', 'deepseek-v4', 'gpt-5.6-sol'])
const opts = { vettedToolsets: VETTED_AGENT_TOOLSETS, allowedModels }

function base(): Record<string, unknown> {
  return {
    name: '研究助手',
    description: '帮你查文献',
    version: '1.0.0',
    model: 'glm-5.2',
    toolsets: ['core', 'research'],
    skillDeps: ['academic-translate'],
    persona: '你是一个严谨的研究助手。',
  }
}

describe('validateAgentManifest', () => {
  it('accepts a well-formed manifest and normalizes it', () => {
    const r = validateAgentManifest(base(), opts)
    assert.ok(r.ok)
    if (r.ok) {
      assert.equal(r.manifest.name, '研究助手')
      assert.deepEqual(r.manifest.toolsets, ['core', 'research'])
      assert.deepEqual(r.manifest.skillDeps, ['academic-translate'])
      assert.deepEqual(r.manifest.capabilities, [
        { kind: 'skill', slug: 'academic-translate', optional: false },
      ])
    }
  })

  it('rejects forbidden privilege-bearing fields', () => {
    for (const f of [
      'mcpServers',
      'cwd',
      'provider',
      'runnerKind',
      'permissionMode',
      'routes',
      'teams',
    ]) {
      const r = validateAgentManifest({ ...base(), [f]: 'x' }, opts)
      assert.equal(r.ok, false, `${f} must be rejected`)
    }
  })

  it('rejects unknown fields', () => {
    const r = validateAgentManifest({ ...base(), surprise: 1 }, opts)
    assert.equal(r.ok, false)
  })

  it('rejects a stray "slug" field (the publish route MUST strip it before validating)', () => {
    // Guards the M3 bug where the route set slug=undefined instead of deleting it.
    const r = validateAgentManifest({ ...base(), slug: 'my-agent' }, opts)
    assert.equal(r.ok, false)
  })

  it('requires a non-empty toolsets list (never default-all)', () => {
    assert.equal(validateAgentManifest({ ...base(), toolsets: [] }, opts).ok, false)
    const noToolsets = base()
    noToolsets.toolsets = undefined
    assert.equal(validateAgentManifest(noToolsets, opts).ok, false)
  })

  it('rejects a toolset not in the vetted set', () => {
    const r = validateAgentManifest({ ...base(), toolsets: ['core', 'rootkit'] }, opts)
    assert.equal(r.ok, false)
  })

  it('rejects a model outside the allowed set', () => {
    const r = validateAgentManifest({ ...base(), model: 'gpt-9-fictional' }, opts)
    assert.equal(r.ok, false)
  })

  it('accepts public GPT-5.6 models', () => {
    const r = validateAgentManifest({ ...base(), model: 'gpt-5.6-sol' }, opts)
    assert.equal(r.ok, true)
  })

  it('requires an inline persona', () => {
    const m = base()
    m.persona = undefined
    assert.equal(validateAgentManifest(m, opts).ok, false)
  })

  it('rejects a non-slug skillDep', () => {
    const r = validateAgentManifest({ ...base(), skillDeps: ['Bad Slug!'] }, opts)
    assert.equal(r.ok, false)
  })

  it('accepts typed Skill and Plugin capabilities and derives legacy skillDeps', () => {
    const raw = base()
    raw.skillDeps = undefined
    raw.capabilities = [
      { kind: 'skill', slug: 'academic-translate' },
      { kind: 'plugin', slug: 'paper-search', optional: true },
    ]
    const r = validateAgentManifest(raw, { ...opts, artifactSlug: 'research-agent' })
    assert.ok(r.ok)
    if (r.ok) {
      assert.deepEqual(r.manifest.capabilities, [
        { kind: 'skill', slug: 'academic-translate', optional: false },
        { kind: 'plugin', slug: 'paper-search', optional: true },
      ])
      assert.deepEqual(r.manifest.skillDeps, ['academic-translate'])
      const canonical = JSON.parse(canonicalizeAgentManifest(r.manifest))
      assert.deepEqual(canonical.skillDeps, ['academic-translate'])
      assert.equal(canonical.capabilities[1].kind, 'plugin')
    }
  })

  it('rejects conflicting compatibility projections', () => {
    const r = validateAgentManifest(
      {
        ...base(),
        capabilities: [{ kind: 'skill', slug: 'different-skill' }],
      },
      opts,
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.ok(r.errors.some((error) => error.includes('不一致')))
  })

  it('rejects duplicate, self, malformed and excessive capability references', () => {
    const duplicate = validateAgentManifest(
      {
        ...base(),
        skillDeps: undefined,
        capabilities: [
          { kind: 'skill', slug: 'same-skill' },
          { kind: 'skill', slug: 'same-skill' },
        ],
      },
      { ...opts, artifactSlug: 'my-agent' },
    )
    assert.equal(duplicate.ok, false)
    assert.equal(
      validateAgentManifest(
        { ...base(), skillDeps: undefined, capabilities: [{ kind: 'plugin', slug: 'my-agent' }] },
        { ...opts, artifactSlug: 'my-agent' },
      ).ok,
      false,
    )
    assert.equal(
      validateAgentManifest(
        {
          ...base(),
          skillDeps: undefined,
          capabilities: [{ kind: 'plugin', slug: 'paper-search', optional: 'sometimes' }],
        },
        opts,
      ).ok,
      false,
    )
    assert.equal(
      validateAgentManifest(
        {
          ...base(),
          skillDeps: undefined,
          capabilities: Array.from({ length: 33 }, (_, i) => ({
            kind: 'skill',
            slug: `skill-${i}`,
          })),
        },
        opts,
      ).ok,
      false,
    )
  })

  it('rejects a bad version', () => {
    assert.equal(validateAgentManifest({ ...base(), version: 'v1' }, opts).ok, false)
  })

  it('canonicalizes deterministically (stable key order)', () => {
    const r1 = validateAgentManifest(base(), opts)
    const r2 = validateAgentManifest(base(), opts)
    assert.ok(r1.ok && r2.ok)
    if (r1.ok && r2.ok) {
      assert.equal(canonicalizeAgentManifest(r1.manifest), canonicalizeAgentManifest(r2.manifest))
    }
  })

  it('preserves legacy canonical bytes when there are no capabilities', () => {
    const r = validateAgentManifest({ ...base(), skillDeps: [] }, opts)
    assert.ok(r.ok)
    if (r.ok) {
      const canonical = JSON.parse(canonicalizeAgentManifest(r.manifest))
      assert.equal(Object.hasOwn(canonical, 'capabilities'), false)
      assert.deepEqual(canonical.skillDeps, [])
    }
  })
})
