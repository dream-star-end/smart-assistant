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
    }
  })

  it('rejects forbidden privilege-bearing fields', () => {
    for (const f of ['mcpServers', 'cwd', 'provider', 'runnerKind', 'permissionMode', 'routes', 'teams']) {
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
})
