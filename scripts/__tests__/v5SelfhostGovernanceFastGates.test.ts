/**
 * OCV5-847 / OCV5-849 / OCV5-859: Wave 1/2 governance fast gates wired into the
 * host-local V5 selfhost release train (`scripts/lib/v5-selfhost-governance-gates.sh`
 * sourced by `scripts/v5-selfhost-master-release-lib.sh`).
 *
 * Verifies:
 *   1. `master_resolve_governance_base_ref` precedence (explicit override, live .complete
 *      sourceCommit, origin/feat/v5-selfhost, detached-HEAD parent HEAD~1), skips any
 *      candidate that resolves to `full_sha` (no silent self-comparison!), and fails closed
 *      on invalid/self explicit override or isolated root commit.
 *   2. `build_master_release` sources `lib/v5-selfhost-governance-gates.sh`, invokes
 *      `master_run_governance_fast_gates` before C/D parallel jobs, and cleans up on failure.
 *   3. Real execution of `master_run_governance_fast_gates` against a `.git`-less `git archive`
 *      staging directory (with `GIT_DIR` + `safe.directory=*`) passes with ZERO side effects
 *      on `$staging` and `$REPO_ROOT`.
 *   4. Real RED cases on isolated temp repos + `.git`-less staging archives:
 *      - unsafe PG migration (`DROP COLUMN`) blocks EVEN when parent env sets `OC_PG_MIGRATION_BOSS_APPROVED=1`
 *      - unauthorized `changelog.json` edit blocks EVEN when parent env sets `BOSS_APPROVED_CHANGELOG=1`
 *      - raised monotonic budget in `packages/web-react/budgets.json` blocks
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
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
const GOV_LIB_PATH = join(REPO_ROOT, 'scripts/lib/v5-selfhost-governance-gates.sh')
const MASTER_LIB_SRC = readFileSync(MASTER_LIB_PATH, 'utf8')
const GOV_LIB_SRC = readFileSync(GOV_LIB_PATH, 'utf8')

function extractBashFn(src: string, name: string): string {
  const m = src.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, 'm'))
  assert.ok(m, `missing bash function ${name}`)
  return m[0]
}

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
      ['mlog() { echo "$*" >&2; }', 'tsum_note() { :; }', `source ${q(GOV_LIB_PATH)}`, body].join(
        '\n',
      ),
    ],
    { env, encoding: 'utf8', timeout: 180_000 },
  )
}

describe('master_resolve_governance_base_ref (OCV5-859)', () => {
  test('skips self-matching live/origin refs, falls back to parent, and fails closed on isolated root or invalid/self override', (t) => {
    const f = makeTempGitRepo(t)
    writeFileSync(join(f.repo, 'a.txt'), 'v1\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'c1')
    const c1 = f.git('rev-parse', 'HEAD')

    // 1) Isolated root commit with no parent, no live link, no origin/feat/v5-selfhost → MUST fail closed (no self-comparison!)
    let r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(join(f.dir, 'missing-live'))}; master_resolve_governance_base_ref ${q(c1)}`,
      f.env,
    )
    assert.notEqual(r.status, 0, 'isolated root commit without explicit base must fail closed')
    assert.match(r.stderr, /无法为目标 commit .* 解析非自身基线/)

    // 2) Add c2, set origin/feat/v5-selfhost == c2, and omit live marker → must SKIP self-matching origin ref and fall back to c1 (c2^)
    writeFileSync(join(f.repo, 'a.txt'), 'v2\n')
    f.git('commit', '-qam', 'c2')
    const c2 = f.git('rev-parse', 'HEAD')
    f.git('update-ref', 'refs/remotes/origin/feat/v5-selfhost', c2)
    f.git('checkout', '-q', '--detach', c2)

    r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(join(f.dir, 'missing-live'))}; master_resolve_governance_base_ref ${q(c2)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), c1, 'must skip self-matching origin/feat/v5-selfhost and fall back to c2^')

    // 3) Live .complete sourceCommit pointing to c3 itself is skipped, falling back to origin/feat/v5-selfhost (c2)
    writeFileSync(join(f.repo, 'a.txt'), 'v3\n')
    f.git('commit', '-qam', 'c3')
    const c3 = f.git('rev-parse', 'HEAD')
    const liveRel = join(f.dir, 'rel-live')
    const liveLink = join(f.dir, 'live')
    mkdirSync(liveRel, { recursive: true })
    writeFileSync(join(liveRel, '.complete'), JSON.stringify({ sourceCommit: c3 }))
    symlinkSync(liveRel, liveLink)

    r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(liveLink)}; master_resolve_governance_base_ref ${q(c3)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(
      r.stdout.trim(),
      c2,
      'must skip self-matching live sourceCommit and fall back to verified merge-base of origin/feat/v5-selfhost (c2)',
    )

    // 3b) When origin/feat/v5-selfhost is AHEAD of pinned candidate c2 (c2 is ancestor of c3),
    // merge-base(c3, c2) == c2 would make `c3...c2` an empty 0-file diff! Must skip origin and fall back to c2^ (c1).
    f.git('update-ref', 'refs/remotes/origin/feat/v5-selfhost', c3)
    r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(join(f.dir, 'missing-live'))}; master_resolve_governance_base_ref ${q(c2)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), c1, 'must skip origin/feat/v5-selfhost when it is ahead of pinned candidate')

    // Explicit override pointing ahead of pinned candidate (c3 > c2) must fail closed
    r = runBash(
      `REPO_ROOT=${q(f.repo)}; OC_V5_GOVERNANCE_BASE_REF=${q(c3)}; master_resolve_governance_base_ref ${q(c2)}`,
      f.env,
    )
    assert.notEqual(r.status, 0, 'explicit ahead-of-candidate base must fail closed')
    assert.match(r.stderr, /禁止空比较/)
    f.git('update-ref', 'refs/remotes/origin/feat/v5-selfhost', c2)

    // 4) Non-self live .complete sourceCommit (c1) takes priority over origin/feat/v5-selfhost (c2)
    writeFileSync(join(liveRel, '.complete'), JSON.stringify({ sourceCommit: c1 }))
    r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(liveLink)}; master_resolve_governance_base_ref ${q(c3)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), c1, 'non-self live .complete sourceCommit must take precedence')

    // 5) Explicit OC_V5_GOVERNANCE_BASE_REF wins when valid & non-self; fails closed when invalid OR equal to full_sha
    r = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(liveLink)}; OC_V5_GOVERNANCE_BASE_REF=${q(c2)}; master_resolve_governance_base_ref ${q(c3)}`,
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), c2)

    r = runBash(
      `REPO_ROOT=${q(f.repo)}; OC_V5_GOVERNANCE_BASE_REF=${q(c3)}; master_resolve_governance_base_ref ${q(c3)}`,
      f.env,
    )
    assert.notEqual(r.status, 0, 'explicit self-comparison override must fail closed')
    assert.match(r.stderr, /禁止空比较/)

    r = runBash(
      `REPO_ROOT=${q(f.repo)}; OC_V5_GOVERNANCE_BASE_REF=nonexistent-ref-xyz; master_resolve_governance_base_ref ${q(c3)}`,
      f.env,
    )
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /不是有效 commit/)
  })
})

describe('build_master_release wiring & zero-side-effect execution (OCV5-859)', () => {
  test('master-release-lib sources governance-gates lib and build_master_release invokes it before C/D parallel jobs', () => {
    assert.match(MASTER_LIB_SRC, /source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/lib\/v5-selfhost-governance-gates\.sh"/)
    assert.match(GOV_LIB_SRC, /OC_PG_MIGRATION_BOSS_APPROVED=0/)
    assert.match(GOV_LIB_SRC, /BOSS_APPROVED_CHANGELOG=0/)
    const callIdx = FN_BUILD.indexOf('master_run_governance_fast_gates "$staging" "$full_sha"')
    const p3Idx = FN_BUILD.indexOf('  # P3:')
    const receiptIdx = FN_BUILD.indexOf('master_gate_receipt_prepare "$staging" "$full_sha"')
    assert.ok(receiptIdx > 0 && callIdx > receiptIdx && callIdx < p3Idx, 'must run after receipt_prepare and before P3')
    const block = FN_BUILD.slice(callIdx - 10, callIdx + 220)
    assert.match(block, /cleanup_master_staging/)
    assert.match(block, /die /)
  })

  test('master_run_governance_fast_gates enforces PG safety, changelog guard, and monotonic baselines in .git-less staging and ignores parent approval env vars', (t) => {
    const f = makeTempGitRepo(t)
    const staging = join(f.dir, 'staging')
    const gateTmp = join(f.dir, 'gate-tmp')
    mkdirSync(staging, { recursive: true })
    mkdirSync(gateTmp, { recursive: true })

    // Create minimal stubs for the 10 pure-FS scripts + real copies of the git-aware governance checkers.
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
      'scripts/check-context-static.ts',
      'scripts/check-file-size-ratchet.ts',
      'scripts/check-gate-couplings.ts',
      'scripts/check-rest-contract-compat.ts',
    ]) {
      writeFileSync(join(f.repo, rel), 'process.exit(0)\n')
    }
    writeFileSync(join(f.repo, 'scripts/check-biome-changed.sh'), '#!/usr/bin/env bash\nexit 0\n')
    for (const rel of [
      'scripts/check-monotonic-baselines.ts',
      'scripts/lib/monotonicExtraBaselines.ts',
      'scripts/lib/archMapUpgrades.ts',
      'scripts/arch-measure/lib.mjs',
      'scripts/check-ai-smells-ratchet.ts',
      'scripts/check-complexity-ratchet.ts',
      'scripts/check-clones-ratchet.ts',
      'scripts/check-security-sast.ts',
      'scripts/check-pg-migration-safety.ts',
      'scripts/check-changelog-guard.ts',
    ]) {
      mkdirSync(dirname(join(f.repo, rel)), { recursive: true })
      cpSync(join(REPO_ROOT, rel), join(f.repo, rel))
    }
    const archDir = join(f.repo, 'arch')
    mkdirSync(archDir, { recursive: true })
    writeFileSync(
      join(archDir, 'ai-smells-baseline.json'),
      `${JSON.stringify({ schemaVersion: 1, generatedAt: '2026-11-26', categories: ['emptyCatch', 'typeEscape', 'syncIo', 'lintSuppress'], totals: { emptyCatch: 0, typeEscape: 0, syncIo: 0, lintSuppress: 0, all: 0 }, files: {} }, null, 2)}\n`,
    )
    writeFileSync(
      join(archDir, 'complexity-baseline.json'),
      `${JSON.stringify({ schemaVersion: 1, limits: { lines: 100, ccDirect: 20, maxNesting: 5 }, summary: { exceedingFunctions: 0, overLines: 0, overCcDirect: 0, overMaxNesting: 0 }, functions: {} }, null, 2)}\n`,
    )
    writeFileSync(
      join(archDir, 'clones-baseline.json'),
      `${JSON.stringify({ schemaVersion: 1, windowLines: 12, summary: { scannedFiles: 0, totalClusters: 0, totalInstances: 0 }, topHotspots: [], clusters: {} }, null, 2)}\n`,
    )
    writeFileSync(
      join(archDir, 'security-sast-baseline.json'),
      `${JSON.stringify({ schemaVersion: 1, summary: { totalEntries: 0, totalCount: 0, byRule: {} }, entries: {} }, null, 2)}\n`,
    )

    writeFileSync(join(f.repo, 'changelog.json'), '[]\n')
    writeFileSync(join(webDir, 'budgets.json'), `${JSON.stringify({ mainJsBytes: 500_000 }, null, 2)}\n`)
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

    const invoke = (sha: string, extraEnv: Record<string, string> = {}) =>
      runBash(
        `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(join(f.dir, 'no-live'))}; OC_V5_REFEREE_ROOT=${q(join(f.dir, 'no-referee'))}; MASTER_GATE_TMPDIR=${q(gateTmp)}; OC_V5_GOVERNANCE_BASE_REF=${q(baseSha)}; master_run_governance_fast_gates ${q(staging)} ${q(sha)}`,
        { ...f.env, ...extraEnv },
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

    // Case 2 (RED): unsafe PG migration (DROP COLUMN) blocks EVEN IF parent env exports OC_PG_MIGRATION_BOSS_APPROVED=1
    writeFileSync(join(migDir, '0003_drop.sql'), 'ALTER TABLE t DROP COLUMN note;\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'unsafe-mig')
    const unsafeMigSha = f.git('rev-parse', 'HEAD')
    exportArchive(unsafeMigSha)
    res = invoke(unsafeMigSha, { OC_PG_MIGRATION_BOSS_APPROVED: '1' })
    assert.notEqual(res.status, 0, 'DROP COLUMN migration must fail closed even when parent env sets OC_PG_MIGRATION_BOSS_APPROVED=1')
    assert.match(res.stderr + res.stdout, /PG-BAN-DROP-COLUMN/)

    // Case 2b (RED): without live .complete and with origin/feat/v5-selfhost AHEAD of pinned candidate by 1 commit,
    // resolver skips ahead origin, falls back to unsafeMigSha^ (safeSha), and still catches PG-BAN-DROP-COLUMN!
    writeFileSync(join(f.repo, 'ahead-note.txt'), 'later commit on origin\n')
    f.git('add', 'ahead-note.txt')
    f.git('commit', '-qm', 'origin-ahead')
    const aheadSha = f.git('rev-parse', 'HEAD')
    f.git('update-ref', 'refs/remotes/origin/feat/v5-selfhost', aheadSha)
    const resAhead = runBash(
      `REPO_ROOT=${q(f.repo)}; MASTER_LIVE_LINK=${q(join(f.dir, 'no-live'))}; OC_V5_REFEREE_ROOT=${q(join(f.dir, 'no-referee'))}; MASTER_GATE_TMPDIR=${q(gateTmp)}; master_run_governance_fast_gates ${q(staging)} ${q(unsafeMigSha)}`,
      f.env,
    )
    assert.notEqual(
      resAhead.status,
      0,
      'must catch DROP COLUMN even when origin/feat/v5-selfhost is 1 commit ahead of pinned candidate',
    )
    assert.match(resAhead.stderr + resAhead.stdout, /PG-BAN-DROP-COLUMN/)

    // Case 3 (RED): raised monotonic budget blocks
    f.git('reset', '--hard', safeSha)
    writeFileSync(join(webDir, 'budgets.json'), `${JSON.stringify({ mainJsBytes: 999_999 }, null, 2)}\n`)
    f.git('commit', '-qam', 'raise-budget')
    const budgetSha = f.git('rev-parse', 'HEAD')
    exportArchive(budgetSha)
    res = invoke(budgetSha)
    assert.notEqual(res.status, 0, 'raised budget must fail closed')
    assert.match(res.stderr + res.stdout, /MONOTONIC-BUDGET-RAISED/)

    // Case 4 (RED): unauthorized changelog.json edit blocks EVEN IF parent env exports BOSS_APPROVED_CHANGELOG=1
    f.git('reset', '--hard', safeSha)
    writeFileSync(join(f.repo, 'changelog.json'), '[{"version":"1"}]\n')
    f.git('commit', '-qam', 'edit-changelog')
    const clSha = f.git('rev-parse', 'HEAD')
    exportArchive(clSha)
    res = invoke(clSha, { BOSS_APPROVED_CHANGELOG: '1' })
    assert.notEqual(res.status, 0, 'changelog.json edit must fail closed even when parent env sets BOSS_APPROVED_CHANGELOG=1')
    assert.match(res.stderr + res.stdout, /CHANGELOG-GUARD/)
  })
})
