import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  formatCrossFamilyError,
  isWeakAuditModel,
  resolveModelFamily,
  verifyCrossFamilyAudit,
} from '../check-cross-family-audit.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.join(ROOT, 'scripts/check-cross-family-audit.ts')

describe('check-cross-family-audit: family normalization', () => {
  test('normalizes all platform model families across routing prefixes & protocol engineModels aliases', () => {
    assert.equal(resolveModelFamily('gpt-6.2-astra'), 'openai-gpt')
    assert.equal(resolveModelFamily('openai/gpt-6.2-sol-1m'), 'openai-gpt')
    assert.equal(resolveModelFamily('antigravity-gpt-oss-120b'), 'openai-gpt')
    assert.equal(resolveModelFamily('o3-pro'), 'openai-gpt')

    assert.equal(resolveModelFamily('box-api-claude-opus-5-5'), 'anthropic-claude')
    assert.equal(resolveModelFamily('claude-sonnet-5-5'), 'anthropic-claude')
    assert.equal(resolveModelFamily('cursor-haiku-4.5'), 'anthropic-claude')
    assert.equal(resolveModelFamily('cursor-fable-5.1-xhigh'), 'anthropic-claude')

    assert.equal(resolveModelFamily('antigravity-gemini-4-carbon'), 'google-gemini')
    assert.equal(resolveModelFamily('gemini-4-neon'), 'google-gemini')
    assert.equal(resolveModelFamily('google/gemini-2.5-pro'), 'google-gemini')
    // Blocker 6: Antigravity orchestrator aliases map to Gemini via engineModels.ts
    assert.equal(resolveModelFamily('antigravity-orchestrator-carbon'), 'google-gemini')
    assert.equal(resolveModelFamily('antigravity-orchestrator-neon'), 'google-gemini')

    assert.equal(resolveModelFamily('grok-4'), 'xai-grok')
    assert.equal(resolveModelFamily('grok-build'), 'xai-grok')
    assert.equal(resolveModelFamily('deepseek-v4-pro'), 'deepseek')
    assert.equal(resolveModelFamily('kimi-k2.7-code'), 'moonshot-kimi')
    assert.equal(resolveModelFamily('glm-5.3'), 'zhipu-glm')
    assert.equal(resolveModelFamily('zcode-experimental'), 'zhipu-glm')
    assert.equal(resolveModelFamily('MiniMax-M3'), 'minimax')
    assert.equal(resolveModelFamily('qwen3.7'), 'qwen')
    assert.equal(resolveModelFamily('step-3'), 'step')
    assert.equal(resolveModelFamily('mimo-v2-pro'), 'mimo')
    assert.equal(resolveModelFamily('cursor-composer-2.5'), 'cursor-composer')

    // Dynamic/unknown routers MUST fail closed (null)
    assert.equal(resolveModelFamily('cursor-auto'), null)
    assert.equal(resolveModelFamily('mystery-llm-9000'), null)
    assert.equal(resolveModelFamily(''), null)
  })
})

