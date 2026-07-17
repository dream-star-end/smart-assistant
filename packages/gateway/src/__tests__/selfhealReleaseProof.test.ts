/**
 * Behavior tests for ops/selfheal-release-proof.ts.
 *
 * proveSurfaces takes an injectable `run`, so we drive every remote probe with
 * canned stdout and assert the aggregate verdict — no real ssh/curl/psql. The
 * fake `run` routes on the remote script (args[1]) substring. Every face is
 * SHA-BOUND (batch1b §F1): the canned VERSION.json.commit / MANIFEST.sourceCommit
 * decide whether a face proves the candidate sha, a clean rollback, or unknown.
 * Plus a subprocess smoke that a garbage argsFile prints the fail-closed unknown
 * JSON via main().
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  proveSurfaces,
  type CommandRunner,
  type ProofConfig,
  type RunResult,
} from '../../../../ops/selfheal-release-proof.js'

const PROOF_TS = fileURLToPath(new URL('../../../../ops/selfheal-release-proof.ts', import.meta.url))

const SHA = '0123456789abcdef0123456789abcdef01234567'
const SHORT = '0123456' // 7-hex prefix of SHA (a VERSION.json.commit bound to SHA)
const OTHER_SHORT = '9999999' // a commit that is NOT a prefix of SHA (a rollback)
const OTHER_FULL = 'f'.repeat(40) // a full sha != SHA (a rolled-back MANIFEST.sourceCommit)

const RELEASES_ROOT = '/opt/openclaude/openclaude-v5-releases'
const REL_DIR = `${RELEASES_ROOT}/rel-abc123`

function baseCfg(over: Partial<ProofConfig> = {}): ProofConfig {
  return {
    klHost: 'kl-mirror',
    v5Env: '/etc/oc/v5.env',
    remoteSrc: '/opt/openclaude/openclaude-v5',
    v5Port: '8848',
    releasesRoot: RELEASES_ROOT,
    egressHealthUrl: 'http://172.31.0.1:18892/internal/v5/egress-health',
    egressUnit: 'openclaude-v5-egress.service',
    ...over,
  }
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })
const err = (): RunResult => ({ code: 1, stdout: '', stderr: 'boom' })

const HEALTH_B64 = Buffer.from(JSON.stringify({ ok: true, role: 'egress' })).toString('base64')

/**
 * Build a fake CommandRunner. `commit` is the VERSION.json.commit served by the
 * active release dir + the egress cwd (SHA-bound by default); `sourceCommit` is
 * the runtime/platform MANIFEST.sourceCommit (full sha, SHA-bound by default).
 * An `overrides` entry keyed by probe wins outright. Route ORDER matters — the
 * most specific substrings are checked first (egress/tuple scripts also mention
 * VERSION.json / MANIFEST.json).
 */
function makeRun(opts: {
  commit?: string
  sourceCommit?: string
  overrides?: Partial<Record<string, RunResult>>
}): CommandRunner {
  const commit = opts.commit ?? SHORT
  const sourceCommit = opts.sourceCommit ?? SHA
  const ov = opts.overrides ?? {}
  return async (cmd, args) => {
    assert.equal(cmd, 'ssh')
    const script = args[1] ?? ''
    const pick = (key: string, fallback: RunResult): RunResult => ov[key] ?? fallback
    // egress combined probe: state / pid / cwd / <cwd>VERSION.json commit / b64(health)
    if (script.includes('egress-health') || script.includes('openclaude-v5-egress')) {
      return pick('egress', ok(`active\n1234\n${REL_DIR}\n${commit}\n${HEALTH_B64}`))
    }
    // tuple probes: env path line + MANIFEST.sourceCommit line
    if (script.includes('OC_RUNTIME_RELEASE')) {
      return pick('runtime', ok(`/var/lib/openclaude-v5/runtime-releases/rel-x\n${sourceCommit}\n`))
    }
    if (script.includes('OC_PLATFORM_BUNDLE')) {
      return pick('platform', ok(`/var/lib/openclaude-v5/platform/bundles/abcdef012345\n${sourceCommit}\n`))
    }
    if (script.includes('deploy_state')) return pick('deploy_state', ok(`stable|A||${REL_DIR}|\n`))
    if (script.includes('dist/index.html')) {
      return pick('webtarget', ok('<meta name="oc-build" content="deadbeef">'))
    }
    if (script.includes('test -L')) return pick('slot', ok(`${REL_DIR}\n`))
    if (script.includes('/version')) return pick('version', ok(`{"commit":"${commit}"}`))
    if (script.includes('VERSION.json')) return pick('versionjson', ok(`${commit}\n`))
    // web live: `curl -fsS http://127.0.0.1:<port>/`
    if (script.includes('127.0.0.1')) {
      return pick('weblive', ok('<html><head><meta name="oc-build" content="deadbeef"></head></html>'))
    }
    return ok('')
  }
}

test('all-good touched surfaces → deployed + allOk', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['web', 'master', 'egress'], cfg: baseCfg() },
    { run: makeRun({}) },
  )
  assert.equal(out.verdict, 'deployed')
  assert.equal(out.allOk, true)
  // slot is auto-added because a staging surface (web/egress) was touched.
  assert.deepEqual(Object.keys(out.faces).sort(), ['egress', 'master', 'slot', 'web'])
  for (const f of Object.values(out.faces)) assert.equal(f.ok, true)
})

test('a probe returning an error → deploy_unknown (fail-closed)', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['web', 'master', 'egress'], cfg: baseCfg() },
    { run: makeRun({ overrides: { version: err() } }) },
  )
  assert.equal(out.verdict, 'deploy_unknown')
  assert.equal(out.allOk, false)
  assert.equal(out.faces.master.ok, false)
})

