/**
 * OCV5-918 Slice 1 + R1 Blocker Regression Tests:
 *   - Fix #1 + Blocker #2:
 *       * Post-committed automatic external referee live-sync refresh
 *         (clears consumed transition-audited TRANSITION_APPROVAL.json -> mode: "live-sync")
 *       * Preserves another SHA's TRANSITION_APPROVAL.json (both fast pre-check and atomic lock check)
 *       * Skips stale refresh when MASTER_LIVE_LINK has moved to another release / SHA
 *       * Shared/exclusive .referee.lock serializes sync-referee swap vs concurrent readers
 *         (master_referee_prepare_exec_root & master_run_governance_fast_gates) with consistent snapshots
 *       * Fail-safe warn-only semantics, security checks (symlink/missing/root+022), ROLLBACK/DRY/ENABLED=0 skips
 *   - Fix #5 + Blocker #3:
 *       * Zero bare `git -C` in deploy-v5-selfhost.sh, v5-selfhost-master-release-lib.sh, sync-referee.sh
 *       * Real cross-owner `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` execution proof for:
 *         source_commit, --mint-flavor-manifest, master_web_dist_key, selfhost_prepare_identity
 *         (with negative control proving bare `git -C` fails with dubious ownership)
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEPLOY_SCRIPT = join(REPO_ROOT, 'scripts/deploy-v5-selfhost.sh')
const MASTER_LIB = join(REPO_ROOT, 'scripts/v5-selfhost-master-release-lib.sh')
const PREPARE_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-prepare.sh')
const GOV_GATES_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-governance-gates.sh')
const TRAIN_GUARDS_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-train-guards.sh')
const SYNC_REFEREE_SRC = join(REPO_ROOT, 'scripts/harness-gate/sync-referee.sh')

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

function makeSandbox(t: { after: (fn: () => void) => void }, prefix = 'ocv5-918-slice1-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    spawnSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
  })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C.UTF-8',
  }
  return { dir, env }
}

function runBash(body: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('bash', ['--noprofile', '--norc', '-Eeu', '-o', 'pipefail', '-c', body], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

function runBashAsync(
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-Eeu', '-o', 'pipefail', '-c', body], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr, elapsedMs: Date.now() - started }))
  })
}

function writeMinimalReferee(refDir: string, scriptContent: string, mode = 'live-sync', sha = 'a'.repeat(40)) {
  mkdirSync(join(refDir, 'scripts'), { recursive: true })
  const scriptPath = join(refDir, 'scripts/check-docs-links.ts')
  writeFileSync(scriptPath, scriptContent)
  const scriptSha = createHash('sha256').update(scriptContent).digest('hex')
  const manifest = {
    schemaVersion: 1,
    mode,
    sourceCommit: sha,
    fileCount: 1,
    files: { 'scripts/check-docs-links.ts': scriptSha },
  }
  writeFileSync(join(refDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  chmodSync(scriptPath, 0o444)
  chmodSync(join(refDir, 'MANIFEST.json'), 0o444)
}

function extractPostCommittedCutoverHook(): string {
  const src = readFileSync(DEPLOY_SCRIPT, 'utf8')
  const match = src.match(
    /^ {2}if \[\[ "\$\{CUTOVER_ROLLBACK:-0\}" != 1 \]\] && declare -F v5_selfhost_post_committed_sync_referee .*$/m,
  )
  assert.ok(match, 'cmd_cutover must contain the post-committed sync-referee hook')
  return match[0].trim()
}

describe('OCV5-918 Fix #1 + Blocker #2: post-committed sync-referee & concurrency lock', () => {
  test('real sync-referee.sh switches matching transition-audited referee back to live-sync and clears TRANSITION_APPROVAL.json', (t) => {
    const { dir, env } = makeSandbox(t)
    const govRoot = join(dir, 'harness-gate')
    const binDir = join(govRoot, 'bin')
    const refDir = join(govRoot, 'referee')
    const syncBin = join(binDir, 'sync-referee')
    const relNew = join(dir, 'releases/rel-20261127-new')
    const liveLink = join(dir, 'openclaude-v5-selfhost-live')
    const tsumLog = join(dir, 'tsum.log')
    const sha = 'a'.repeat(40)

    mkdirSync(binDir, { recursive: true })
    copyFileSync(SYNC_REFEREE_SRC, syncBin)
    chmodSync(syncBin, 0o755)

    // Pre-populate transition-audited referee bound to the SAME committed sha
    mkdirSync(join(refDir, 'scripts'), { recursive: true })
    writeFileSync(
      join(refDir, 'TRANSITION_APPROVAL.json'),
      JSON.stringify({ schemaVersion: 1, mode: 'transition-audited', targetSha: sha }, null, 2),
    )
    writeFileSync(
      join(refDir, 'MANIFEST.json'),
      JSON.stringify({ schemaVersion: 1, mode: 'transition-audited', sourceCommit: sha, fileCount: 1, files: {} }),
    )
    writeFileSync(join(refDir, 'scripts/check-docs-links.ts'), '// old transition copy\n')
    chmodSync(join(refDir, 'TRANSITION_APPROVAL.json'), 0o444)
    chmodSync(join(refDir, 'MANIFEST.json'), 0o444)

    mkdirSync(join(relNew, 'scripts/lib'), { recursive: true })
    writeFileSync(join(relNew, '.complete'), JSON.stringify({ schemaVersion: 2, sourceCommit: sha }))
    writeFileSync(join(relNew, 'scripts/check-docs-links.ts'), '// live-synced referee script\n')
    writeFileSync(join(relNew, 'scripts/lib/v5-helper.sh'), '#!/usr/bin/env bash\necho ok\n')
    writeFileSync(join(relNew, 'package.json'), '{"name":"openclaude"}\n')
    symlinkSync(relNew, liveLink)

    const res = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      tsum_note() { printf '%s %s\\n' "$1" "$2" >> ${q(tsumLog)}; }
      export OC_GOVERNOR_ROOT=${q(govRoot)}
      export MASTER_LIVE_LINK=${q(liveLink)}
      export OC_INSTALL_SKIP_CHOWN=1
      v5_selfhost_post_committed_sync_referee ${q(relNew)} ${q(sha)}
      `,
      env,
    )

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`)
    assert.match(res.stdout, /✓ \[post-committed-referee\] 外置裁判已自动同步为 live-sync/)
    assert.equal(existsSync(join(refDir, 'TRANSITION_APPROVAL.json')), false)

    const manifest = JSON.parse(readFileSync(join(refDir, 'MANIFEST.json'), 'utf8'))
    assert.equal(manifest.mode, 'live-sync')
    assert.equal(manifest.sourceCommit, sha)
    assert.equal(manifest.sourceRelease, realpathSync(relNew))
    assert.ok(manifest.files['scripts/check-docs-links.ts'])
    assert.equal(
      readFileSync(join(refDir, 'scripts/check-docs-links.ts'), 'utf8'),
      '// live-synced referee script\n',
    )
    assert.equal(readFileSync(tsumLog, 'utf8').trim(), 'postCommittedSyncReferee ok')
  })

  test('preserves another SHA transition-audited referee (both fast pre-check and in-lock sync-referee) and skips moved live_link', (t) => {
    const { dir, env } = makeSandbox(t)
    const govRoot = join(dir, 'harness-gate')
    const binDir = join(govRoot, 'bin')
    const refDir = join(govRoot, 'referee')
    const syncBin = join(binDir, 'sync-referee')
    const relA = join(dir, 'releases/rel-a')
    const relB = join(dir, 'releases/rel-b')
    const liveLink = join(dir, 'live')
    const tsumLog = join(dir, 'tsum.log')
    const shaA = 'a'.repeat(40)
    const shaB = 'b'.repeat(40)

    mkdirSync(binDir, { recursive: true })
    copyFileSync(SYNC_REFEREE_SRC, syncBin)
    chmodSync(syncBin, 0o755)

    for (const [rel, sha, body] of [
      [relA, shaA, '// live A\n'],
      [relB, shaB, '// live B\n'],
    ] as const) {
      mkdirSync(join(rel, 'scripts'), { recursive: true })
      writeFileSync(join(rel, '.complete'), JSON.stringify({ schemaVersion: 2, sourceCommit: sha }))
      writeFileSync(join(rel, 'scripts/check-docs-links.ts'), body)
    }
    symlinkSync(relA, liveLink)

    // Referee currently holds transition-audited approval for SHA B
    mkdirSync(join(refDir, 'scripts'), { recursive: true })
    const transDocB = JSON.stringify({ schemaVersion: 1, mode: 'transition-audited', targetSha: shaB }, null, 2)
    writeFileSync(join(refDir, 'TRANSITION_APPROVAL.json'), transDocB)
    writeFileSync(
      join(refDir, 'MANIFEST.json'),
      JSON.stringify({ schemaVersion: 1, mode: 'transition-audited', sourceCommit: shaB, fileCount: 1, files: {} }),
    )
    writeFileSync(join(refDir, 'scripts/check-docs-links.ts'), '// transition-B script\n')

    // 1. A commits -> v5_selfhost_post_committed_sync_referee must preserve B's transition referee
    const resPre = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      tsum_note() { printf '%s %s\\n' "$1" "$2" >> ${q(tsumLog)}; }
      export OC_GOVERNOR_ROOT=${q(govRoot)}
      export MASTER_LIVE_LINK=${q(liveLink)}
      export OC_INSTALL_SKIP_CHOWN=1
      v5_selfhost_post_committed_sync_referee ${q(relA)} ${q(shaA)}
      `,
      env,
    )
    assert.equal(resPre.status, 0, resPre.stderr)
    assert.match(resPre.stdout, /保留不覆盖/)
    assert.equal(existsSync(join(refDir, 'TRANSITION_APPROVAL.json')), true)
    assert.equal(JSON.parse(readFileSync(join(refDir, 'TRANSITION_APPROVAL.json'), 'utf8')).targetSha, shaB)
    assert.equal(readFileSync(join(refDir, 'scripts/check-docs-links.ts'), 'utf8'), '// transition-B script\n')
    assert.equal(readFileSync(tsumLog, 'utf8').trim(), 'postCommittedSyncReferee skipped:other-transition')

    // 2. Direct sync-referee.sh atomic in-lock check (--preserve-other-transition shaA) also preserves B
    const resDirectPreserve = runBash(
      `
      export OC_GOVERNOR_ROOT=${q(govRoot)}
      export OC_INSTALL_SKIP_CHOWN=1
      ${q(syncBin)} --live-link ${q(liveLink)} --preserve-other-transition ${q(shaA)}
      `,
      env,
    )
    assert.equal(resDirectPreserve.status, 0, resDirectPreserve.stderr)
    const directPreserveJson = JSON.parse(resDirectPreserve.stdout.trim())
    assert.equal(directPreserveJson.ok, true)
    assert.equal(directPreserveJson.skipped, true)
    assert.equal(directPreserveJson.reason, 'other_transition_preserved')
    assert.equal(directPreserveJson.committedSha, shaA)
    assert.equal(directPreserveJson.transitionTargetSha, shaB)
    assert.equal(existsSync(join(refDir, 'TRANSITION_APPROVAL.json')), true)

    // 3. Direct sync-referee.sh --expected-live-sha shaB while live still points to relA (shaA) -> live_sha_moved
    rmSync(join(refDir, 'TRANSITION_APPROVAL.json'))
    const resLiveMovedDirect = runBash(
      `
      export OC_GOVERNOR_ROOT=${q(govRoot)}
      export OC_INSTALL_SKIP_CHOWN=1
      ${q(syncBin)} --live-link ${q(liveLink)} --expected-live-sha ${q(shaB)}
      `,
      env,
    )
    assert.equal(resLiveMovedDirect.status, 0, resLiveMovedDirect.stderr)
    const movedJson = JSON.parse(resLiveMovedDirect.stdout.trim())
    assert.equal(movedJson.ok, true)
    assert.equal(movedJson.skipped, true)
    assert.equal(movedJson.reason, 'live_sha_moved')
    assert.equal(movedJson.expectedLiveSha, shaB)
    assert.equal(movedJson.actualLiveSha, shaA)
    assert.equal(readFileSync(join(refDir, 'scripts/check-docs-links.ts'), 'utf8'), '// transition-B script\n')

    // 4. Stale v5_selfhost_post_committed_sync_referee for relA when live_link already points to relB -> skipped:live-moved
    rmSync(liveLink)
    symlinkSync(relB, liveLink)
    const tsumMoved = join(dir, 'tsum-moved.log')
    const resMoved = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      tsum_note() { printf '%s %s\\n' "$1" "$2" >> ${q(tsumMoved)}; }
      export OC_GOVERNOR_ROOT=${q(govRoot)}
      export MASTER_LIVE_LINK=${q(liveLink)}
      export OC_INSTALL_SKIP_CHOWN=1
      v5_selfhost_post_committed_sync_referee ${q(relA)} ${q(shaA)}
      `,
      env,
    )
    assert.equal(resMoved.status, 0, resMoved.stderr)
    assert.match(resMoved.stdout, /live 已指向其他版本/)
    assert.equal(readFileSync(tsumMoved, 'utf8').trim(), 'postCommittedSyncReferee skipped:live-moved')
    assert.equal(readFileSync(join(refDir, 'scripts/check-docs-links.ts'), 'utf8'), '// transition-B script\n')
  })

  test('concurrent .referee.lock serializes exclusive swap against master_referee_prepare_exec_root with consistent snapshot', async (t) => {
    const { dir, env } = makeSandbox(t)
    const govRoot = join(dir, 'harness-gate')
    const refDir = join(govRoot, 'referee')
    const refV2 = join(govRoot, 'referee-v2')
    const lockFile = join(govRoot, '.referee.lock')
    const lockReady = join(dir, 'lock-ready')
    const staging = join(dir, 'staging')
    const nmDir = join(dir, 'trusted-nm')
    const gateTmp = join(dir, 'gate-tmp')

    mkdirSync(govRoot, { recursive: true })
    mkdirSync(staging, { recursive: true })
    mkdirSync(join(nmDir, '.bin'), { recursive: true })
    mkdirSync(gateTmp, { recursive: true })
    writeFileSync(join(nmDir, '.bin/tsx'), '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(join(nmDir, '.bin/tsx'), 0o755)

    writeMinimalReferee(refDir, '// v1-referee\n', 'live-sync', '1'.repeat(40))
    writeMinimalReferee(refV2, '// v2-swapped-referee\n', 'live-sync', '2'.repeat(40))

    // Writer holds exclusive lock on .referee.lock, moves referee away mid-swap, sleeps 500ms, swaps in v2, releases lock
    const writerPromise = runBashAsync(
      `
      exec 9>>${q(lockFile)}
      chmod 0644 ${q(lockFile)}
      flock -x 9
      touch ${q(lockReady)}
      mv ${q(refDir)} ${q(join(govRoot, 'referee-old'))}
      sleep 0.5
      mv ${q(refV2)} ${q(refDir)}
      chmod -R u+w ${q(join(govRoot, 'referee-old'))} 2>/dev/null || true
      rm -rf ${q(join(govRoot, 'referee-old'))}
      flock -u 9
      exec 9>&-
      `,
      env,
    )

    // Wait until writer definitely holds the exclusive lock
    const deadline = Date.now() + 5000
    while (!existsSync(lockReady) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15))
    }
    assert.equal(existsSync(lockReady), true, 'writer should have acquired exclusive lock')

    // Launch concurrent reader via master_referee_prepare_exec_root
    const readerPromise = runBashAsync(
      `
      mlog() { echo "$*" >&2; }
      source ${q(GOV_GATES_LIB)}
      export OC_V5_REFEREE_ROOT=${q(refDir)}
      export OC_V5_REFEREE_NODE_MODULES=${q(nmDir)}
      export MASTER_GATE_TMPDIR=${q(gateTmp)}
      master_referee_prepare_exec_root ${q(staging)} scripts/check-docs-links.ts ${q('2'.repeat(40))}
      `,
      env,
    )

    const [writerRes, readerRes] = await Promise.all([writerPromise, readerPromise])
    assert.equal(writerRes.status, 0, `writer failed:\n${writerRes.stderr}`)
    assert.equal(readerRes.status, 0, `reader failed:\n${readerRes.stdout}\n${readerRes.stderr}`)
    assert.ok(
      readerRes.elapsedMs >= 300,
      `reader should have blocked on .referee.lock during swap (elapsed=${readerRes.elapsedMs}ms)`,
    )
    const viewDir = readerRes.stdout.trim()
    assert.ok(viewDir && existsSync(viewDir), `expected isolated view dir, got ${viewDir}`)
    assert.equal(
      readFileSync(join(viewDir, 'scripts/check-docs-links.ts'), 'utf8'),
      '// v2-swapped-referee\n',
      'reader must observe the consistent post-swap v2 snapshot',
    )

    // Now prove real sync-referee.sh also waits on .referee.lock when a reader holds flock -s
    const relV3 = join(dir, 'releases/rel-v3')
    const liveLink = join(dir, 'live-v3')
    const readerLockReady = join(dir, 'reader-lock-ready')
    mkdirSync(join(relV3, 'scripts'), { recursive: true })
    writeFileSync(join(relV3, '.complete'), JSON.stringify({ schemaVersion: 2, sourceCommit: '3'.repeat(40) }))
    writeFileSync(join(relV3, 'scripts/check-docs-links.ts'), '// v3-live-synced\n')
    symlinkSync(relV3, liveLink)

    const sharedHolderPromise = runBashAsync(
      `
      exec 8<${q(lockFile)}
      flock -s 8
      touch ${q(readerLockReady)}
      sleep 0.45
      flock -u 8
      exec 8>&-
      `,
      env,
    )
    const deadline2 = Date.now() + 5000
    while (!existsSync(readerLockReady) && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 15))
    }
    assert.equal(existsSync(readerLockReady), true)

    const syncRes = await runBashAsync(
      `
      export OC_GOVERNOR_ROOT=${q(govRoot)}
      export OC_INSTALL_SKIP_CHOWN=1
      ${q(SYNC_REFEREE_SRC)} --live-link ${q(liveLink)}
      `,
      env,
    )
    await sharedHolderPromise
    assert.equal(syncRes.status, 0, `sync-referee failed:\n${syncRes.stdout}\n${syncRes.stderr}`)
    assert.ok(
      syncRes.elapsedMs >= 250,
      `sync-referee must wait for active shared reader lock (elapsed=${syncRes.elapsedMs}ms)`,
    )
    assert.equal(readFileSync(join(refDir, 'scripts/check-docs-links.ts'), 'utf8'), '// v3-live-synced\n')
    // And reader's earlier snapshot in viewDir remains untouched (still v2!)
    assert.equal(readFileSync(join(viewDir, 'scripts/check-docs-links.ts'), 'utf8'), '// v2-swapped-referee\n')
  })

  test('sync-referee failure / missing / symlink / untrusted perms warn and return non-0, while cmd_cutover hook exits 0 without rollback', (t) => {
    const { dir, env } = makeSandbox(t)
    const hookLine = extractPostCommittedCutoverHook()
    const relNew = join(dir, 'releases/rel-committed')
    const liveLink = join(dir, 'live')
    const sha = 'b'.repeat(40)
    mkdirSync(relNew, { recursive: true })
    symlinkSync(relNew, liveLink)

    // 1. Failing sync-referee (rc=23)
    const govFail = join(dir, 'gov-fail')
    mkdirSync(join(govFail, 'bin'), { recursive: true })
    const failingBin = join(govFail, 'bin/sync-referee')
    writeFileSync(failingBin, '#!/usr/bin/env bash\necho "boom: disk full" >&2\nexit 23\n')
    chmodSync(failingBin, 0o755)

    const tsumFail = join(dir, 'tsum-fail.log')
    const directFail = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      tsum_note() { printf '%s %s\\n' "$1" "$2" >> ${q(tsumFail)}; }
      export OC_GOVERNOR_ROOT=${q(govFail)}
      export MASTER_LIVE_LINK=${q(liveLink)}
      v5_selfhost_post_committed_sync_referee ${q(relNew)} ${q(sha)}
      `,
      env,
    )
    assert.equal(directFail.status, 23)
    assert.match(directFail.stdout, /⚠ \[post-committed-referee\] 外置裁判刷新失败 \(rc=23/)
    assert.match(directFail.stdout, /boom: disk full/)
    assert.equal(readFileSync(tsumFail, 'utf8').trim(), 'postCommittedSyncReferee warn:rc=23')

    const hookFail = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      CUTOVER_ROLLBACK=0
      CUTOVER_PHASE="committed"
      rel=${q(relNew)}
      head=${q(sha)}
      cutover_clog() { echo "CLOG: $*"; }
      export OC_GOVERNOR_ROOT=${q(govFail)}
      export MASTER_LIVE_LINK=${q(liveLink)}
      ${hookLine}
      printf 'AFTER_PHASE=%s\\nAFTER_LIVE=%s\\n' "$CUTOVER_PHASE" "$(readlink -f -- "$MASTER_LIVE_LINK")"
      `,
      env,
    )
    assert.equal(hookFail.status, 0, `outer cmd_cutover hook must stay exit 0:\n${hookFail.stdout}\n${hookFail.stderr}`)
    assert.match(hookFail.stdout, /CLOG: {3}⚠ 外置裁判刷新失败\(仅告警,不回滚\)/)
    assert.match(hookFail.stdout, /AFTER_PHASE=committed/)
    assert.match(
      hookFail.stdout,
      new RegExp(`AFTER_LIVE=${realpathSync(relNew).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )

    // 2. Missing sync-referee binary
    const govMissing = join(dir, 'gov-missing')
    mkdirSync(govMissing, { recursive: true })
    const missingRes = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      export OC_GOVERNOR_ROOT=${q(govMissing)}
      export MASTER_LIVE_LINK=${q(liveLink)}
      v5_selfhost_post_committed_sync_referee ${q(relNew)} ${q(sha)}
      `,
      env,
    )
    assert.equal(missingRes.status, 1)
    assert.match(missingRes.stdout, /⚠ \[post-committed-referee\] 跳过外置裁判刷新: 缺少可执行普通文件/)

    // 3. Symlink sync-referee binary is rejected without executing target
    const govSym = join(dir, 'gov-sym')
    mkdirSync(join(govSym, 'bin'), { recursive: true })
    const realTarget = join(dir, 'real-sync-referee')
    const symMarker = join(dir, 'sym-invoked')
    writeFileSync(realTarget, `#!/usr/bin/env bash\ntouch ${q(symMarker)}\nexit 0\n`)
    chmodSync(realTarget, 0o755)
    symlinkSync(realTarget, join(govSym, 'bin/sync-referee'))

    const symRes = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      CUTOVER_ROLLBACK=0
      rel=${q(relNew)}
      head=${q(sha)}
      cutover_clog() { echo "CLOG: $*"; }
      export OC_GOVERNOR_ROOT=${q(govSym)}
      export MASTER_LIVE_LINK=${q(liveLink)}
      set +e
      v5_selfhost_post_committed_sync_referee "$rel" "$head"
      rc=$?
      set -e
      echo "DIRECT_RC=$rc"
      ${hookLine}
      `,
      env,
    )
    assert.equal(symRes.status, 0)
    assert.match(symRes.stdout, /DIRECT_RC=1/)
    assert.match(symRes.stdout, /⚠ \[post-committed-referee\] 跳过外置裁判刷新: 缺少可执行普通文件/)
    assert.match(symRes.stdout, /CLOG: {3}⚠ 外置裁判刷新失败\(仅告警,不回滚\)/)
    assert.equal(existsSync(symMarker), false, 'symlink sync-referee target must never execute')

    // 4. OC_V5_SYNC_REFEREE_REQUIRE_ROOT=1 rejects group-writable / non-root binary without executing it
    const govWritable = join(dir, 'gov-writable')
    mkdirSync(join(govWritable, 'bin'), { recursive: true })
    const writableBin = join(govWritable, 'bin/sync-referee')
    const writableMarker = join(dir, 'writable-invoked')
    writeFileSync(writableBin, `#!/usr/bin/env bash\ntouch ${q(writableMarker)}\nexit 0\n`)
    chmodSync(writableBin, 0o775)

    const writableRes = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      export OC_GOVERNOR_ROOT=${q(govWritable)}
      export MASTER_LIVE_LINK=${q(liveLink)}
      export OC_V5_SYNC_REFEREE_REQUIRE_ROOT=1
      v5_selfhost_post_committed_sync_referee ${q(relNew)} ${q(sha)}
      `,
      env,
    )
    assert.equal(writableRes.status, 1)
    assert.match(writableRes.stdout, /⚠ \[post-committed-referee\] 跳过外置裁判刷新: 属主\/权限不可信/)
    assert.equal(existsSync(writableMarker), false, 'untrusted sync-referee binary must never execute')
  })

  test('CUTOVER_ROLLBACK=1, DRY=1, and OC_V5_POST_COMMITTED_SYNC_REFEREE_ENABLED=0 skip sync-referee cleanly', (t) => {
    const { dir, env } = makeSandbox(t)
    const govRoot = join(dir, 'gov-skip')
    mkdirSync(join(govRoot, 'bin'), { recursive: true })
    const marker = join(dir, 'should-not-run')
    const syncBin = join(govRoot, 'bin/sync-referee')
    writeFileSync(syncBin, `#!/usr/bin/env bash\ntouch ${q(marker)}\nexit 0\n`)
    chmodSync(syncBin, 0o755)

    for (const [label, extraEnv] of [
      ['CUTOVER_ROLLBACK=1', 'CUTOVER_ROLLBACK=1 DRY=0'],
      ['DRY=1', 'CUTOVER_ROLLBACK=0 DRY=1'],
      ['ENABLED=0', 'CUTOVER_ROLLBACK=0 DRY=0 OC_V5_POST_COMMITTED_SYNC_REFEREE_ENABLED=0'],
    ] as const) {
      const res = runBash(
        `
        source ${q(TRAIN_GUARDS_LIB)}
        export OC_GOVERNOR_ROOT=${q(govRoot)}
        export MASTER_LIVE_LINK=${q(join(dir, 'live'))}
        ${extraEnv} v5_selfhost_post_committed_sync_referee /tmp/rel-x ${q('c'.repeat(40))}
        `,
        env,
      )
      assert.equal(res.status, 0, `${label} should exit 0:\n${res.stdout}\n${res.stderr}`)
      assert.equal(existsSync(marker), false, `${label} must not invoke sync-referee`)
    }
  })

  test('deploy-v5-selfhost.sh wires post-committed referee hook after committed/finalize and before prepared cleanup & GC', () => {
    const src = readFileSync(DEPLOY_SCRIPT, 'utf8')
    const cutoverStart = src.indexOf('cmd_cutover() {')
    assert.ok(cutoverStart > 0)
    const cutoverBody = src.slice(cutoverStart)

    const idxRetention = cutoverBody.indexOf('v5_selfhost_post_cutover_retention_gate')
    const idxCommitted = cutoverBody.indexOf('cutover_persist_phase "committed"')
    const idxWatchSync = cutoverBody.indexOf('sync_watch_from "$rel"')
    const idxReferee = cutoverBody.indexOf('v5_selfhost_post_committed_sync_referee "$rel" "$head"')
    const idxPreparedComplete = cutoverBody.indexOf('selfhost_prepared_complete "$head" "$rel"')
    const idxGc = cutoverBody.indexOf('v5-release-gc.sh')

    assert.ok(idxRetention > 0 && idxCommitted > idxRetention)
    assert.ok(idxWatchSync > idxCommitted)
    assert.ok(idxReferee > idxWatchSync, 'referee refresh must run after committed + watch sync block')
    assert.ok(idxPreparedComplete > idxReferee, 'referee refresh must run before prepared receipt cleanup')
    assert.ok(idxGc > idxPreparedComplete, 'GC must run after prepared receipt cleanup')

    const deployStart = src.indexOf('cmd_deploy() {')
    assert.ok(deployStart > 0)
    const resumeBlock = src.slice(deployStart, deployStart + 1400)
    const idxCc5 = resumeBlock.indexOf('cc5_activation_finalize')
    const idxResumeReferee = resumeBlock.indexOf('v5_selfhost_post_committed_sync_referee')
    assert.ok(idxCc5 > 0 && idxResumeReferee > idxCc5, 'resume forward recovery should refresh referee after cc5 finalize')
  })
})

describe("OCV5-918 Fix #5 + Blocker #3: zero bare 'git -C' & real GIT_TEST_ASSUME_DIFFERENT_OWNER=1", () => {
  test("static check: zero bare 'git -C' across deploy-v5-selfhost.sh, v5-selfhost-master-release-lib.sh, and sync-referee.sh", () => {
    for (const [label, filePath, expectedSafeCount] of [
      ['scripts/deploy-v5-selfhost.sh', DEPLOY_SCRIPT, 4],
      ['scripts/v5-selfhost-master-release-lib.sh', MASTER_LIB, 11],
      ['scripts/harness-gate/sync-referee.sh', SYNC_REFEREE_SRC, 3],
    ] as const) {
      const lines = readFileSync(filePath, 'utf8').split('\n')
      const bareGitC: string[] = []
      const safeGitC: string[] = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (/^\s*#/.test(line)) continue
        if (/\bgit\s+-C\b/.test(line)) bareGitC.push(`L${i + 1}: ${line.trim()}`)
        if (/\bgit\s+-c\s+safe\.directory='\*'\s+-C\b/.test(line)) safeGitC.push(`L${i + 1}: ${line.trim()}`)
      }
      assert.deepEqual(bareGitC, [], `${label} still has bare 'git -C':\n${bareGitC.join('\n')}`)
      assert.equal(safeGitC.length, expectedSafeCount, `${label} safe.directory git count mismatch:\n${safeGitC.join('\n')}`)
    }
  })

  test('real cross-owner git (GIT_TEST_ASSUME_DIFFERENT_OWNER=1): bare git -C fails, while source_commit / --mint-flavor-manifest / master_web_dist_key / selfhost_prepare_identity all pass', (t) => {
    const { dir, env } = makeSandbox(t, 'ocv5-918-cross-owner-')
    const crossOwnerEnv: NodeJS.ProcessEnv = {
      ...env,
      GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
    }
    const expectedHead = execFileSync('git', ['-c', 'safe.directory=*', '-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
      env: crossOwnerEnv,
      encoding: 'utf8',
    }).trim()
    assert.match(expectedHead, /^[0-9a-f]{40}$/)

    // 0. Negative control: bare `git -C` MUST fail with dubious ownership under GIT_TEST_ASSUME_DIFFERENT_OWNER=1
    const bareCtrl = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
      env: crossOwnerEnv,
      encoding: 'utf8',
    })
    assert.notEqual(bareCtrl.status, 0, 'negative control: bare git -C must fail under GIT_TEST_ASSUME_DIFFERENT_OWNER=1')
    assert.match(bareCtrl.stderr, /dubious ownership/i)

    // 1. source_commit() from deploy-v5-selfhost.sh
    const deploySrc = readFileSync(DEPLOY_SCRIPT, 'utf8')
    const sourceCommitMatch = deploySrc.match(/^source_commit\(\) \{[\s\S]*?^\}/m)
    assert.ok(sourceCommitMatch)
    const scRes = runBash(
      `
      REPO_ROOT=${q(REPO_ROOT)}
      ${sourceCommitMatch[0]}
      source_commit
      `,
      crossOwnerEnv,
    )
    assert.equal(scRes.status, 0, `source_commit failed under GIT_TEST_ASSUME_DIFFERENT_OWNER=1:\n${scRes.stderr}`)
    assert.equal(scRes.stdout.trim(), expectedHead)

    // 2. --mint-flavor-manifest end-to-end
    const mintDest = join(dir, 'mint-dest')
    mkdirSync(mintDest, { recursive: true })
    const mintRes = spawnSync('bash', [DEPLOY_SCRIPT, '--mint-flavor-manifest', mintDest, 'selfhost'], {
      env: crossOwnerEnv,
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(
      mintRes.status,
      0,
      `--mint-flavor-manifest failed under GIT_TEST_ASSUME_DIFFERENT_OWNER=1:\n${mintRes.stdout}\n${mintRes.stderr}`,
    )
    const flavorManifest = JSON.parse(readFileSync(join(mintDest, 'flavor.manifest.json'), 'utf8'))
    assert.equal(flavorManifest.flavor, 'selfhost')
    assert.equal(flavorManifest.sourceCommit, expectedHead)

    // 3. master_web_dist_key() from v5-selfhost-master-release-lib.sh
    const webKeyRes = runBash(
      `
      REPO_ROOT=${q(REPO_ROOT)}
      source ${q(MASTER_LIB)}
      master_web_dist_key ${q(expectedHead)}
      `,
      crossOwnerEnv,
    )
    assert.equal(
      webKeyRes.status,
      0,
      `master_web_dist_key failed under GIT_TEST_ASSUME_DIFFERENT_OWNER=1:\n${webKeyRes.stdout}\n${webKeyRes.stderr}`,
    )
    assert.match(webKeyRes.stdout.trim(), /^[0-9a-f]{64}$/)

    // 4. selfhost_prepare_identity() from v5-selfhost-prepare.sh (+ train-guards pin load + master_web_dist_key)
    const bunStub = join(dir, 'fake-bun')
    writeFileSync(bunStub, '#!/usr/bin/env bash\necho 1.2.3\n')
    chmodSync(bunStub, 0o755)
    const prepIdRes = runBash(
      `
      REPO_ROOT=${q(REPO_ROOT)}
      SCRIPT_DIR=${q(join(REPO_ROOT, 'scripts'))}
      RUNTIME_IMAGE="openclaude/openclaude-runtime:v5-test"
      OC_BUN_BIN=${q(bunStub)}
      log() { :; }
      die() { echo "DIE: $*" >&2; exit 1; }
      docker() { echo "sha256:${'d'.repeat(64)}"; }
      source ${q(TRAIN_GUARDS_LIB)}
      source ${q(MASTER_LIB)}
      source ${q(PREPARE_LIB)}
      selfhost_prepare_identity ${q(expectedHead)}
      printf '%s\\n' "$SELFHOST_PREPARED_OPTIONS"
      `,
      crossOwnerEnv,
    )
    assert.equal(
      prepIdRes.status,
      0,
      `selfhost_prepare_identity failed under GIT_TEST_ASSUME_DIFFERENT_OWNER=1:\n${prepIdRes.stdout}\n${prepIdRes.stderr}`,
    )
    assert.match(prepIdRes.stdout.trim(), /^[0-9a-f]{64}$/)

    // 5. L0 rpf_check_source_pin + rpf_check_migrations + runtime_caps_from_metadata under GIT_TEST_ASSUME_DIFFERENT_OWNER=1
    const parentSha = execFileSync(
      'git',
      ['-c', 'safe.directory=*', '-C', REPO_ROOT, 'rev-parse', `${expectedHead}^`],
      { env: crossOwnerEnv, encoding: 'utf8' },
    ).trim()
    const rpfRes = runBash(
      `
      REPO_ROOT=${q(REPO_ROOT)}
      source ${q(join(REPO_ROOT, 'scripts/lib/v5-release-preflight.sh'))}
      source ${q(join(REPO_ROOT, 'scripts/lib/v5-selfhost-runtime-build.sh'))}
      classify_pending_migration_file() { return 0; }
      rpf_reset
      rpf_check_source_pin "$REPO_ROOT" ${q(expectedHead)}
      rpf_check_migrations "$REPO_ROOT" ${q(parentSha)} ${q(expectedHead)}
      rpf_report
      runtime_caps_from_metadata ${q(expectedHead)}
      `,
      crossOwnerEnv,
    )
    assert.equal(
      rpfRes.status,
      0,
      `rpf_check_migrations / runtime_caps_from_metadata failed under GIT_TEST_ASSUME_DIFFERENT_OWNER=1:\n${rpfRes.stdout}\n${rpfRes.stderr}`,
    )

    // 6. Legacy sync-referee binary rejecting explicit --preserve-other-transition fails safely (warn-only, non-zero rc, no silent overwrite)
    const legacyDir = join(dir, 'legacy-sync-check')
    const legacyGov = join(legacyDir, 'harness-gate')
    const legacyBin = join(legacyGov, 'bin/sync-referee')
    const legacyRel = join(legacyDir, 'rel-legacy')
    const legacyLive = join(legacyDir, 'live')
    mkdirSync(join(legacyGov, 'bin'), { recursive: true })
    mkdirSync(legacyRel, { recursive: true })
    writeFileSync(join(legacyRel, '.complete'), JSON.stringify({ schemaVersion: 2, sourceCommit: expectedHead }))
    symlinkSync(legacyRel, legacyLive)
    writeFileSync(
      legacyBin,
      `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live-link) shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
echo "SHOULD_NOT_OVERWRITE"
`,
    )
    chmodSync(legacyBin, 0o755)
    const legacyRes = runBash(
      `
      source ${q(TRAIN_GUARDS_LIB)}
      tsum_note() { :; }
      export OC_GOVERNOR_ROOT=${q(legacyGov)}
      export MASTER_LIVE_LINK=${q(legacyLive)}
      v5_selfhost_post_committed_sync_referee ${q(legacyRel)} ${q(expectedHead)}
      `,
      env,
    )
    assert.equal(legacyRes.status, 2, `legacy sync-referee must reject explicit --preserve-other-transition flag safely: ${legacyRes.stdout}`)
    assert.match(legacyRes.stdout, /--preserve-other-transition/)
    assert.doesNotMatch(legacyRes.stdout, /SHOULD_NOT_OVERWRITE/)
  })
})
