import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  WEAK_MODEL_SLUG_RE,
  checkNoSilentModelDowngrade,
  scanFileForSilentDowngrades,
} from '../check-no-silent-model-downgrade.ts'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-no-silent-model-downgrade.ts',
)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function makeRepo(t: { after(fn: () => void): void }, files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'no-downgrade-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  return root
}

describe('check-no-silent-model-downgrade', () => {
  test('WEAK_MODEL_SLUG_RE matches weak slugs and ignores strong models & unrelated strings', () => {
    for (const weak of [
      'deepseek-v4-flash',
      'claude-haiku-4-5',
      'box-claude-haiku-5-5',
      'gpt-4o-mini',
      'gpt-5-mini',
      'gemini-2.5-flash-lite',
      'glm-5.3-flash',
      'o3-mini',
    ]) {
      assert.ok(WEAK_MODEL_SLUG_RE.test(weak), `expected weak match: ${weak}`)
    }
    for (const safe of [
      'gpt-6.2-astra',
      'claude-opus-4-7',
      'gemini-2.5-pro',
      'MiniMax-M3',
      'better-sqlite3',
      'satellite',
      'literature',
    ]) {
      assert.ok(!WEAK_MODEL_SLUG_RE.test(safe), `expected non-match: ${safe}`)
    }
  })

  test('RED: blocks weak model fallback in Cron, /btw (quickAsk), ai_review, and generic execution paths', () => {
    const cronHits = scanFileForSilentDowngrades(
      'packages/gateway/src/cronModelPolicy.ts',
      `export function pickCronModel(m?: string) { return m ?? 'deepseek-v4-flash' }\n`,
    )
    assert.equal(cronHits.length, 1)
    assert.equal(cronHits[0]!.slug, 'deepseek-v4-flash')

    const btwHits = scanFileForSilentDowngrades(
      'packages/gateway/src/btwQuickAsk.ts',
      `export function resolveBtwModel(mainModel?: string) { const fallbackModel = mainModel || 'claude-haiku-4-5'; return fallbackModel }\n`,
    )
    assert.equal(btwHits.length, 1)
    assert.equal(btwHits[0]!.slug, 'claude-haiku-4-5')

    const reviewHits = scanFileForSilentDowngrades(
      'packages/gateway/src/actionPolicyEngine.ts',
      `export function getAiReviewFallback() { return 'gpt-4o-mini' }\n`,
    )
    assert.equal(reviewHits.length, 1)
    assert.equal(reviewHits[0]!.slug, 'gpt-4o-mini')

    const commercialHits = scanFileForSilentDowngrades(
      'packages/commercial/src/dispatch/turnRouter.ts',
      `export function selectFallbackModel(m?: string) { return m ?? 'glm-5.3-flash' }\n`,
    )
    assert.equal(commercialHits.length, 1)
    assert.equal(commercialHits[0]!.slug, 'glm-5.3-flash')
  })

  test('RED: strict red-line files (cron/btw/actionPolicyEngine/sessionSubmit/sessionTurnRunner/userChatBridge/engine/turn*) cannot bypass with oc-model-chore comment', () => {
    const strictCases: Array<[string, string]> = [
      [
        'packages/gateway/src/cronRunner.ts',
        "// oc-model-chore: trying to bypass red line\nexport const model = 'gemini-2.5-flash-lite'\n",
      ],
      [
        'packages/gateway/src/sessionSubmit.ts',
        "// oc-model-chore: pretend chore inside main chat submit\nexport function pick(m?: string) { return m ?? 'deepseek-v4-flash' }\n",
      ],
      [
        'packages/gateway/src/sessionTurnRunner.ts',
        "// oc-model-chore: pretend chore inside turn runner\nexport const fallbackModel = 'claude-haiku-4-5'\n",
      ],
      [
        'packages/commercial/src/ws/userChatBridge.ts',
        "// oc-model-chore: pretend chore inside chat bridge\nexport function route(m?: string) { return m || 'gpt-4o-mini' }\n",
      ],
      [
        'packages/gateway/src/engine/codexAdapter.ts',
        "// oc-model-chore: pretend chore inside engine adapter\nexport function resolveModel(m?: string) { return m ?? 'glm-5.3-flash' }\n",
      ],
      [
        'packages/gateway/src/turnDispatch.ts',
        "// oc-model-chore: pretend chore inside turn dispatch\nexport const backupModel = 'o3-mini'\n",
      ],
    ]
    for (const [file, code] of strictCases) {
      const hits = scanFileForSilentDowngrades(file, code)
      assert.equal(hits.length, 1, `expected strict red-line block for ${file}`)
    }
  })

  test('GREEN: permits legitimate title/summary chore modules, catalog/pricing tables, comparisons, and annotated chores', () => {
    assert.deepEqual(
      scanFileForSilentDowngrades(
        'packages/gateway/src/sessionTitleGenerator.ts',
        `export const TITLE_MODEL = 'deepseek-v4-flash'\n`,
      ),
      [],
    )
    assert.deepEqual(
      scanFileForSilentDowngrades(
        'packages/commercial/src/billing/modelCatalog.ts',
        `export const CATALOG = [{ id: 'claude-haiku-4-5' }, { id: 'gpt-4o-mini' }]\n`,
      ),
      [],
    )
    assert.deepEqual(
      scanFileForSilentDowngrades(
        'packages/commercial/src/billing/pricing.ts',
        `export const PRICES = { 'deepseek-v4-flash': 1 }\n`,
      ),
      [],
    )
    assert.deepEqual(
      scanFileForSilentDowngrades(
        'packages/gateway/src/agentHandlers.ts',
        `export const isFast = (m: string) => m === 'deepseek-v4-flash'\n`,
      ),
      [],
    )
    assert.deepEqual(
      scanFileForSilentDowngrades(
        'packages/commercial/src/inbox/digestWorker.ts',
        `// oc-model-chore: offline daily digest formatting\nexport const digestModel = 'deepseek-v4-flash'\n`,
      ),
      [],
    )
    // Comments mentioning weak models never trigger
    assert.deepEqual(
      scanFileForSilentDowngrades(
        'packages/gateway/src/cronModelPolicy.ts',
        `// NEVER fall back to 'deepseek-v4-flash' or 'claude-haiku-4-5'\nexport const ok = true\n`,
      ),
      [],
    )
  })

  test('CLI end-to-end: synthetic red repo exits 1 with [GATE-ERROR]; synthetic green repo exits 0', (t) => {
    const redRoot = makeRepo(t, {
      'packages/gateway/src/quickAsk.ts': `export function ask(m?: string) { return m ?? 'gpt-5-mini' }\n`,
    })
    const red = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', redRoot], {
      encoding: 'utf8',
    })
    assert.equal(red.status, 1)
    assert.match(red.stderr, /\[GATE-ERROR\] NO-SILENT-MODEL-DOWNGRADE/)
    assert.match(red.stderr, /quickAsk\.ts:1/)

    const greenRoot = makeRepo(t, {
      'packages/gateway/src/sessionSummary.ts': `export const SUMMARY_MODEL = 'deepseek-v4-flash'\n`,
      'packages/gateway/src/cronModelPolicy.ts': `export function pick(m: string) { if (!m) throw new Error('missing'); return m }\n`,
    })
    const green = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', greenRoot], {
      encoding: 'utf8',
    })
    assert.equal(green.status, 0, green.stderr)
  })

  test('RED: grandfathered legacy statement in sessionSubmit.ts never exempts an adjacent sibling fallback', () => {
    const src = [
      'export function submit(session: { model?: string }, desiredModel?: string, backup?: string) {',
      "  session.model = desiredModel ?? this.config.defaults.model ?? 'deepseek-v4-flash'",
      "  const retryModel = backup ?? 'deepseek-v4-flash'",
      '  return retryModel',
      '}',
    ].join('\n')
    const hits = scanFileForSilentDowngrades('packages/gateway/src/sessionSubmit.ts', src)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.line, 3)
  })

  test('real repository baseline passes with zero violations', () => {
    const res = checkNoSilentModelDowngrade(REPO_ROOT)
    assert.ok(res.filesScanned > 100, `expected >100 scanned files, got ${res.filesScanned}`)
    assert.deepEqual(res.violations, [])
  })
})
