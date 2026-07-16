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

  it('includes the market skill (AI marketplace ops)', () => {
    assert.ok((V3_CCB_BASELINE_SKILL_NAMES as readonly string[]).includes('market'))
  })

  it('ships the connector authoring workflow with its authority and safety gates', () => {
    assert.ok(
      (V3_CCB_BASELINE_SKILL_NAMES as readonly string[]).includes('connector-authoring'),
    )
    const body = readFileSync(join(skillsDir, 'connector-authoring', 'SKILL.md'), 'utf8')
    assert.match(body, /oc-market plugin examples/)
    assert.match(body, /plugin-blueprint-v1/)
    assert.match(body, /oc-market plugin prepare --file/)
    assert.match(body, /validationHash/)
    assert.match(body, /publishCommand/)
    assert.doesNotMatch(body, /--security-decision-file/)
    assert.match(body, /不得[^。]*真实密码/)
    assert.match(body, /只向用户确认一次/)
  })
})
