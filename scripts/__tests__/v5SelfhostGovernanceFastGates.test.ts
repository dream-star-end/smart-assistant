/**
 * OCV5-847 / OCV5-849 / OCV5-859: Wave 1/2 governance fast gates wired into the
 * host-local V5 selfhost release train (`scripts/v5-selfhost-master-release-lib.sh`).
 *
 * Verifies:
 *   1. `master_resolve_governance_base_ref` precedence (explicit override, live .complete
 *      sourceCommit, origin/feat/v5-selfhost, detached-HEAD parent HEAD~1, initial commit)
 *      and fail-closed behavior on invalid explicit ref.
 *   2. `build_master_release` calls `master_run_governance_fast_gates` before C/D parallel
 *      jobs and cleans up staging on failure.
 *   3. Real execution of `master_run_governance_fast_gates` against a `.git`-less `git archive`
 *      staging directory (with `GIT_DIR` + `safe.directory=*`) passes with ZERO side effects
 *      on `$staging` and `$REPO_ROOT`.
 *   4. Real RED cases on isolated temp repos + `.git`-less staging archives:
 *      - unsafe PG migration (`DROP COLUMN`) blocks
 *      - unauthorized `changelog.json` edit blocks (and `BOSS_APPROVED_CHANGELOG=1` approves)
 *      - raised monotonic budget in `packages/web-react/budgets.json` blocks
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MASTER_LIB_PATH = join(REPO_ROOT, 'scripts/v5-selfhost-master-release-lib.sh')
const MASTER_LIB_SRC = readFileSync(MASTER_LIB_PATH, 'utf8')

function extractBashFn(src: string, name: string): string {
  const m = src.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, 'm'))
  assert.ok(m, `missing bash function ${name}`)
  return m[0]
}

const FN_RESOLVE = extractBashFn(MASTER_LIB_SRC, 'master_resolve_governance_base_ref')
const FN_RUN = extractBashFn(MASTER_LIB_SRC, 'master_run_governance_fast_gates')
const FN_BUILD = extractBashFn(MASTER_LIB_SRC, 'build_master_release')

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

function listTree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (ent.name === 'node_modules') continue
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name
      out.push(nextRel)
      if (ent.isDirectory()) walk(join(dir, ent.name), nextRel)
    }
  }
  walk(root, '')
  return out
}

function makeTempGitRepo(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-gov-fast-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C.UTF-8',
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@example.invalid')
  return { dir, repo, env, git }
}

function runBash(body: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(
    'bash',
    [
      '-Eeu',
      '-o',
      'pipefail',
      '-c',
      ['mlog() { echo "$*" >&2; }', 'tsum_note() { :; }', FN_RESOLVE, FN_RUN, body].join('\n'),
    ],
    { env, encoding: 'utf8', timeout: 180_000 },
  )
}

describe('master_resolve_governance_base_ref (OCV5-859)', () => {
  test('prefers live .complete sourceCommit, falls back to detached HEAD parent and initial commit, fails closed on bad explicit override', (t) => {
    const f = makeTempGitRepo(t)
    writeFileSync(join(f.repo, 'a.txt'), 'v1\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'c1')
    const c1 = f.git('rev-parse', 'HEAD')

    // 1) Initial single-commit repo with no live link and no origin/feat/v5-selfhost → falls back to c1 itself
    let r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(join(f.dir, 'missing-live'))}; master_resolve_governance_base_ref ${q(c1)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), c1)

    // 2) Add second commit and detach HEAD → falls back to c1 (HEAD~1 / parent)
    writeFileSync(join(f.repo, 'a.txt'), 'v2\n')
    f.git('commit', '-qam', 'c2')
    const c2 = f.git('rev-parse', 'HEAD')
    f.git('checkout', '-q', '--detach', c2)

    r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(join(f.dir, 'missing-live'))}; master_resolve_governance_base_ref ${q(c2)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), c1, 'detached HEAD should resolve parent commit')

    // 3) Live .complete sourceCommit takes priority over HEAD~1
    writeFileSync(join(f.repo, 'a.txt'), 'v3\n')
    f.git('commit', '-qam', 'c3')
    const c3 = f.git('rev-parse', 'HEAD')
    const liveRel = join(f.dir, 'rel-live')
    const liveLink = join(f.dir, 'live')
    mkdirSync(liveRel, { recursive: true })
    writeFileSync(join(liveRel, '.complete'), JSON.stringify({ sourceCommit: c1 }))
    symlinkSync(liveRel, liveLink)

    r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(liveLink)}; master_resolve_governance_base_ref ${q(c3)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), c1, 'live .complete sourceCommit must take precedence over HEAD~1')

    // 4) Explicit OC_V5_GOVERNANCE_BASE_REF wins when valid, fails closed when invalid
    r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(liveLink)}; OC_V5_GOVERNANCE_BASE_REF=${q(c2)}; master_resolve_governance_base_ref ${q(c3)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), c2)

    r = runBash(
      `REPO_ROOT=${q(f.repo)}; OC_V5_GOVERNANCE_BASE_REF=nonexistent-ref-xyz; master_resolve_governance_base_ref ${q(c3)}`,
      f.env,
    )
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /不是有效 commit/)
  })
})

describe('build_master_release wiring & zero-side-effect execution (OCV5-859)', () => {
  test('build_master_release invokes master_run_governance_fast_gates before C/D parallel jobs and cleans up on failure', () => {
    const callIdx = FN_BUILD.indexOf('master_run_governance_fast_gates "$staging" "$full_sha"')
    const p3Idx = FN_BUILD.indexOf('  # P3:')
    const receiptIdx = FN_BUILD.indexOf('master_gate_receipt_prepare "$staging" "$full_sha"')
    assert.ok(receiptIdx > 0 && callIdx > receiptIdx && callIdx < p3Idx, 'must run after receipt_prepare and before P3')
    const block = FN_BUILD.slice(callIdx - 10, callIdx + 220)
    assert.match(block, /cleanup_master_staging/)
    assert.match(block, /die /)
  })

  test('master_run_governance_fast_gates enforces PG migration safety, changelog guard, and monotonic baselines in a .git-less staging archive', (t) => {
    const f = makeTempGitRepo(t)
    const staging = join(f.dir, 'staging')
    const gateTmp = join(f.dir, 'gate-tmp')
    mkdirSync(staging, { recursive: true })
    mkdirSync(gateTmp, { recursive: true })

    // Create minimal stubs for the 10 pure-FS scripts + real copies of the 4 Wave 2 git-aware scripts.
    const scriptsDir = join(f.repo, 'scripts')
    const commScriptsDir = join(f.repo, 'packages/commercial/scripts')
    const migDir = join(f.repo, 'packages/commercial/src/db/migrations')
    const webDir = join(f.repo, 'packages/web-react')
    const protoDir = join(f.repo, 'packages/protocol/src')
    mkdirSync(scriptsDir, { recursive: true })
    mkdirSync(commScriptsDir, { recursive: true })
    mkdirSync(migDir, { recursive: true })
    mkdirSync(webDir, { recursive: true })
    mkdirSync(protoDir, { recursive: true })

    for (const rel of [
      'scripts/check-docs-links.ts',
      'scripts/check-ui-hard-gates.ts',
      'scripts/check-no-silent-model-downgrade.ts',
      'scripts/check-v5-route-sync.ts',
      'scripts/check-feature-flags-ttl.ts',
      'scripts/check-schedulers.ts',
      'packages/commercial/scripts/lint-agent-containers-sql.ts',
      'scripts/check-v5-test-retries.ts',
      'scripts/check-integ-tiers.ts',
      'scripts/check-v5-e2e-selectors.ts',
      'scripts/check-rest-contract-compat.ts',
    ]) {
      writeFileSync(join(f.repo, rel), 'process.exit(0)\n')
    }
    // Use the REAL governance checkers for monotonic baselines, PG migration safety, and changelog guard!
    for (const rel of [
      'scripts/check-monotonic-baselines.ts',
      'scripts/check-pg-migration-safety.ts',
      'scripts/check-changelog-guard.ts',
    ]) {
      cpSync(join(REPO_ROOT, rel), join(f.repo, rel))
    }

    writeFileSync(join(f.repo, 'changelog.json'), '[]\n')
    writeFileSync(join(webDir, 'budgets.json'), JSON.stringify({ mainJsBytes: 500_000 }, null, 2) + '\n')
    writeFileSync(join(migDir, '0001_init.sql'), 'CREATE TABLE t (id BIGSERIAL PRIMARY KEY, col TEXT);\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'base')
    const baseSha = f.git('rev-parse', 'HEAD')

    const exportArchive = (sha: string) => {
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      const tarRes = spawnSync(
        'bash',
        ['-euo', 'pipefail', '-c', `git -C ${q(f.repo)} archive --format=tar ${q(sha)} | tar -x -C ${q(staging)}`],
        { env: f.env, encoding: 'utf8' },
      )
      assert.equal(tarRes.status, 0, tarRes.stderr)
      assert.equal(existsSync(join(staging, '.git')), false, 'staging must be .git-less archive')
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(staging, 'node_modules'))
    }

    const invoke = (sha: string, extraEnv = '') =>
      runBash(
        `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(join(f.dir, 'no-live'))}; MASTER_GATE_TMPDIR=${q(gateTmp)}; OC_V5_GOVERNANCE_BASE_REF=${q(baseSha)}; ${extraEnv} master_run_governance_fast_gates ${q(staging)} ${q(sha)}`,
        f.env,
      )

    // Case 1 (GREEN): safe additive migration passes with zero side effects on staging
    writeFileSync(join(migDir, '0002_safe.sql'), 'ALTER TABLE t ADD COLUMN note TEXT;\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'safe-mig')
    const safeSha = f.git('rev-parse', 'HEAD')
    exportArchive(safeSha)
    const treeBefore = listTree(staging)
    let res = invoke(safeSha)
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(listTree(staging), treeBefore, 'staging tree must have zero side effects')

    // Case 2 (RED): unsafe PG migration (DROP COLUMN) blocks in pinned staging
    writeFileSync(join(migDir, '0003_drop.sql'), 'ALTER TABLE t DROP COLUMN note;\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'unsafe-mig')
    const unsafeMigSha = f.git('rev-parse', 'HEAD')
    exportArchive(unsafeMigSha)
    res = invoke(unsafeMigSha)
    assert.notEqual(res.status, 0, 'DROP COLUMN migration must fail closed')
    assert.match(res.stderr + res.stdout, /PG-BAN-DROP-COLUMN/)

    // Reset back to safeSha, test Case 3 (RED): raised monotonic budget blocks
    f.git('reset', '--hard', safeSha)
    writeFileSync(join(webDir, 'budgets.json'), JSON.stringify({ mainJsBytes: 999_999 }, null, 2) + '\n')
    f.git('commit', '-qam', 'raise-budget')
    const budgetSha = f.git('rev-parse', 'HEAD')
    exportArchive(budgetSha)
    res = invoke(budgetSha)
    assert.notEqual(res.status, 0, 'raised budget must fail closed')
    assert.match(res.stderr + res.stdout, /MONOTONIC-BUDGET-RAISED/)

    // Reset back to safeSha, test Case 4 (RED → GREEN): changelog.json edit requires BOSS_APPROVED_CHANGELOG=1
    f.git('reset', '--hard', safeSha)
    writeFileSync(join(f.repo, 'changelog.json'), '[{"version":"1"}]\n')
    f.git('commit', '-qam', 'edit-changelog')
    const clSha = f.git('rev-parse', 'HEAD')
    exportArchive(clSha)
    res = invoke(clSha)
    assert.notEqual(res.status, 0, 'unapproved changelog.json edit must fail closed')
    assert.match(res.stderr + res.stdout, /CHANGELOG-GUARD/)

    res = invoke(clSha, 'BOSS_APPROVED_CHANGELOG=1')
    assert.equal(res.status, 0, `BOSS_APPROVED_CHANGELOG=1 should pass: ${res.stderr}`)
  })
})