describe('check-cross-family-audit: policy enforcement (red & green)', () => {
  test('PASS: cross-family strong model pairs including antigravity-orchestrator-carbon', () => {
    const r1 = verifyCrossFamilyAudit('antigravity-gemini-4-neon', 'gpt-6.2-astra')
    assert.equal(r1.ok, true)
    assert.equal(r1.devFamily, 'google-gemini')
    assert.equal(r1.auditFamily, 'openai-gpt')

    const rOrch = verifyCrossFamilyAudit('antigravity-orchestrator-carbon', 'gpt-6.2-astra')
    assert.equal(rOrch.ok, true)
    assert.equal(rOrch.devFamily, 'google-gemini')
    assert.equal(rOrch.auditFamily, 'openai-gpt')

    const r2 = verifyCrossFamilyAudit('gpt-6.2-sol', 'antigravity-gemini-4-carbon')
    assert.equal(r2.ok, true)
    assert.equal(r2.devFamily, 'openai-gpt')
    assert.equal(r2.auditFamily, 'google-gemini')

    const r3 = verifyCrossFamilyAudit('box-api-claude-opus-5-5', 'gpt-6.2-astra')
    assert.equal(r3.ok, true)

    // Ensure MiniMax-M3 is NOT falsely treated as weak (`-mini`)
    assert.equal(isWeakAuditModel('MiniMax-M3'), false)
    const r4 = verifyCrossFamilyAudit('gpt-6.2-astra', 'MiniMax-M3')
    assert.equal(r4.ok, true)
  })

  test('RED: blocks same-family self-review (including antigravity-orchestrator-carbon vs antigravity-gemini-4-carbon)', () => {
    const rGpt = verifyCrossFamilyAudit('gpt-6.2-sol', 'gpt-6.2-astra')
    assert.equal(rGpt.ok, false)
    assert.deepEqual(
      rGpt.violations.map((v) => v.code),
      ['CROSS-FAMILY-SAME-FAMILY-AUDIT'],
    )
    const errGpt = formatCrossFamilyError(rGpt)
    assert.match(errGpt, /\[GATE-ERROR\] CROSS-FAMILY-SAME-FAMILY-AUDIT/)
    assert.match(errGpt, /memory\/2026-11-04-delegate-model-pool\.md/)
    assert.match(errGpt, /antigravity-gemini-4-carbon/)

    const rGem = verifyCrossFamilyAudit('gemini-4-neon', 'gemini-4-carbon')
    assert.equal(rGem.ok, false)
    assert.deepEqual(
      rGem.violations.map((v) => v.code),
      ['CROSS-FAMILY-SAME-FAMILY-AUDIT'],
    )
    const errGem = formatCrossFamilyError(rGem)
    assert.match(errGem, /gpt-6\.2-astra/)

    const rOrchSame = verifyCrossFamilyAudit(
      'antigravity-orchestrator-carbon',
      'antigravity-gemini-4-carbon',
    )
    assert.equal(rOrchSame.ok, false)
    assert.deepEqual(
      rOrchSame.violations.map((v) => v.code),
      ['CROSS-FAMILY-SAME-FAMILY-AUDIT'],
    )
  })

  test('RED: blocks weak/lightweight model auditing T2 (e.g. deepseek-v4-flash, claude-haiku, gpt-5-mini, gemini-3.8-flash)', () => {
    for (const weak of [
      'deepseek-v4-flash',
      'box-api-claude-haiku-5-5',
      'gpt-5-mini',
      'gemini-2.5-flash-lite',
      'antigravity-gemini-3.8-flash',
      'glm-5.3-flash',
      'grok-build-fast',
      'grok-code-fast',
    ]) {
      const r = verifyCrossFamilyAudit('kimi-k2.7-code', weak)
      assert.equal(r.ok, false, `expected ${weak} to be rejected as weak audit model`)
      assert.ok(
        r.violations.some((v) => v.code === 'CROSS-FAMILY-WEAK-AUDIT-MODEL'),
        `expected CROSS-FAMILY-WEAK-AUDIT-MODEL for ${weak}`,
      )
    }
  })

  test('RED: fail-closed on unknown or dynamic-routing model slug', () => {
    const rDev = verifyCrossFamilyAudit('unknown-model-x', 'gpt-6.2-astra')
    assert.equal(rDev.ok, false)
    assert.deepEqual(
      rDev.violations.map((v) => v.code),
      ['CROSS-FAMILY-UNKNOWN-MODEL'],
    )

    const rAudit = verifyCrossFamilyAudit('gpt-6.2-astra', 'custom-private-v1')
    assert.equal(rAudit.ok, false)
    assert.deepEqual(
      rAudit.violations.map((v) => v.code),
      ['CROSS-FAMILY-UNKNOWN-MODEL'],
    )

    const rAuto = verifyCrossFamilyAudit('gpt-6.2-astra', 'cursor-auto')
    assert.equal(rAuto.ok, false)
    assert.deepEqual(
      rAuto.violations.map((v) => v.code),
      ['CROSS-FAMILY-UNKNOWN-MODEL'],
    )
  })

  test('CLI supports --dev-model/--audit-model, --receipt JSON, and strictly rejects combining --receipt with CLI model flags', (t) => {
    const tsxBin = path.join(ROOT, 'node_modules/.bin/tsx')

    const rOk = spawnSync(
      tsxBin,
      [SCRIPT, '--dev-model', 'antigravity-orchestrator-carbon', '--audit-model', 'gpt-6.2-astra'],
      { encoding: 'utf8' },
    )
    assert.equal(rOk.status, 0)
    assert.match(rOk.stdout, /\[cross-family-audit\] ok:/)

    const rSame = spawnSync(
      tsxBin,
      [SCRIPT, '--dev-model', 'gpt-6.2-sol', '--audit-model', 'gpt-6.2-astra'],
      { encoding: 'utf8' },
    )
    assert.equal(rSame.status, 1)
    assert.match(rSame.stderr, /\[GATE-ERROR\] CROSS-FAMILY-SAME-FAMILY-AUDIT/)

    const dir = mkdtempSync(path.join(tmpdir(), 'cross-family-receipt-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const okReceipt = path.join(dir, 'ok.json')
    const badReceipt = path.join(dir, 'bad.json')
    writeFileSync(
      okReceipt,
      JSON.stringify({ dev_model: 'gpt-6.2-astra', audit_model: 'antigravity-gemini-4-carbon' }),
    )
    writeFileSync(
      badReceipt,
      JSON.stringify({ devModel: 'antigravity-gemini-4-neon', auditModel: 'deepseek-v4-flash' }),
    )

    const rRecOk = spawnSync(tsxBin, [SCRIPT, '--receipt', okReceipt], { encoding: 'utf8' })
    assert.equal(rRecOk.status, 0)

    const rRecBad = spawnSync(tsxBin, [SCRIPT, '--receipt', badReceipt], { encoding: 'utf8' })
    assert.equal(rRecBad.status, 1)
    assert.match(rRecBad.stderr, /\[GATE-ERROR\] CROSS-FAMILY-WEAK-AUDIT-MODEL/)

    // Blocker 6: combining --receipt with --audit-model or --dev-model MUST fail closed with exit 2
    const rConflict = spawnSync(
      tsxBin,
      [SCRIPT, '--receipt', badReceipt, '--audit-model', 'gpt-6.2-astra'],
      { encoding: 'utf8' },
    )
    assert.equal(rConflict.status, 2)
    assert.match(rConflict.stderr, /mutually exclusive/)
  })
})
