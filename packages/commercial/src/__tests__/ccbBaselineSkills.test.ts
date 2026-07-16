/**
 * Guards the strict baseline-mount invariant: resolveCcbBaselineMounts() rejects
 * any skills/ dir that doesn't EXACTLY match V3_CCB_BASELINE_SKILL_NAMES, so a
 * shipped skill missing from the manifest (or vice-versa) fail-closes container
 * provisioning. This test catches that drift at build time (it bit M-market:
 * adding skills/market/ without listing it in the manifest).
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/ccbBaselineSkills.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { parseSkillEvalsJson } from '@openclaude/storage'

import { V3_CCB_BASELINE_SKILL_NAMES } from '../agent-sandbox/v3supervisor.js'

const here = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(here, '..', '..', 'agent-sandbox', 'ccb-baseline', 'skills')

describe('ccb-baseline skills ↔ manifest', () => {
  it('the shipped skills/ dir matches V3_CCB_BASELINE_SKILL_NAMES exactly', () => {
    const onDisk = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    const manifest = [...V3_CCB_BASELINE_SKILL_NAMES].sort()
    assert.deepEqual(
      onDisk,
      manifest,
      `baseline skills dir must match the manifest exactly (provisioning fail-closes otherwise).\n on-disk: ${onDisk.join(', ')}\n manifest: ${manifest.join(', ')}`,
    )
  })

  it('every skill dir contains exactly SKILL.md (optionally plus evals/evals.json)', () => {
    for (const name of V3_CCB_BASELINE_SKILL_NAMES) {
      const entries = readdirSync(join(skillsDir, name)).sort()
      const shapeOk =
        (entries.length === 1 && entries[0] === 'SKILL.md') ||
        (entries.length === 2 && entries[0] === 'SKILL.md' && entries[1] === 'evals')
      assert.ok(
        shapeOk,
        `skill ${name} must contain exactly SKILL.md (optionally plus evals/), got: ${entries.join(', ')}`,
      )
      if (entries.includes('evals')) {
        const evalEntries = readdirSync(join(skillsDir, name, 'evals'))
        assert.deepEqual(
          evalEntries,
          ['evals.json'],
          `skill ${name}/evals must contain exactly evals.json`,
        )
      }
    }
  })

  it('every shipped evals.json parses under the platform schema (bad JSON fail-closes provisioning review)', () => {
    for (const name of V3_CCB_BASELINE_SKILL_NAMES) {
      const evalsPath = join(skillsDir, name, 'evals', 'evals.json')
      let raw: string
      try {
        raw = readFileSync(evalsPath, 'utf8')
      } catch {
        continue // 无 evals 是合法形态
      }
      const parsed = parseSkillEvalsJson(raw)
      assert.ok(
        parsed.ok,
        `skill ${name} evals.json invalid: ${parsed.ok ? '' : parsed.errors.join('; ')}`,
      )
    }
  })

  it('includes the market skill (AI marketplace ops)', () => {
    assert.ok((V3_CCB_BASELINE_SKILL_NAMES as readonly string[]).includes('market'))
  })

  it('ships the connector authoring workflow with its authority and safety gates', () => {
    assert.ok(
      (V3_CCB_BASELINE_SKILL_NAMES as readonly string[]).includes('connector-authoring'),
    )
    const body = readFileSync(join(skillsDir, 'connector-authoring', 'SKILL.md'), 'utf8')
    assert.match(body, /oc-market plugin examples/)
    assert.match(body, /oc-market plugin validate --file/)
    assert.match(body, /validationHash/)
    assert.match(body, /publishCommand/)
    assert.doesNotMatch(body, /--security-decision-file/)
    assert.match(body, /不得[^。]*真实密码/)
    assert.match(body, /确认/)
  })
})