test('garbage /version output → deploy_unknown (fail-closed)', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['master'], cfg: baseCfg() },
    { run: makeRun({ overrides: { version: ok('not json at all') } }) },
  )
  assert.equal(out.verdict, 'deploy_unknown')
})

test('deploy_state with an unset active_release → master unknown (fail-closed)', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['master'], cfg: baseCfg() },
    { run: makeRun({ overrides: { deploy_state: ok('stable|A|||\n') } }) },
  )
  assert.equal(out.verdict, 'deploy_unknown')
  assert.equal(out.faces.master.ok, false)
  assert.match(out.faces.master.detail, /active_release_unset/)
})

test('master proves a clearly-different rolled-back commit → deploy_failed', async () => {
  // master-only plan (no staging surface) → no slot face → the touched face can be
  // definitively not-applied. /version and the active-release VERSION.json agree on
  // a different, coherent commit while the host is settled (phase=stable).
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['master'], cfg: baseCfg() },
    { run: makeRun({ commit: OTHER_SHORT }) },
  )
  assert.equal(out.verdict, 'deploy_failed')
  assert.equal(out.allOk, false)
  assert.equal(out.faces.master.ok, false)
  assert.equal(out.faces.master.detail.includes('rolled_back'), true)
  assert.deepEqual(Object.keys(out.faces), ['master'])
})

// ── §F1: a rollback to an OLD release must never read as `deployed` ───────────

test('web/egress/slot bound to an OLD release (not sha) → NOT deployed (unknown)', async () => {
  // The active release dir is a DIFFERENT commit than sha (a rollback). Every
  // release-anchored face must fail the sha binding → unknown, never deployed.
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['web', 'egress'], cfg: baseCfg() },
    { run: makeRun({ commit: OTHER_SHORT }) },
  )
  assert.notEqual(out.verdict, 'deployed')
  assert.equal(out.verdict, 'deploy_unknown')
  assert.equal(out.faces.web.ok, false)
  assert.match(out.faces.web.detail, /web_release_not_sha/)
  assert.equal(out.faces.egress.ok, false)
  assert.match(out.faces.egress.detail, /egress_release_not_sha/)
  assert.equal(out.faces.slot.ok, false)
  assert.match(out.faces.slot.detail, /slot_release_not_sha/)
})

test('slot: deploy_state.active_release disagreeing with the symlink readback → unknown', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['web'], cfg: baseCfg() },
    { run: makeRun({ overrides: { slot: ok(`${RELEASES_ROOT}/rel-OTHER\n`) } }) },
  )
  assert.notEqual(out.verdict, 'deployed')
  assert.equal(out.faces.slot.ok, false)
  assert.match(out.faces.slot.detail, /slot_state_symlink_disagree/)
})

// ── §F1/§F4: runtime/platform tuple bound to MANIFEST.sourceCommit ────────────

test('runtime-source with MANIFEST.sourceCommit == sha → applied (deployed)', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['runtime-source'], cfg: baseCfg() },
    { run: makeRun({}) }, // sourceCommit defaults to SHA
  )
  assert.equal(out.faces.runtime.ok, true)
  // slot is auto-added (staging surface) and healthy → overall deployed.
  assert.equal(out.verdict, 'deployed')
})

test('runtime-source rolled back (MANIFEST.sourceCommit != sha) → NOT deployed', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['runtime-source'], cfg: baseCfg() },
    { run: makeRun({ sourceCommit: OTHER_FULL, commit: OTHER_SHORT }) },
  )
  assert.notEqual(out.verdict, 'deployed')
  assert.equal(out.faces.runtime.ok, false)
  assert.match(out.faces.runtime.detail, /source_mismatch/)
})

test('runtime-source with an unreadable MANIFEST → unknown (fail-closed)', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['runtime-source'], cfg: baseCfg() },
    { run: makeRun({ overrides: { runtime: ok('/var/lib/openclaude-v5/runtime-releases/rel-x\n\n') } }) },
  )
  assert.equal(out.verdict, 'deploy_unknown')
  assert.equal(out.faces.runtime.ok, false)
  assert.match(out.faces.runtime.detail, /manifest_unreadable/)
})

test('runtime-source with an empty tuple env value → unknown (fail-closed)', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['runtime-source'], cfg: baseCfg() },
    { run: makeRun({ overrides: { runtime: ok('\n\n') } }) },
  )
  assert.equal(out.faces.runtime.ok, false)
  assert.match(out.faces.runtime.detail, /live_empty/)
})

test('web build mismatch (live != active release dist) → unknown, never deployed', async () => {
  const out = await proveSurfaces(
    { sha: SHA, surfaces: ['web'], cfg: baseCfg() },
    { run: makeRun({ overrides: { weblive: ok('<meta name="oc-build" content="cafef00d">') } }) },
  )
  assert.notEqual(out.verdict, 'deployed')
  assert.equal(out.faces.web.ok, false)
  assert.match(out.faces.web.detail, /web_build_mismatch/)
})

test('main() with a garbage argsFile prints the fail-closed unknown JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-main-'))
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, 'this is not json')
  const stdout = execFileSync('npx', ['tsx', PROOF_TS, bad], { encoding: 'utf8' })
  const parsed = JSON.parse(stdout.trim())
  assert.deepEqual(parsed, { faces: {}, allOk: false, verdict: 'deploy_unknown' })
})

test('main() with a missing argsFile prints the fail-closed unknown JSON', () => {
  const stdout = execFileSync('npx', ['tsx', PROOF_TS, '/no/such/args.json'], { encoding: 'utf8' })
  assert.equal(JSON.parse(stdout.trim()).verdict, 'deploy_unknown')
})
