/**
 * OCV5-903 / OCV5-904: Comprehensive Real State-Machine & Isolation Test Suite for:
 *   - B1: Safe first-rollout & host root-staged audited transition referee (3-step E2E)
 *   - B4: Complete external referee execution chain isolation & zero-missed-file candidate scanning
 *   - B5: 45s debounce, 3-state CI classification (queued -> in_progress -> success / failed),
 *         trusted CI events (reject workflow_dispatch), and safe FF CAS (changes() == 1)
 *   - B6: Post-cutover retention gate BEFORE committed (legacy & user-impact-only policy paths),
 *         mid-retention worker tick non-settlement, verified rollback -> failed, rollback failure -> recovery_required
 *   - B7 (+ Non-blocker 2): Shared forward cutover guard boundary (cmd_deploy & standalone cmd_cutover),
 *         physical oc-governor check-blast-radius, trusted 3-workflow CI green, trailer escape removal
 *   - B8: Commit-bound runtime image pin (immune to dirty worktree corruption) & rollback isolation
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { signArchStewardReceipt } from '../lib/archStewardReceipt.js'
import { ARCH_STEWARD_RECEIPT_SCHEMA_VERSION } from '../lib/archStewardTypes.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GOV_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-governance-gates.sh')
const TRAIN_GUARDS_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-train-guards.sh')
const RELEASE_POLICY_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-release-policy.sh')
const RELEASE_POLICY_PY = join(REPO_ROOT, 'scripts/lib/v5-release-policy.py')
const PREPARE_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-prepare.sh')
const ROLLBACK_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-rollback.sh')
const DEPLOY_SCRIPT = join(REPO_ROOT, 'scripts/deploy-v5-selfhost.sh')
const MASTER_LIB = join(REPO_ROOT, 'scripts/v5-selfhost-master-release-lib.sh')
const SURVIVOR_SCRIPT = join(REPO_ROOT, 'scripts/v5-selfhost-cutover-survivor.sh')
const LEASE_WORKER = join(REPO_ROOT, 'scripts/v5-lease-worker.sh')
const LEASE_CLI = join(REPO_ROOT, 'scripts/oc-lease.sh')
const LEASE_LIB = join(REPO_ROOT, 'scripts/v5-lease-lib.sh')
const DEBOUNCE_LIB = join(REPO_ROOT, 'scripts/lib/v5-lease-train-debounce.sh')
const OC_GOVERNOR = join(REPO_ROOT, 'scripts/harness-gate/oc-governor.sh')

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

function makeSandbox(t: { after: (fn: () => void) => void }, prefix = 'ocv5-903-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
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

function makeTempGitRepo(t: { after: (fn: () => void) => void }, branch = 'feat/v5-selfhost') {
  const sb = makeSandbox(t, 'ocv5-903-git-')
  const repo = join(sb.dir, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env: sb.env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', branch)
  git('config', 'user.name', 'referee-test')
  git('config', 'user.email', 'referee-test@example.invalid')
  return { ...sb, repo, git }
}

function runBash(body: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('bash', ['--noprofile', '--norc', '-Eeu', '-o', 'pipefail', '-c', body], {
    env,
    encoding: 'utf8',
    timeout: 180_000,
  })
}

function runBashAsync(
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-Eeu', '-o', 'pipefail', '-c', body], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

const REQUIRED_GOV_STUBS = [
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
  'scripts/check-rest-contract-compat.ts',
  'scripts/check-monotonic-baselines.ts',
  'scripts/check-file-size-ratchet.ts',
  'scripts/check-gate-couplings.ts',
  'scripts/check-pg-migration-safety.ts',
  'scripts/check-changelog-guard.ts',
]

function seedGovStubs(root: string, markerLogPath?: string) {
  for (const rel of REQUIRED_GOV_STUBS) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    if (markerLogPath) {
      writeFileSync(
        abs,
        `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(markerLogPath)}, ${JSON.stringify(rel)} + ' ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n`,
      )
    } else {
      writeFileSync(abs, 'process.exit(0)\n')
    }
  }
  const biome = join(root, 'scripts/check-biome-changed.sh')
  writeFileSync(
    biome,
    markerLogPath
      ? `#!/usr/bin/env bash\necho "scripts/check-biome-changed.sh $*" >> ${q(markerLogPath)}\nexit 0\n`
      : '#!/usr/bin/env bash\nexit 0\n',
  )
  chmodSync(biome, 0o755)
}

function writeRefereeManifest(
  refDir: string,
  extraMeta: Record<string, unknown> = {},
): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, ent.name)
      const rel = relative(refDir, full).replaceAll('\\', '/')
      if (rel === 'MANIFEST.json' || rel === 'node_modules') continue
      if (ent.isDirectory()) walk(full)
      else if (ent.isFile()) {
        files[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
      }
    }
  }
  walk(refDir)
  const manifestPath = join(refDir, 'MANIFEST.json')
  if (existsSync(manifestPath)) chmodSync(manifestPath, 0o644)
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        fileCount: Object.keys(files).length,
        files,
        ...extraMeta,
      },
      null,
      2,
    )}\n`,
  )
  chmodSync(join(refDir, 'MANIFEST.json'), 0o444)
  return files
}

function writeA0ApprovalReceipt(opts: {
  approvalFile: string
  sha: string
  reason: string
  issuedAt?: string
  expiresAt?: string
  allowedPaths?: string[]
  hmacKey?: string
}): string {
  mkdirSync(dirname(opts.approvalFile), { recursive: true })
  const issuedAt = opts.issuedAt ?? new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const apStr = opts.allowedPaths
    ? JSON.stringify([...new Set(opts.allowedPaths.map((p) => p.trim()))].sort())
    : '*'
  const canonical =
    `a0-approval-v1\nsha=${opts.sha}\nissuedAt=${issuedAt}\nexpiresAt=${expiresAt}\nreason=${opts.reason.trim()}\nallowedPaths=${apStr}\n`
  const sha256 = createHash('sha256').update(canonical, 'utf8').digest('hex')
  const doc: Record<string, unknown> = {
    schemaVersion: 1,
    sha: opts.sha,
    reason: opts.reason,
    approvedBy: 'root-test',
    issuedAt,
    expiresAt,
    sha256,
  }
  if (opts.allowedPaths) doc.allowedPaths = opts.allowedPaths
  if (opts.hmacKey) {
    doc.hmacSha256 = createHmac('sha256', opts.hmacKey).update(canonical, 'utf8').digest('hex')
  }
  const raw = `${JSON.stringify(doc, null, 2)}\n`
  writeFileSync(opts.approvalFile, raw)
  chmodSync(opts.approvalFile, 0o644)
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function stageAuditedTransitionReferee(opts: {
  refDir: string
  targetSha: string
  approvalFile: string
  approvalSha256: string
}) {
  const transitionPath = join(opts.refDir, 'TRANSITION_APPROVAL.json')
  if (existsSync(transitionPath)) chmodSync(transitionPath, 0o644)
  writeFileSync(
    transitionPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'transition-audited',
        targetSha: opts.targetSha,
        stagedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        stagedBy: 'root-test',
        approvalFile: opts.approvalFile,
        approvalSha256: opts.approvalSha256,
      },
      null,
      2,
    )}\n`,
  )
  chmodSync(transitionPath, 0o444)
  writeRefereeManifest(opts.refDir, {
    mode: 'transition-audited',
    targetSha: opts.targetSha,
    sourceCommit: opts.targetSha,
  })
}

function exportArchive(
  repo: string,
  sha: string,
  staging: string,
  env: NodeJS.ProcessEnv,
  linkNodeModules = true,
) {
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const r = spawnSync(
    'bash',
    ['-euo', 'pipefail', '-c', `git -C ${q(repo)} archive --format=tar ${q(sha)} | tar -x -C ${q(staging)}`],
    { env, encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  if (linkNodeModules) {
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(staging, 'node_modules'))
  }
}

function extractBashFn(src: string, name: string): string {
  const m = src.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, 'm'))
  assert.ok(m, `missing bash function ${name}`)
  return m[0]
}

// ═════════════════════════════════════════════════════════════════════════════
// B1: 3-Step E2E Acceptance — Old Referee Rejects -> Audited Transition Referee
//     (exact SHA only, bad baseline still red) -> Permanent New Referee
// ═════════════════════════════════════════════════════════════════════════════
describe('B1. Safe first-rollout & host-staged audited transition referee (3-step E2E)', () => {
  test('Step 1 old referee blocks unauthorized schema upgrade -> Step 2 audited transition referee passes exact SHA only & blocks tampered baseline -> Step 3 permanent new referee blocks bad baseline', (t) => {
    const f = makeTempGitRepo(t)
    const staging = join(f.dir, 'staging')
    const gateTmp = join(f.dir, 'gate-tmp')
    const ctrlDir = join(f.dir, 'governor/control')
    const approvalsDir = join(ctrlDir, 'a0-approvals')
    const refDir = join(f.dir, 'referee')
    const noLive = join(f.dir, 'no-live')
    mkdirSync(gateTmp, { recursive: true })
    mkdirSync(approvalsDir, { recursive: true })
    mkdirSync(refDir, { recursive: true })

    // Create 0600 HMAC key next to approvalsDir (<dirname(approvalDir)>/.hmac-key)
    const hmacKey = 'test-root-hmac-secret-key-0123456789abcdef'
    const hmacKeyFile = join(ctrlDir, '.hmac-key')
    writeFileSync(hmacKeyFile, `${hmacKey}\n`)
    chmodSync(hmacKeyFile, 0o600)

    // Schema validator script simulating base v1 referee vs upgraded v2 referee:
    // - v1 referee: ONLY accepts schemaVersion===1 and maxBudget<=500
    // - v2 referee: accepts schemaVersion===2 AND still strictly enforces maxBudget<=500
    const v1CheckerSrc = `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const rootIdx = process.argv.indexOf('--root')
const root = rootIdx >= 0 ? process.argv[rootIdx + 1]! : process.cwd()
const doc = JSON.parse(readFileSync(join(root, 'arch/schema-budget.json'), 'utf8'))
if (doc.schemaVersion !== 1) {
  console.error('OLD-REFEREE-V1-REJECTED-SCHEMA:' + doc.schemaVersion)
  process.exit(1)
}
if (doc.maxBudget > 500) {
  console.error('BUDGET-EXCEEDED:' + doc.maxBudget)
  process.exit(1)
}
process.exit(0)
`
    const v2CheckerSrc = `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const rootIdx = process.argv.indexOf('--root')
const root = rootIdx >= 0 ? process.argv[rootIdx + 1]! : process.cwd()
const doc = JSON.parse(readFileSync(join(root, 'arch/schema-budget.json'), 'utf8'))
if (doc.schemaVersion !== 2) {
  console.error('NEW-REFEREE-V2-REJECTED-SCHEMA:' + doc.schemaVersion)
  process.exit(1)
}
if (doc.maxBudget > 500) {
  console.error('NEW-REFEREE-V2-BAD-BASELINE-RED:' + doc.maxBudget)
  process.exit(1)
}
process.exit(0)
`

    // Base commit (schema v1)
    seedGovStubs(f.repo)
    mkdirSync(join(f.repo, 'arch'), { recursive: true })
    writeFileSync(join(f.repo, 'changelog.json'), '[]\n')
    writeFileSync(join(f.repo, 'scripts/check-monotonic-baselines.ts'), v1CheckerSrc)
    writeFileSync(join(f.repo, 'arch/schema-budget.json'), JSON.stringify({ schemaVersion: 1, maxBudget: 500 }))
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): base schema v1')
    const baseSha = f.git('rev-parse', 'HEAD')

    // Candidate commit: upgrades schema to v2 AND updates its own staging script to v2
    writeFileSync(join(f.repo, 'scripts/check-monotonic-baselines.ts'), v2CheckerSrc)
    writeFileSync(join(f.repo, 'arch/schema-budget.json'), JSON.stringify({ schemaVersion: 2, maxBudget: 480 }))
    f.git('add', '.')
    f.git('commit', '-qm', 'feat(v5): upgrade baseline schema v1 -> v2')
    const upgradeSha = f.git('rev-parse', 'HEAD')

    // Another commit (bad baseline on schema v2, budget raised to 999)
    writeFileSync(join(f.repo, 'arch/schema-budget.json'), JSON.stringify({ schemaVersion: 2, maxBudget: 999 }))
    f.git('add', '.')
    f.git('commit', '-qm', 'feat(v5): tamper bad baseline on v2')
    const badBaselineSha = f.git('rev-parse', 'HEAD')

    // Clean follow-up commit on v2 (after upgradeSha)
    f.git('checkout', '-q', upgradeSha)
    writeFileSync(join(f.repo, 'arch/schema-budget.json'), JSON.stringify({ schemaVersion: 2, maxBudget: 450 }))
    f.git('add', '.')
    f.git('commit', '-qm', 'refactor(v5): shrink v2 budget further')
    const cleanFollowupSha = f.git('rev-parse', 'HEAD')

    const runGates = (sha: string, extraEnv: Record<string, string> = {}) => {
      exportArchive(f.repo, sha, staging, f.env, false)
      return runBash(
        [
          'mlog() { echo "$*" >&2; }',
          'tsum_note() { :; }',
          `source ${q(GOV_LIB)}`,
          `REPO_ROOT=${q(f.repo)}`,
          `MASTER_LIVE_LINK=${q(noLive)}`,
          `OC_V5_REFEREE_ROOT=${q(refDir)}`,
          `OC_V5_REFEREE_NODE_MODULES=${q(join(REPO_ROOT, 'node_modules'))}`,
          `MASTER_GATE_TMPDIR=${q(gateTmp)}`,
          `OC_V5_GOVERNANCE_BASE_REF=${q(baseSha)}`,
          `master_run_governance_fast_gates ${q(staging)} ${q(sha)}`,
        ].join('\n'),
        { ...f.env, ...extraEnv },
      )
    }

    // ── STEP ①: Base old v1 referee checks unauthorized schema v2 candidate → MUST FAIL (NEVER fallback to staging!)
    seedGovStubs(refDir)
    writeFileSync(join(refDir, 'scripts/check-monotonic-baselines.ts'), v1CheckerSrc)
    writeRefereeManifest(refDir, { sourceCommit: baseSha })
    chmodSync(refDir, 0o755)

    let r = runGates(upgradeSha)
    assert.notEqual(r.status, 0, 'Step 1: base v1 referee MUST reject unauthorized schema v2 upgrade')
    assert.match(r.stderr, /OLD-REFEREE-V1-REJECTED-SCHEMA:2/)

    // ── STEP ②: Host root pre-stages audited v2 transition referee bound to exact upgradeSha
    rmSync(refDir, { recursive: true, force: true })
    mkdirSync(refDir, { recursive: true })
    seedGovStubs(refDir)
    writeFileSync(join(refDir, 'scripts/check-monotonic-baselines.ts'), v2CheckerSrc)
    const approvalFile = join(approvalsDir, `${upgradeSha}.json`)
    // ②-0: Narrow allowedPaths approval MUST NOT authorize staging full transition referee (B1!)
    const narrowApprovalSha = writeA0ApprovalReceipt({
      approvalFile,
      sha: upgradeSha,
      reason: 'OCV5-903 narrow path approval must be rejected for referee swap',
      allowedPaths: ['arch/schema-budget.json', 'scripts/check-monotonic-baselines.ts'],
      hmacKey,
    })
    stageAuditedTransitionReferee({ refDir, targetSha: upgradeSha, approvalFile, approvalSha256: narrowApprovalSha })
    r = runGates(upgradeSha)
    assert.notEqual(r.status, 0, 'Step 2-0: narrow allowedPaths MUST NOT authorize full transition referee')
    assert.match(r.stderr, /禁止窄审批替换裁判/)

    // Now issue unrestricted A0 approval (allowedPaths omitted -> '*')
    const approvalSha256 = writeA0ApprovalReceipt({
      approvalFile,
      sha: upgradeSha,
      reason: 'OCV5-903 audited schema v1->v2 transition rollout',
      hmacKey,
    })
    stageAuditedTransitionReferee({ refDir, targetSha: upgradeSha, approvalFile, approvalSha256 })

    // ②-a: Exact bound upgradeSha passes!
    r = runGates(upgradeSha)
    assert.equal(r.status, 0, `Step 2a failed: ${r.stderr}`)
    assert.match(r.stderr, /\[referee-transition\] audited transition referee verified/)

    // ②-b: Different SHA (cleanFollowupSha != targetSha) MUST be rejected by transition referee!
    r = runGates(cleanFollowupSha)
    assert.notEqual(r.status, 0, 'Step 2b: transition referee MUST reject non-matching SHA')
    assert.match(r.stderr, /仅绑定 targetSha=.*拒绝用于非匹配候选/)

    // ②-c: Even if transition referee is staged for badBaselineSha, bad baseline MUST STILL FAIL (RED)!
    rmSync(refDir, { recursive: true, force: true })
    mkdirSync(refDir, { recursive: true })
    seedGovStubs(refDir)
    writeFileSync(join(refDir, 'scripts/check-monotonic-baselines.ts'), v2CheckerSrc)
    const badApprovalFile = join(approvalsDir, `${badBaselineSha}.json`)
    const badApprovalSha = writeA0ApprovalReceipt({
      approvalFile: badApprovalFile,
      sha: badBaselineSha,
      reason: 'OCV5-903 test audited transition against bad baseline',
      hmacKey,
    })
    stageAuditedTransitionReferee({
      refDir,
      targetSha: badBaselineSha,
      approvalFile: badApprovalFile,
      approvalSha256: badApprovalSha,
    })
    r = runGates(badBaselineSha)
    assert.notEqual(r.status, 0, 'Step 2c: audited transition referee MUST STILL block bad baseline!')
    assert.match(r.stderr, /NEW-REFEREE-V2-BAD-BASELINE-RED:999/)

    // ②-d: Security hardening checks on TRANSITION_APPROVAL.json / MANIFEST.json / HMAC downgrade
    // Tamper MANIFEST (modify script without updating MANIFEST) -> fail closed
    chmodSync(join(refDir, 'scripts/check-monotonic-baselines.ts'), 0o644)
    writeFileSync(join(refDir, 'scripts/check-monotonic-baselines.ts'), 'process.exit(0)\n')
    r = runGates(badBaselineSha)
    assert.notEqual(r.status, 0, 'tampered referee script vs MANIFEST must fail closed')
    assert.match(r.stderr, /MANIFEST\.json SHA-256 不匹配/)

    // Strip TRANSITION_APPROVAL.json while MANIFEST declares mode="transition-audited" -> fail closed
    rmSync(refDir, { recursive: true, force: true })
    mkdirSync(refDir, { recursive: true })
    seedGovStubs(refDir)
    writeFileSync(join(refDir, 'scripts/check-monotonic-baselines.ts'), v2CheckerSrc)
    stageAuditedTransitionReferee({ refDir, targetSha: upgradeSha, approvalFile, approvalSha256 })
    rmSync(join(refDir, 'TRANSITION_APPROVAL.json'))
    r = runGates(upgradeSha)
    assert.notEqual(r.status, 0, 'stripped TRANSITION_APPROVAL.json must fail closed')

    // Missing HMAC when .hmac-key exists (plain sha256 downgrade) -> fail closed
    rmSync(refDir, { recursive: true, force: true })
    mkdirSync(refDir, { recursive: true })
    seedGovStubs(refDir)
    writeFileSync(join(refDir, 'scripts/check-monotonic-baselines.ts'), v2CheckerSrc)
    const noHmacFile = join(approvalsDir, `${upgradeSha}.json`)
    const noHmacSha = writeA0ApprovalReceipt({
      approvalFile: noHmacFile,
      sha: upgradeSha,
      reason: 'plain sha256 downgrade attempt',
      // omit hmacKey while .hmac-key exists!
    })
    stageAuditedTransitionReferee({ refDir, targetSha: upgradeSha, approvalFile: noHmacFile, approvalSha256: noHmacSha })
    r = runGates(upgradeSha)
    assert.notEqual(r.status, 0, 'plain sha256 downgrade when .hmac-key exists must fail closed')
    assert.match(r.stderr, /hmacSha256/)

    // ── STEP ③: Permanent new v2 referee (no TRANSITION_APPROVAL.json) evaluates follow-up commits
    rmSync(refDir, { recursive: true, force: true })
    mkdirSync(refDir, { recursive: true })
    seedGovStubs(refDir)
    writeFileSync(join(refDir, 'scripts/check-monotonic-baselines.ts'), v2CheckerSrc)
    writeRefereeManifest(refDir, { sourceCommit: upgradeSha })

    // ③-a: Clean follow-up commit passes
    r = runGates(cleanFollowupSha)
    assert.equal(r.status, 0, `Step 3a failed: ${r.stderr}`)

    // ③-b: Bad baseline follow-up commit fails
    r = runGates(badBaselineSha)
    assert.notEqual(r.status, 0, 'Step 3b: permanent new referee MUST reject bad baseline')
    assert.match(r.stderr, /NEW-REFEREE-V2-BAD-BASELINE-RED:999/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// B4: Complete Referee Execution Chain Isolation & Zero-Missed Candidate Files
// ═════════════════════════════════════════════════════════════════════════════
describe('B4. External referee isolated execution chain & zero-missed candidate scanning', () => {
  test('never loads staging tsx/scripts/packages/protocol, strips loader env, scans real staging gatewayFiles > 0, and passes --base/--head to check-debt-ttl', (t) => {
    const f = makeTempGitRepo(t)
    const staging = join(f.dir, 'staging')
    const gateTmp = join(f.dir, 'gate-tmp')
    const refDir = join(f.dir, 'referee')
    const noLive = join(f.dir, 'no-live')
    const poisonMarker = join(f.dir, 'POISON_TRIGGERED.log')
    const debtArgsLog = join(f.dir, 'debt-args.log')
    const envProbeLog = join(f.dir, 'env-probe.log')
    mkdirSync(gateTmp, { recursive: true })
    mkdirSync(refDir, { recursive: true })

    // Candidate repo contains real packages/gateway/src files + poisoned staging scripts & packages/protocol!
    seedGovStubs(f.repo)
    mkdirSync(join(f.repo, 'packages/gateway/src'), { recursive: true })
    mkdirSync(join(f.repo, 'packages/protocol/src'), { recursive: true })
    mkdirSync(join(f.repo, 'arch'), { recursive: true })
    writeFileSync(join(f.repo, 'changelog.json'), '[]\n')
    writeFileSync(
      join(f.repo, 'packages/gateway/src/health.ts'),
      'export function pingGateway(x: number): number { return x + 1 }\n',
    )
    writeFileSync(
      join(f.repo, 'packages/protocol/src/httpContracts.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(poisonMarker)}, 'POISONED_STAGING_PROTOCOL\\n')\nexport function serializeRestContractSnapshot() { return {} }\n`,
    )
    writeFileSync(
      join(f.repo, 'scripts/check-security-sast.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(poisonMarker)}, 'POISONED_STAGING_SCRIPT\\n')\nprocess.exit(0)\n`,
    )
    writeFileSync(
      join(f.repo, 'arch/security-sast-baseline.json'),
      `${JSON.stringify({ schemaVersion: 1, summary: { totalEntries: 0, totalCount: 0, byRule: {} }, entries: {} }, null, 2)}\n`,
    )
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): base clean gateway')
    const baseSha = f.git('rev-parse', 'HEAD')

    writeFileSync(
      join(f.repo, 'packages/gateway/src/service.ts'),
      'export function runGatewayService(): string { return "ok" }\n',
    )
    f.git('add', '.')
    f.git('commit', '-qm', 'refactor(v5): add clean gateway service')
    const cleanSha = f.git('rev-parse', 'HEAD')

    // Build isolated trusted referee directory with REAL check-security-sast.ts, protocol import check, & check-debt-ttl probe
    seedGovStubs(refDir)
    mkdirSync(join(refDir, 'packages/protocol/src'), { recursive: true })
    writeFileSync(
      join(refDir, 'packages/protocol/src/httpContracts.ts'),
      'export const REFEREE_PROTOCOL_MARKER = "TRUSTED_REFEREE_PROTOCOL"\nexport function serializeRestContractSnapshot() { return { marker: REFEREE_PROTOCOL_MARKER } }\n',
    )
    writeFileSync(
      join(refDir, 'scripts/check-rest-contract-compat.ts'),
      `import { appendFileSync } from 'node:fs'
import { REFEREE_PROTOCOL_MARKER } from '../packages/protocol/src/httpContracts.js'
if (REFEREE_PROTOCOL_MARKER !== 'TRUSTED_REFEREE_PROTOCOL') process.exit(9)
appendFileSync(${JSON.stringify(envProbeLog)}, JSON.stringify({
  marker: REFEREE_PROTOCOL_MARKER,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  nodePath: process.env.NODE_PATH ?? null,
  tsxTsconfig: process.env.TSX_TSCONFIG_PATH ?? null,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
}) + '\\n')
process.exit(0)
`,
    )
    // Copy REAL check-security-sast.ts + its prodFileDiscovery helper into referee to prove real --root "$staging" scanning finds gatewayFiles > 0!
    cpSync(join(REPO_ROOT, 'scripts/check-security-sast.ts'), join(refDir, 'scripts/check-security-sast.ts'))
    mkdirSync(join(refDir, 'scripts/lib'), { recursive: true })
    cpSync(join(REPO_ROOT, 'scripts/lib/prodFileDiscovery.ts'), join(refDir, 'scripts/lib/prodFileDiscovery.ts'))
    // B4 behavioral eval isolation probe in check-context-static.ts: verify env -i stripped host secrets + unprivileged nobody (65534) when root!
    const ctxProbeOut = join(f.dir, 'ctx-isolation-probe.json')
    writeFileSync(ctxProbeOut, '', { mode: 0o666 })
    chmodSync(ctxProbeOut, 0o666)
    chmodSync(f.dir, 0o755)
    writeFileSync(
      join(refDir, 'scripts/check-context-static.ts'),
      `import { writeFileSync } from 'node:fs'
let writeRefBlocked = false
try {
  writeFileSync(${JSON.stringify(join(refDir, 'escape-attempt.txt'))}, 'pwn')
} catch {
  writeRefBlocked = true
}
writeFileSync(${JSON.stringify(ctxProbeOut)}, JSON.stringify({
  uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
  secretProbe: process.env.OC_SECRET_PROBE ?? null,
  writeRefBlocked,
}))
process.exit(0)
`,
    )
    writeFileSync(
      join(refDir, 'scripts/check-debt-ttl.ts'),
      `// supports --base --head
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(debtArgsLog)}, process.argv.slice(2).join(' ') + '\\n')
process.exit(0)
`,
    )
    writeRefereeManifest(refDir, { sourceCommit: baseSha })
    // Attach trusted node_modules to referee
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(refDir, 'node_modules'))

    const poisonStagingNodeModules = (stg: string) => {
      const fakeBin = join(stg, 'node_modules/.bin')
      const fakeTsx = join(stg, 'node_modules/tsx/dist')
      mkdirSync(fakeBin, { recursive: true })
      mkdirSync(fakeTsx, { recursive: true })
      writeFileSync(
        join(fakeBin, 'tsx'),
        `#!/usr/bin/env bash\necho "POISONED_STAGING_TSX_BIN" >> ${q(poisonMarker)}\nexit 0\n`,
      )
      chmodSync(join(fakeBin, 'tsx'), 0o755)
      writeFileSync(
        join(fakeTsx, 'cli.mjs'),
        `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(poisonMarker)}, 'POISONED_STAGING_TSX_CLI\\n')\nprocess.exit(0)\n`,
      )
    }

    exportArchive(f.repo, cleanSha, staging, f.env, false)
    poisonStagingNodeModules(staging)

    chmodSync(refDir, 0o555)
    let res: ReturnType<typeof runBash>
    try {
      res = runBash(
        [
          'mlog() { echo "$*" >&2; }',
          'tsum_note() { :; }',
          `source ${q(GOV_LIB)}`,
          `REPO_ROOT=${q(f.repo)}`,
          `MASTER_LIVE_LINK=${q(noLive)}`,
          `OC_V5_REFEREE_ROOT=${q(refDir)}`,
          `MASTER_GATE_TMPDIR=${q(gateTmp)}`,
          `OC_V5_GOVERNANCE_BASE_REF=${q(baseSha)}`,
          `master_run_governance_fast_gates ${q(staging)} ${q(cleanSha)}`,
        ].join('\n'),
        {
          ...f.env,
          NODE_OPTIONS: '--require=/nonexistent/poison-preload.cjs',
          NODE_PATH: '/nonexistent/poison-node-path',
          TSX_TSCONFIG_PATH: '/nonexistent/poison-tsconfig.json',
          GH_TOKEN: 'ghp_must_be_stripped_in_context_eval',
          GITHUB_TOKEN: 'ghs_must_be_stripped_in_context_eval',
          OC_SECRET_PROBE: 'host_secret_must_never_leak',
        },
      )
    } finally {
      chmodSync(refDir, 0o755)
    }
    assert.equal(res.status, 0, res.stderr + res.stdout)
    assert.equal(existsSync(poisonMarker), false, 'MUST NEVER execute poisoned staging tsx, script, or protocol!')

    // Verify B4 behavioral eval ran with env -i (zero leaked secrets) and unprivileged nobody (65534) when root!
    const ctxProbe = JSON.parse(readFileSync(ctxProbeOut, 'utf8'))
    assert.equal(ctxProbe.ghToken, null, 'GH_TOKEN must be stripped by env -i in check-context-static.ts')
    assert.equal(ctxProbe.githubToken, null, 'GITHUB_TOKEN must be stripped by env -i in check-context-static.ts')
    assert.equal(ctxProbe.secretProbe, null, 'host env vars must be stripped by env -i in check-context-static.ts')
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      assert.equal(ctxProbe.uid, 65534, 'check-context-static.ts MUST drop privileges to nobody (65534) when running as root')
      assert.equal(ctxProbe.writeRefBlocked, true, 'unprivileged context eval MUST be blocked from writing to referee dir')
    }

    // Verify env vars stripped & trusted protocol loaded & --root "$staging" passed
    const probe = JSON.parse(readFileSync(envProbeLog, 'utf8').trim())
    assert.equal(probe.marker, 'TRUSTED_REFEREE_PROTOCOL')
    assert.equal(probe.nodeOptions, null, 'NODE_OPTIONS must be stripped')
    assert.equal(probe.nodePath, null, 'NODE_PATH must be stripped')
    assert.equal(probe.tsxTsconfig, null, 'TSX_TSCONFIG_PATH must be stripped')
    assert.ok(!probe.cwd.startsWith(realpathSync(staging)), 'referee cwd must NOT be inside staging')
    assert.ok(probe.argv.includes('--root') && probe.argv.includes(staging), 'must pass --root $staging')

    // Verify check-debt-ttl received --root $staging --enforce --base $baseSha --head $cleanSha
    const debtArgs = readFileSync(debtArgsLog, 'utf8').trim()
    assert.match(debtArgs, new RegExp(`--root ${staging.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(debtArgs, new RegExp(`--base ${baseSha}`))
    assert.match(debtArgs, new RegExp(`--head ${cleanSha}`))

    // Verify real check-security-sast scanned >= 2 files in $staging/packages/gateway/src!
    const sastMatch = (res.stdout + res.stderr).match(/\[security-sast\] files=(\d+)/)
    assert.ok(sastMatch, `expected security-sast output in:\n${res.stdout}\n${res.stderr}`)
    assert.ok(Number(sastMatch[1]) >= 2, `expected gatewayFiles >= 2 scanned, got ${sastMatch[1]}`)

    // Verify isolated referee view has ZERO symlinks pointing into $staging!
    const viewDir = join(gateTmp, readdirSync(gateTmp).find((d) => d.startsWith('referee-view-'))!)
    const stagingReal = realpathSync(staging)
    const walkCheck = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name)
        const lst = lstatSync(p)
        if (lst.isSymbolicLink()) {
          const targetReal = realpathSync(p)
          assert.ok(
            !targetReal.startsWith(stagingReal),
            `referee view symlink ${p} must NEVER point into staging (${targetReal})`,
          )
        } else if (ent.isDirectory()) {
          walkCheck(p)
        }
      }
    }
    walkCheck(viewDir)

    // Inject real secret leak in $staging/packages/gateway/src/leak.ts -> real referee SAST MUST catch it!
    const syntheticAwsKey = ['AKIA', '9K7M2P4Q', '8R6T3V5W'].join('')
    writeFileSync(
      join(f.repo, 'packages/gateway/src/leak.ts'),
      `export const realLeak = "${syntheticAwsKey}"\n`,
    )
    f.git('add', '.')
    f.git('commit', '-qm', 'feat(v5): leak secret in gateway')
    const leakSha = f.git('rev-parse', 'HEAD')
    exportArchive(f.repo, leakSha, staging, f.env, false)
    poisonStagingNodeModules(staging)

    const leakRes = runBash(
      [
        'mlog() { echo "$*" >&2; }',
        'tsum_note() { :; }',
        `source ${q(GOV_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `MASTER_LIVE_LINK=${q(noLive)}`,
        `OC_V5_REFEREE_ROOT=${q(refDir)}`,
        `MASTER_GATE_TMPDIR=${q(gateTmp)}`,
        `OC_V5_GOVERNANCE_BASE_REF=${q(baseSha)}`,
        `master_run_governance_fast_gates ${q(staging)} ${q(leakSha)}`,
      ].join('\n'),
      f.env,
    )
    assert.notEqual(leakRes.status, 0, 'real referee SAST must catch secret leak in $staging/packages/gateway/src')
    assert.match(leakRes.stderr + leakRes.stdout, /SECURITY-SAST|SEC-SECRET/)
    assert.equal(existsSync(poisonMarker), false)

    // Missing trusted referee node_modules MUST fail closed (never borrow $staging/node_modules!)
    rmSync(join(refDir, 'node_modules'))
    const noNmRes = runBash(
      [
        'mlog() { echo "$*" >&2; }',
        'tsum_note() { :; }',
        `source ${q(GOV_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `MASTER_LIVE_LINK=${q(noLive)}`,
        `OC_V5_REFEREE_ROOT=${q(refDir)}`,
        `MASTER_GATE_TMPDIR=${q(gateTmp)}`,
        `master_resolve_referee_node_modules ${q(refDir)} ${q(staging)}`,
      ].join('\n'),
      f.env,
    )
    assert.notEqual(noNmRes.status, 0, 'referee mode without trusted node_modules MUST fail closed')
    assert.match(noNmRes.stderr, /严禁借用候选 \$staging\/node_modules/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// B5: 45s Debounce + 3-State CI (queued -> in_progress -> success / failed)
//     + Trusted Events (reject workflow_dispatch) + Safe FF CAS (changes()==1)
// ═════════════════════════════════════════════════════════════════════════════
describe('B5. 45s debounce, 3-state CI classification, trusted events & safe FF CAS', () => {
  test('full ride state machine: queued -> in_progress (stays registered!) -> workflow_dispatch rejected -> trusted push success -> dispatched -> satisfied with zero re-registration', (t) => {
    const sb = makeSandbox(t, 'ocv5-903-b5-')
    const origin = join(sb.dir, 'origin.git')
    const wt = join(sb.dir, 'wt')
    const pushWt = join(sb.dir, 'push-wt')
    const releases = join(sb.dir, 'releases')
    const bin = join(sb.dir, 'bin')
    const logs = join(sb.dir, 'logs')
    const runDir = join(sb.dir, 'run')
    const db = join(sb.dir, 'lease.db')
    const modeFile = join(sb.dir, 'mode.json')
    const startsLog = join(sb.dir, 'deploy-starts.log')
    const ghRespFile = join(sb.dir, 'gh-runs.json')
    const fakeDeploy = join(bin, 'fake-deploy.sh')
    const fakeTask = join(bin, 'fake-oc-task')
    const fakeGh = join(bin, 'gh')
    mkdirSync(releases, { recursive: true })
    mkdirSync(bin, { recursive: true })
    mkdirSync(logs, { recursive: true })
    mkdirSync(runDir, { recursive: true })

    const g = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { env: sb.env, encoding: 'utf8' }).trim()
    execFileSync('git', ['init', '-q', '--bare', origin], { env: sb.env })
    execFileSync('git', ['init', '-q', '-b', 'feat/v5-selfhost', wt], { env: sb.env })
    g(wt, 'config', 'user.name', 'worker-test')
    g(wt, 'config', 'user.email', 'worker-test@example.invalid')
    const mk = (cwd: string, name: string) => {
      writeFileSync(join(cwd, name), `${name}\n`)
      g(cwd, 'add', '-A')
      g(cwd, 'commit', '-qm', `bug(v5): ${name}`)
      return g(cwd, 'rev-parse', 'HEAD')
    }
    const c0 = mk(wt, 'c0')
    const c1 = mk(wt, 'c1')
    const c2 = mk(wt, 'c2')
    g(wt, 'remote', 'add', 'origin', origin)
    g(wt, 'push', '-q', 'origin', 'feat/v5-selfhost')

    // Live starts at c0
    const rel0 = join(releases, `rel-${c0}`)
    mkdirSync(rel0, { recursive: true })
    writeFileSync(join(rel0, '.complete'), JSON.stringify({ sourceCommit: c0 }))
    symlinkSync(rel0, join(sb.dir, 'live'))
    writeFileSync(join(runDir, 'survivor.state'), 'phase=committed\n')
    writeFileSync(join(runDir, 'survivor.committed'), 'committed_at=2026-11-26T00:00:00Z\n')

    // Fake deploy records launch AND simulates commit of c2 (updates live & train status to committed)
    const rel2 = join(releases, `rel-${c2}`)
    mkdirSync(rel2, { recursive: true })
    writeFileSync(join(rel2, '.complete'), JSON.stringify({ sourceCommit: c2 }))
    writeFileSync(
      fakeDeploy,
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> ${q(startsLog)}`,
        `ln -sfn ${q(rel2)} ${q(join(sb.dir, 'live'))}`,
        `printf 'phase=committed\\n' > ${q(join(runDir, 'survivor.state'))}`,
        `sqlite3 -cmd ".timeout 10000" ${q(db)} "UPDATE train SET status='committed', rel_path='${rel2}', finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id='$OC_V5_LEASE_TRAIN_ID';"`,
        'exit 0',
      ].join('\n'),
    )
    chmodSync(fakeDeploy, 0o755)
    writeFileSync(fakeTask, '#!/usr/bin/env bash\necho "{}"\nexit 0\n')
    chmodSync(fakeTask, 0o755)
    writeFileSync(fakeGh, `#!/usr/bin/env bash\ncat ${q(ghRespFile)}\n`)
    chmodSync(fakeGh, 0o755)

    const workerEnv: NodeJS.ProcessEnv = {
      ...sb.env,
      OC_V5_AUTORECOVER: 'off',
      OC_V5_LEASE_DB: db,
      OC_V5_LEASE_LOCK: join(runDir, 'lease-db.lock'),
      OC_V5_LEASE_WORKER_LOCK: join(runDir, 'worker.lock'),
      OC_V5_SELFHOST_DEPLOY_LOCK: join(runDir, 'deploy.lock'),
      OC_V5_LEASE_LIVE_LINK: join(sb.dir, 'live'),
      OC_V5_LEASE_SURVIVOR_STATE: join(runDir, 'survivor.state'),
      OC_V5_LEASE_SURVIVOR_COMMITTED: join(runDir, 'survivor.committed'),
      OC_V5_LEASE_CUTOVER_GRACE_FILE: join(runDir, 'grace'),
      OC_V5_LEASE_REPO_ROOT: wt,
      OC_V5_LEASE_BRANCH: 'feat/v5-selfhost',
      OC_V5_LEASE_LOG_DIR: logs,
      OC_V5_LEASE_DEPLOY_BIN: fakeDeploy,
      OC_V5_LEASE_TASK_CLI: fakeTask,
      OC_V5_GOVERNOR_MODE_FILE: modeFile,
      OC_V5_TRAIN_DEBOUNCE_SEC: '45',
      OC_V5_GH_BIN: fakeGh,
      OC_V5_GH_REPO: 'dream-star-end/openclaude',
      OC_V5_WORKER_CI_REQUIRED: '1',
      OC_USER_ID: '3',
      INVOCATION_ID: '',
    }

    // Register ONE ride for c2 (never re-registered!)
    let r = spawnSync(
      'bash',
      [LEASE_CLI, 'register', '--resource', 'deploy:selfhost', '--mode', 'ride', '--sha', c2, '--owner', 'agent-b5', '--callback', 'none'],
      { env: workerEnv, encoding: 'utf8' },
    )
    assert.equal(r.status, 0, r.stderr)
    const rideId = execFileSync('sqlite3', ['-noheader', db, 'SELECT id FROM lease;'], { encoding: 'utf8' }).trim()
    const minEpoch = Number(
      execFileSync('sqlite3', ['-noheader', db, "SELECT CAST(strftime('%s', created_at) AS INTEGER) FROM lease;"], { encoding: 'utf8' }).trim(),
    )

    const sqlVal = (qStr: string) =>
      execFileSync('sqlite3', ['-noheader', db, qStr], { encoding: 'utf8' }).trim()

    const tick = (nowEpoch: number, extraEnv: Record<string, string> = {}) =>
      spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-euo',
          'pipefail',
          '-c',
          `source ${q(LEASE_WORKER)}; lease_deploy_process_running() { return 1; }; main`,
        ],
        { env: { ...workerEnv, ...extraEnv, OC_V5_NOW_EPOCH: String(nowEpoch) }, encoding: 'utf8', timeout: 60_000 },
      )

    const setRuns = (runs: Array<Record<string, unknown>>) => {
      writeFileSync(ghRespFile, JSON.stringify({ workflow_runs: runs }))
    }

    // Tick 1 (+15s): inside 45s debounce -> stays registered, 0 trains
    setRuns([
      { id: 1, name: 'V5 selfhost gates', path: '.github/workflows/v5-selfhost-gates.yml', head_sha: c2, event: 'push', status: 'queued', conclusion: null, created_at: '2026-11-26T10:00:00Z' },
    ])
    r = tick(minEpoch + 15)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(sqlVal('SELECT status FROM lease;'), 'registered')
    assert.equal(sqlVal('SELECT COUNT(*) FROM train;'), '0')

    // Tick 2 (+50s): CI queued -> pending! MUST NOT create train, MUST keep ride registered!
    r = tick(minEpoch + 50)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /CI 仍在运行\/排队/)
    assert.equal(sqlVal('SELECT status FROM lease;'), 'registered', 'queued CI must keep ride registered')
    assert.equal(sqlVal('SELECT COUNT(*) FROM train;'), '0', 'queued CI must NOT create train')

    // Tick 3 (+80s): CI in_progress -> pending! MUST keep ride registered!
    setRuns([
      { id: 1, name: 'V5 selfhost gates', path: '.github/workflows/v5-selfhost-gates.yml', head_sha: c2, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
      { id: 2, name: 'V5 selfhost release gates', path: '.github/workflows/v5-selfhost-release-gates.yml', head_sha: c2, event: 'push', status: 'in_progress', conclusion: null, created_at: '2026-11-26T10:01:00Z' },
      { id: 3, name: 'V5 selfhost commercial', path: '.github/workflows/v5-selfhost-commercial.yml', head_sha: c2, event: 'push', status: 'queued', conclusion: null, created_at: '2026-11-26T10:01:00Z' },
    ])
    r = tick(minEpoch + 80)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(sqlVal('SELECT status FROM lease;'), 'registered', 'in_progress CI must keep ride registered')
    assert.equal(sqlVal('SELECT COUNT(*) FROM train;'), '0')

    // Tick 4 (+110s): workflow_dispatch green ONLY for commercial -> MUST REJECT untrusted event!
    setRuns([
      { id: 1, name: 'V5 selfhost gates', path: '.github/workflows/v5-selfhost-gates.yml', head_sha: c2, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
      { id: 2, name: 'V5 selfhost release gates', path: '.github/workflows/v5-selfhost-release-gates.yml', head_sha: c2, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:01:00Z' },
      { id: 3, name: 'V5 selfhost commercial', path: '.github/workflows/v5-selfhost-commercial.yml', head_sha: c2, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:02:00Z' },
    ])
    r = tick(minEpoch + 110)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /ignored untrusted event=workflow_dispatch/)
    assert.equal(sqlVal('SELECT COUNT(*) FROM train;'), '0', 'workflow_dispatch MUST NOT unlock train dispatch')
    assert.equal(sqlVal('SELECT status FROM lease;'), 'registered')

    // Tick 4b: Pending beyond grace -> pending_timeout alert emitted, still NOT marked failed!
    r = tick(minEpoch + 3000, { OC_V5_CI_PENDING_GRACE_SEC: '2700' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /CI pending 超出宽限/)
    assert.equal(sqlVal('SELECT status FROM lease;'), 'registered', 'pending timeout must stay distinct from terminal red')
    assert.equal(sqlVal('SELECT COUNT(*) FROM train;'), '0')

    // Tick 4c: Terminal CI failure -> clear terminal red logged, NO doomed deploy spawned!
    setRuns([
      { id: 1, name: 'V5 selfhost gates', path: '.github/workflows/v5-selfhost-gates.yml', head_sha: c2, event: 'push', status: 'completed', conclusion: 'failure', created_at: '2026-11-26T10:03:00Z' },
      { id: 2, name: 'V5 selfhost release gates', path: '.github/workflows/v5-selfhost-release-gates.yml', head_sha: c2, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:01:00Z' },
      { id: 3, name: 'V5 selfhost commercial', path: '.github/workflows/v5-selfhost-commercial.yml', head_sha: c2, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:02:00Z' },
    ])
    r = tick(minEpoch + 120)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /必需 CI 终态失败/)
    assert.equal(sqlVal('SELECT COUNT(*) FROM train;'), '0', 'terminal CI failure must NOT spawn doomed deploy')

    // Tick 5 (+140s): All 3 required workflows green on trusted push/pull_request -> DISPATCHED!
    setRuns([
      { id: 10, name: 'V5 selfhost gates', path: '.github/workflows/v5-selfhost-gates.yml', head_sha: c2, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:05:00Z' },
      { id: 11, name: 'V5 selfhost release gates', path: '.github/workflows/v5-selfhost-release-gates.yml', head_sha: c2, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:05:00Z' },
      { id: 12, name: 'V5 selfhost commercial', path: '.github/workflows/v5-selfhost-commercial.yml', head_sha: c2, event: 'pull_request', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:05:00Z' },
    ])
    r = tick(minEpoch + 140)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(sqlVal('SELECT COUNT(*) FROM train;'), '1', 'green CI must dispatch 1 train')

    // Wait for fakeDeploy background process to finish commit (CI runners may take >2s under load)
    for (let i = 0; i < 200; i++) {
      if (sqlVal('SELECT status FROM train;') === 'committed') break
      spawnSync('sleep', ['0.05'])
    }
    assert.equal(sqlVal('SELECT status FROM train;'), 'committed')
    assert.equal(readFileSync(startsLog, 'utf8').trim().split('\n').length, 1)

    // Tick 6: Settle -> SAME ride transitions to satisfied with ZERO re-registration!
    r = tick(minEpoch + 170)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(sqlVal(`SELECT status FROM lease WHERE id='${rideId}';`), 'satisfied')
    assert.equal(sqlVal('SELECT COUNT(*) FROM lease;'), '1', 'zero re-registration required')

    // ── Safe FF CAS tests ──
    execFileSync('git', ['clone', '-q', '-b', 'feat/v5-selfhost', origin, pushWt], { env: sb.env })
    g(pushWt, 'config', 'user.name', 'worker-test')
    g(pushWt, 'config', 'user.email', 'worker-test@example.invalid')
    const c3 = mk(pushWt, 'c3-old-green')
    const c4 = mk(pushWt, 'c4-new-tip')
    g(pushWt, 'push', '-q', 'origin', 'feat/v5-selfhost')

    const trainId = 'tr-20261126T120000Z-abcdef123456'
    execFileSync('sqlite3', [
      db,
      `DELETE FROM train; DELETE FROM event;
       INSERT INTO train(id,resource,target_sha,status,owner,created_at,updated_at)
         VALUES('${trainId}','deploy:selfhost','${c2}','planned','worker:test','2026-11-26T12:00:00Z','2026-11-26T12:00:00Z');`,
    ])

    const runFf = (ciStatusCmd: string) =>
      runBash(
        [
          `source ${q(LEASE_LIB)}`,
          `source ${q(DEBOUNCE_LIB)}`,
          'RESOURCE=deploy:selfhost; ACTOR=worker:test',
          'wlog() { echo "$*"; }',
          extractBashFn(readFileSync(LEASE_WORKER, 'utf8'), 'canonical_fast_forward'),
          `tip=${q(c2)}`,
          'rc=0',
          `worker_planned_fast_forward_green_tip ${q(trainId)} tip || rc=$?`,
          'echo "FINAL_TIP=$tip OUTCOME=${PLANNED_FF_OUTCOME:-} RC=$rc"',
          'exit "$rc"',
        ].join('\n'),
        { ...workerEnv, OC_V5_WORKER_CI_STATUS_CMD: ciStatusCmd },
      )

    // Register a ride for c3 (NOT yet on live c2!) that must survive defer intact (never marked failed!)
    execFileSync('sqlite3', [
      db,
      `INSERT INTO lease(id,resource,mode,status,owner,owner_uid,want_sha,created_at,updated_at)
         VALUES('ls-b5-defer-keep','deploy:selfhost','ride','registered','dev',1000,'${c3}','2026-11-26T12:00:00Z','2026-11-26T12:00:00Z');`,
    ])

    // FF-1 (B5 defer): Remote tip is c4 (pending) while older c3 is green -> MUST NOT pick c3 AND MUST return defer (rc=10),
    // atomically withdrawing unspawned planned train while preserving registered ride!
    r = runFf(`if [[ "$1" == "${c3}" ]]; then echo "success"; else echo "pending"; fi`)
    assert.equal(r.status, 10, `expected rc=10 (defer) when remote tip c4 is pending, got ${r.status}: ${r.stdout} ${r.stderr}`)
    assert.match(r.stdout, /OUTCOME=defer/)
    assert.match(r.stdout, new RegExp(`FINAL_TIP=${c2}`), 'must NOT select older green c3 when remote tip is c4')
    assert.equal(sqlVal(`SELECT COUNT(*) FROM train WHERE id='${trainId}';`), '0', 'unspawned planned train MUST be atomically withdrawn on defer')
    assert.equal(sqlVal(`SELECT COUNT(*) FROM event WHERE event='train-deferred';`), '1')
    assert.equal(sqlVal(`SELECT status FROM lease WHERE id='ls-b5-defer-keep';`), 'registered', 'ride MUST stay registered across defer!')
    assert.equal(sqlVal(`SELECT COUNT(*) FROM event WHERE event='train-fast-forward';`), '0')

    // FF-2: Concurrent CAS conflict (status changed to 'building' before UPDATE) -> changes()==0 aborts, returns defer (rc=10), NO event, NO memory mutation!
    execFileSync('sqlite3', [
      db,
      `INSERT INTO train(id,resource,target_sha,status,owner,created_at,updated_at)
         VALUES('${trainId}','deploy:selfhost','${c2}','building','worker:test','2026-11-26T12:00:00Z','2026-11-26T12:00:00Z');`,
    ])
    r = runFf(`echo "success"`)
    assert.equal(r.status, 10, `CAS conflict must return defer (10), got ${r.status}`)
    assert.match(r.stdout, /快进 CAS 失败/)
    assert.match(r.stdout, new RegExp(`FINAL_TIP=${c2}`), 'CAS failure MUST NOT mutate in-memory tip')
    assert.equal(sqlVal(`SELECT target_sha FROM train WHERE id='${trainId}';`), c2)
    assert.equal(sqlVal(`SELECT COUNT(*) FROM event WHERE event='train-fast-forward';`), '0')

    // FF-3: Train back to planned & remote tip c4 is green -> FFs cleanly to c4 with changes()==1 & OUTCOME=advanced!
    execFileSync('sqlite3', [db, `UPDATE train SET status='planned' WHERE id='${trainId}';`])
    g(wt, 'reset', '--hard', '-q', c2)
    r = runFf(`[[ "$1" == "${c4}" ]] && echo "success" || echo "pending"`)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /OUTCOME=advanced/)
    assert.match(r.stdout, new RegExp(`FINAL_TIP=${c4}`), 'must FF to latest green remote tip c4')
    assert.match(r.stdout, /CAS=1/)
    assert.equal(g(wt, 'rev-parse', 'HEAD'), c4)
    assert.equal(sqlVal(`SELECT target_sha FROM train WHERE id='${trainId}';`), c4)
    assert.equal(sqlVal(`SELECT COUNT(*) FROM event WHERE event='train-fast-forward';`), '1')

    // FF-4: Full worker dispatch_train E2E: c3 green -> planned inserted -> remote advances to c4 (pending) before spawn ->
    // worker does NOT spawn doomed c3, defers & preserves ride -> c4 turns green -> next tick spawns c4!
    execFileSync('sqlite3', [db, 'DELETE FROM train; DELETE FROM event;'])
    g(pushWt, 'reset', '--hard', '-q', c3)
    g(pushWt, 'push', '--force', '-q', 'origin', 'feat/v5-selfhost')
    g(wt, 'fetch', '-q', 'origin', 'feat/v5-selfhost')
    g(wt, 'reset', '--hard', '-q', c3)
    const spawnLog = join(sb.dir, 'b5-ff4-spawn.log')
    const fakeDeployFf4 = join(sb.dir, 'fake-deploy-ff4.sh')
    writeFileSync(fakeDeployFf4, `#!/usr/bin/env bash\necho "$*" >> ${q(spawnLog)}\nexit 0\n`)
    chmodSync(fakeDeployFf4, 0o755)
    // Hook worker_planned_fast_forward_green_tip wrapper to push c4 right AFTER planned insert and BEFORE second fetch!
    const rDeferTick = runBash(
      [
        `source ${q(LEASE_WORKER)}`,
        'lease_deploy_process_running() { return 1; }',
        'orig_ff="$(declare -f worker_planned_fast_forward_green_tip)"',
        'eval "${orig_ff/worker_planned_fast_forward_green_tip/_orig_worker_planned_ff}"',
        `worker_planned_fast_forward_green_tip() { git -C ${q(pushWt)} push -q origin ${q(c4)}:refs/heads/feat/v5-selfhost; _orig_worker_planned_ff "$@"; }`,
        'dispatch_train',
      ].join('\n'),
      {
        ...workerEnv,
        OC_V5_LEASE_DEPLOY_BIN: fakeDeployFf4,
        OC_V5_TRAIN_DEBOUNCE_SEC: '0',
        OC_V5_WORKER_CI_STATUS_CMD: `if [[ "$1" == "${c3}" ]]; then echo "success"; else echo "pending"; fi`,
      },
    )
    assert.equal(rDeferTick.status, 0, rDeferTick.stderr)
    assert.match(rDeferTick.stdout, /已原子延期\(outcome=defer\)/, `expected defer log: ${rDeferTick.stdout}`)
    assert.equal(existsSync(spawnLog), false, 'worker MUST NOT spawn doomed old target c3 when c4 arrived pending!')
    assert.equal(sqlVal('SELECT COUNT(*) FROM train;'), '0', 'deferred planned train must be cleanly withdrawn')
    assert.equal(sqlVal(`SELECT status FROM lease WHERE id='ls-b5-defer-keep';`), 'registered', 'ride remains registered')

    // Now c4 turns green -> next tick dispatches c4!
    const rGreenTick = runBash(
      `source ${q(LEASE_WORKER)}; lease_deploy_process_running() { return 1; }; dispatch_train`,
      {
        ...workerEnv,
        OC_V5_LEASE_DEPLOY_BIN: fakeDeployFf4,
        OC_V5_TRAIN_DEBOUNCE_SEC: '0',
        OC_V5_WORKER_CI_STATUS_CMD: `if [[ "$1" == "${c4}" ]]; then echo "success"; else echo "pending"; fi`,
      },
    )
    assert.equal(rGreenTick.status, 0, rGreenTick.stderr)
    assert.equal(
      sqlVal('SELECT target_sha FROM train ORDER BY created_at DESC LIMIT 1;'),
      c4,
      `next green tick must dispatch c4; stdout=${rGreenTick.stdout}\nstderr=${rGreenTick.stderr}`,
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// B6: Post-Cutover Retention Gate BEFORE committed + Real State Transitions
//     (Legacy & Policy paths, mid-retention worker tick, rollback -> failed,
//      rollback fail/unhealthy -> recovery_required)
// ═════════════════════════════════════════════════════════════════════════════
describe('B6. Post-cutover retention before committed & real rollback terminal states (NO log stubs)', () => {
  test('preflight fails closed before live mutation when retention runner is missing', (t) => {
    const sb = makeSandbox(t, 'ocv5-903-b6-preflight-')
    const missing = join(sb.dir, 'does-not-exist-run-retention.sh')
    const r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `OC_V5_RETENTION_RUNNER=${q(missing)}`,
        'v5_selfhost_preflight_retention_runner',
      ].join('\n'),
      sb.env,
    )
    assert.notEqual(r.status, 0, 'missing retention runner must fail closed before live mutation')
    assert.match(r.stderr, /切流前预检失败.*禁止缺失时静默当作成功跳过/)
  })

  test('legacy & user-impact-only policy paths: blocks worker settlement during retention, commits on PASS, marks failed on verified rollback, marks recovery_required on rollback failure', async (t) => {
    // Local loopback /healthz server with controllable status code
    let healthzStatus = 200
    const server = http.createServer((_req, res) => {
      res.writeHead(healthzStatus, { 'Content-Type': 'application/json' })
      res.end(healthzStatus === 200 ? '{"ok":true}' : '{"ok":false}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const addr = server.address() as { port: number }
    const healthzUrl = `http://127.0.0.1:${addr.port}/healthz`

    const setupScenario = (name: string, policyMode: boolean) => {
      const sb = makeSandbox(t, `ocv5-903-b6-${name}-`)
      const repo = join(sb.dir, 'repo')
      const releases = join(sb.dir, 'releases')
      const runDir = join(sb.dir, 'run')
      const ctrl = join(sb.dir, 'control')
      const bin = join(sb.dir, 'bin')
      const policyDir = join(sb.dir, 'policy')
      const db = join(sb.dir, 'lease.db')
      const liveLink = join(sb.dir, 'live')
      const activeCtx = join(policyDir, 'unresolved.json')
      const survivorState = join(runDir, 'survivor.state')
      const survivorCommitted = join(runDir, 'survivor.committed')
      const breakerLog = join(sb.dir, 'breaker.log')
      const midRetentionWitness = join(sb.dir, 'mid-retention.json')
      mkdirSync(repo, { recursive: true })
      mkdirSync(releases, { recursive: true })
      mkdirSync(runDir, { recursive: true })
      mkdirSync(ctrl, { recursive: true })
      mkdirSync(bin, { recursive: true })
      mkdirSync(policyDir, { recursive: true })

      const g = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], { env: sb.env, encoding: 'utf8' }).trim()
      g('init', '-q', '-b', 'feat/v5-selfhost')
      g('config', 'user.name', 'b6-test')
      g('config', 'user.email', 'b6-test@example.invalid')
      writeFileSync(join(repo, 'v.txt'), 'v1\n')
      g('add', '.')
      g('commit', '-qm', 'chore(v5): prev')
      const prevSha = g('rev-parse', 'HEAD')
      writeFileSync(join(repo, 'v.txt'), 'v2\n')
      g('commit', '-qam', 'bug(v5): cand')
      const candSha = g('rev-parse', 'HEAD')

      const prevRel = join(releases, 'rel-prev')
      const candRel = join(releases, 'rel-cand')
      mkdirSync(prevRel, { recursive: true })
      mkdirSync(candRel, { recursive: true })
      const prevComplete = `${JSON.stringify({ sourceCommit: prevSha })}\n`
      const candComplete = `${JSON.stringify({ sourceCommit: candSha })}\n`
      writeFileSync(join(prevRel, '.complete'), prevComplete)
      writeFileSync(join(candRel, '.complete'), candComplete)
      writeFileSync(join(releases, '.prev-release'), `${prevRel}\n`)
      // Live currently points to newly flipped candidate (post-smoke, pre-committed!)
      symlinkSync(candRel, liveLink)
      writeFileSync(survivorState, 'phase=smoked\nexecutor_pid=999999999\nbackup_dir=/tmp/b\narmed_at=x\n')

      const govBin = join(bin, 'oc-governor')
      writeFileSync(govBin, `#!/usr/bin/env bash\necho "$*" >> ${q(breakerLog)}\nexit 0\n`)
      chmodSync(govBin, 0o755)

      const env: NodeJS.ProcessEnv = {
        ...sb.env,
        OC_V5_LEASE_DB: db,
        OC_V5_LEASE_LOCK: join(runDir, 'lease-db.lock'),
        OC_V5_LEASE_WORKER_LOCK: join(runDir, 'worker.lock'),
        OC_V5_SELFHOST_DEPLOY_LOCK: join(runDir, 'deploy.lock'),
        OC_V5_LEASE_REPO_ROOT: repo,
        OC_V5_LEASE_LIVE_LINK: liveLink,
        OC_V5_LEASE_SURVIVOR_STATE: survivorState,
        OC_V5_LEASE_SURVIVOR_COMMITTED: survivorCommitted,
        OC_V5_LEASE_CUTOVER_GRACE_FILE: join(runDir, 'grace'),
        OC_V5_RELEASE_POLICY_CONTEXT: activeCtx,
        OC_V5_GOVERNOR_CONTROL_DIR: ctrl,
        OC_V5_GOVERNOR_BIN: govBin,
        OC_V5_RETENTION_SETTLE_SEC: '0',
        OC_V5_RETENTION_HEALTHZ_URL: healthzUrl,
        MASTER_LIVE_LINK: liveLink,
        MASTER_RELEASES_ROOT: releases,
        SURVIVOR_STATE: survivorState,
        SURVIVOR_COMMITTED: survivorCommitted,
      }

      // Initialize real SQLite schema via real v5-lease-lib.sh
      const initR = runBash(`source ${q(LEASE_LIB)}; lease_init_db`, env)
      assert.equal(initR.status, 0, initR.stderr)

      const trainId = 'tr-20261126T150000Z-111122223333'
      const rideId = 'ls-20261126T150000Z-444455556666'
      const nonce = 'b6-nonce-903'
      const stamp = '2026-11-26T15:00:00Z'

      let targetStackDigest = ''
      if (policyMode) {
        // Seed real unresolved.json via real scripts/lib/v5-release-policy.py!
        const req = {
          edition: 'selfhost',
          operationId: trainId,
          candidateSha: candSha,
          owner: { deploymentId: trainId, nonce },
          before: {
            masterRelease: prevRel,
            currentTarget: 'bundles/prev',
            tuple: { OC_RUNTIME_IMAGE: 'img', OC_RUNTIME_IMAGE_ID: `sha256:${'a'.repeat(64)}`, OC_RUNTIME_RELEASE: '/r/prev', OC_PLATFORM_BUNDLE: '/b/prev' },
            sourceCommit: prevSha,
            sourceDigest: createHash('sha256').update(prevComplete).digest('hex'),
            port: addr.port,
          },
          target: {
            masterRelease: candRel,
            currentTarget: 'bundles/cand',
            tuple: { OC_RUNTIME_IMAGE: 'img', OC_RUNTIME_IMAGE_ID: `sha256:${'a'.repeat(64)}`, OC_RUNTIME_RELEASE: '/r/cand', OC_PLATFORM_BUNDLE: '/b/cand' },
            sourceCommit: candSha,
            sourceDigest: createHash('sha256').update(candComplete).digest('hex'),
            port: addr.port,
          },
          history: { path: join(sb.dir, 'history.jsonl'), predecessorSha256: createHash('sha256').update('').digest('hex'), transitionKind: 'joint' },
        }
        const pyRes = spawnSync(
          'python3',
          [
            '-c',
            `
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location('rp', sys.argv[1])
rp = importlib.util.module_from_spec(spec); spec.loader.exec_module(rp)
active = pathlib.Path(sys.argv[2])
req = json.loads(sys.argv[3])
rp.prepare(active, req)
d = rp.stack_digest(req['target'])
rp.checkpoint(active, req['operationId'], {'phase': 'exposure-armed', 'mayHaveServed': True, 'observations': {
  'identity': 'exact', 'service': 'usable', 'authority': 'unobserved', 'allRequiredPassed': True,
  'lineageCoherent': True, 'verifiedDirection': 'target', 'verifiedStackSha256': d,
}})
print(d)
`,
            RELEASE_POLICY_PY,
            activeCtx,
            JSON.stringify(req),
          ],
          { env, encoding: 'utf8' },
        )
        assert.equal(pyRes.status, 0, pyRes.stderr)
        targetStackDigest = pyRes.stdout.trim()
      }

      const evDoc = policyMode
        ? {
            releasePolicy: { schema: 1, mode: 'user-impact-only', sourceSha: candSha, leaseIds: [rideId] },
            releasePolicyOwner: { nonce, pid: 1, startTicks: '1' },
            releasePolicyAcceptance: {
              schema: 1,
              operationId: trainId,
              candidateSha: candSha,
              nonce,
              targetStackSha256: targetStackDigest,
              resolution: 'forward',
            },
          }
        : { mode: 'legacy' }

      const rideDoc = policyMode
        ? {
            request: { releasePolicy: { schema: 1, mode: 'user-impact-only', sourceSha: candSha } },
            releasePolicyBinding: { schema: 1, trainId, sourceSha: candSha },
          }
        : {}

      execFileSync('sqlite3', [
        db,
        `INSERT INTO train(id,resource,target_sha,status,owner,executor_pid,rel_path,evidence_json,created_at,updated_at)
           VALUES('${trainId}','deploy:selfhost','${candSha}','building','worker:test',1,'${candRel}','${JSON.stringify(evDoc)}','${stamp}','${stamp}');
         INSERT INTO lease(id,resource,mode,status,owner,owner_uid,want_sha,result_json,created_at,updated_at)
           VALUES('${rideId}','deploy:selfhost','ride','registered','agent-b6','3','${candSha}','${JSON.stringify(rideDoc)}','${stamp}','${stamp}');`,
      ])

      const sql = (qStr: string) => execFileSync('sqlite3', ['-noheader', db, qStr], { encoding: 'utf8' }).trim()

      // Build a retention runner that ALSO runs a REAL `v5-lease-worker.sh` `settle_rides` tick MID-RETENTION!
      const makeRunner = (exitCode: number) => {
        const runner = join(bin, `run-retention-${exitCode}.sh`)
        writeFileSync(
          runner,
          [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            // Execute REAL worker settle_rides tick right in the middle of retention!
            `bash -euo pipefail -c 'source ${q(LEASE_WORKER)}; settle_rides' >/dev/null 2>&1 || true`,
            `phase="$(sed -n 's/^phase=//p' ${q(survivorState)} | head -1)"`,
            `train_st="$(sqlite3 -noheader ${q(db)} "SELECT status FROM train WHERE id='${trainId}';")"`,
            `ride_st="$(sqlite3 -noheader ${q(db)} "SELECT status FROM lease WHERE id='${rideId}';")"`,
            `active_exists=0; [[ -e ${q(activeCtx)} ]] && active_exists=1`,
            `jq -cn --arg p "$phase" --arg t "$train_st" --arg r "$ride_st" --argjson a "$active_exists" '{phase:$p,trainStatus:$t,rideStatus:$r,activeContextPresent:($a==1)}' > ${q(midRetentionWitness)}`,
            `exit ${exitCode}`,
          ].join('\n'),
        )
        chmodSync(runner, 0o755)
        return runner
      }

      return {
        sb,
        repo,
        releases,
        prevRel,
        candRel,
        prevSha,
        candSha,
        liveLink,
        activeCtx,
        survivorState,
        survivorCommitted,
        breakerLog,
        midRetentionWitness,
        db,
        trainId,
        rideId,
        nonce,
        env,
        sql,
        makeRunner,
      }
    }

    const runCutoverRetentionAndFinalize = async (
      sc: ReturnType<typeof setupScenario>,
      opts: { policyMode: boolean; runner: string; rollbackCmd: string },
    ) => {
      // Run REAL retention gate + REAL finalize/state transitions using REAL v5-lease-lib.sh + REAL v5-selfhost-release-policy.sh!
      return runBashAsync(
        [
          `SCRIPT_DIR=${q(join(REPO_ROOT, 'scripts'))}`,
          `REPO_ROOT=${q(sc.repo)}`,
          `source ${q(LEASE_LIB)}`,
          `source ${q(RELEASE_POLICY_LIB)}`,
          `source ${q(TRAIN_GUARDS_LIB)}`,
          'log() { echo "$*"; }',
          'cutover_clog() { echo "$*"; }',
          'die() { echo "✗ $*" >&2; exit 1; }',
          'tsum_note() { :; }',
          'deploy_alert() { :; }',
          'cutover_persist_phase() { printf "phase=%s\\nexecutor_pid=%s\\n" "$1" "$$" >"$SURVIVOR_STATE"; }',
          'cutover_disarm_survivor() { printf "phase=committed\\nexecutor_pid=%s\\n" "$$" >"$SURVIVOR_STATE"; printf "committed_at=now\\n" >"$SURVIVOR_COMMITTED"; }',
          // Bind real owner PID in SQLite so real release_policy_require_owner / lease_train_finish guards succeed
          `sqlite3 ${q(sc.db)} "UPDATE train SET executor_pid=$$ WHERE id='${sc.trainId}';"`,
          opts.policyMode
            ? `RELEASE_POLICY_MODE=user-impact-only; RELEASE_POLICY_OPERATION=${q(sc.trainId)}; RELEASE_POLICY_NONCE=${q(sc.nonce)}; RELEASE_POLICY_CLAIMED=1; release_policy_require_owner() { return 0; }`
            : 'RELEASE_POLICY_MODE=""',
          `LEASE_TRAIN_ID=${q(sc.trainId)}`,
          `LEASE_TARGET_SHA=${q(sc.candSha)}`,
          'LEASE_TRAIN_ACTIVE=1',
          'CUTOVER_MUTATED=1',
          `CUTOVER_PREV_LIVE=${q(sc.prevRel)}`,
          `CUTOVER_REL=${q(sc.candRel)}`,
          `OC_V5_RETENTION_RUNNER=${q(opts.runner)}`,
          `OC_V5_RETENTION_ROLLBACK_CMD=${q(opts.rollbackCmd)}`,
          // Exact post-smoke -> retention -> finalize order matching cmd_cutover!
          `v5_selfhost_post_cutover_retention_gate ${q(sc.candRel)} ${q(sc.candSha)} || exit $?`,
          // Only reached if retention PASSED (exit 0)!
          'cutover_persist_phase committed',
          'cutover_disarm_survivor',
          `lease_train_finish committed "cutover committed live=${sc.candRel}"`,
          opts.policyMode ? 'release_policy_py resolve forward' : ':',
        ].join('\n'),
        sc.env,
      )
    }

    // ── Case 1 & 2: Retention PASS in BOTH legacy and user-impact-only policy paths ──
    for (const policyMode of [false, true]) {
      healthzStatus = 200
      const sc = setupScenario(policyMode ? 'policy-pass' : 'legacy-pass', policyMode)
      const runner = sc.makeRunner(0)
      const r = await runCutoverRetentionAndFinalize(sc, {
        policyMode,
        runner,
        rollbackCmd: 'exit 99',
      })
      assert.equal(r.status, 0, `${policyMode ? 'policy' : 'legacy'} PASS failed: ${r.stderr}\n${r.stdout}`)

      // Verify mid-retention snapshot: worker tick ran DURING retention and DID NOT settle ride!
      const mid = JSON.parse(readFileSync(sc.midRetentionWitness, 'utf8'))
      assert.equal(mid.phase, 'verifying', 'phase MUST be verifying during retention')
      assert.equal(mid.trainStatus, 'cutover', 'train MUST NOT be committed during retention')
      assert.equal(mid.rideStatus, 'registered', 'worker tick during retention MUST NOT settle ride to satisfied!')
      if (policyMode) {
        assert.equal(mid.activeContextPresent, true, 'policy unresolved.json MUST remain present during retention')
      }

      // After retention PASS + finalize: train is committed, policy resolved forward, next worker tick settles ride!
      assert.equal(sc.sql(`SELECT status FROM train WHERE id='${sc.trainId}';`), 'committed')
      if (policyMode) {
        assert.equal(existsSync(sc.activeCtx), false, 'unresolved.json must be resolved after retention PASS')
      }
      const settleR = runBash(`source ${q(LEASE_WORKER)}; settle_rides`, sc.env)
      assert.equal(settleR.status, 0, settleR.stderr)
      assert.equal(sc.sql(`SELECT status FROM lease WHERE id='${sc.rideId}';`), 'satisfied')
    }

    // ── Case 3: Retention FAIL + Rollback SUCCEEDS & old live verified healthy (BOTH legacy & policy) ──
    for (const policyMode of [false, true]) {
      healthzStatus = 200
      const sc = setupScenario(policyMode ? 'policy-rb-ok' : 'legacy-rb-ok', policyMode)
      const runner = sc.makeRunner(1)
      // Rollback command flips live back to prevRel
      const r = await runCutoverRetentionAndFinalize(sc, {
        policyMode,
        runner,
        rollbackCmd: `ln -sfn ${q(sc.prevRel)} ${q(sc.liveLink)}`,
      })
      assert.notEqual(r.status, 0, 'retention failure must exit non-zero')
      assert.equal(realpathSync(sc.liveLink), realpathSync(sc.prevRel), 'live must be rolled back to prevRel')
      assert.equal(
        sc.sql(`SELECT status FROM train WHERE id='${sc.trainId}';`),
        'failed',
        `original train MUST end in failed (NEVER committed!) for ${policyMode ? 'policy' : 'legacy'}`,
      )
      assert.equal(sc.sql(`SELECT status FROM lease WHERE id='${sc.rideId}';`), 'registered')
      assert.match(readFileSync(sc.breakerLog, 'utf8'), new RegExp(`trip-breaker --train ${sc.trainId}`))
    }

    // ── Case 4a: Retention FAIL + Rollback FAILS (rc!=0) -> recovery_required & forward dispatch paused! ──
    for (const policyMode of [false, true]) {
      healthzStatus = 200
      const sc = setupScenario(policyMode ? 'policy-rb-fail' : 'legacy-rb-fail', policyMode)
      const runner = sc.makeRunner(1)
      const r = await runCutoverRetentionAndFinalize(sc, {
        policyMode,
        runner,
        rollbackCmd: 'echo "ROLLBACK-CRASHED" >&2; exit 2',
      })
      assert.equal(r.status, 79, 'rollback failure must exit 79 (recovery_required)')
      assert.equal(
        sc.sql(`SELECT status FROM train WHERE id='${sc.trainId}';`),
        'recovery_required',
        `failed rollback MUST transition original train to recovery_required (${policyMode ? 'policy' : 'legacy'})`,
      )
      assert.match(readFileSync(sc.survivorState, 'utf8'), /^phase=compensate-failed/m)
      assert.equal(existsSync(join(sc.releases, '.manual-recovery-required')), true)
      assert.equal(sc.sql("SELECT COUNT(*) FROM outbox WHERE kind='train_alert';"), '1')
      // Verify worker settle_rides CANNOT settle ride AND dispatch_train is blocked by recovery_required!
      const workerCheck = runBash(
        `source ${q(LEASE_WORKER)}; lease_deploy_process_running() { return 1; }; settle_rides; dispatch_train`,
        { ...sc.env, OC_V5_AUTORECOVER: 'off', OC_V5_TRAIN_DEBOUNCE_SEC: '0' },
      )
      assert.equal(workerCheck.status, 0, workerCheck.stderr)
      assert.equal(sc.sql(`SELECT status FROM lease WHERE id='${sc.rideId}';`), 'registered')
      assert.equal(sc.sql('SELECT COUNT(*) FROM train;'), '1', 'recovery_required MUST block new forward trains')
    }

    // ── Case 4b: Rollback exits 0 BUT old live /healthz is 500 (unhealthy) -> recovery_required! ──
    {
      healthzStatus = 200
      const sc = setupScenario('rb-unhealthy', false)
      // Runner flips healthz to fail right after retention fails by using a custom verify cmd returning 1
      const runner = sc.makeRunner(1)
      const r = await runBashAsync(
        [
          `SCRIPT_DIR=${q(join(REPO_ROOT, 'scripts'))}`,
          `REPO_ROOT=${q(sc.repo)}`,
          `source ${q(LEASE_LIB)}`,
          `source ${q(RELEASE_POLICY_LIB)}`,
          `source ${q(TRAIN_GUARDS_LIB)}`,
          'log() { echo "$*"; }; cutover_clog() { echo "$*"; }; die() { echo "✗ $*" >&2; exit 1; }',
          'tsum_note() { :; }; deploy_alert() { :; }',
          'cutover_persist_phase() { printf "phase=%s\\n" "$1" >"$SURVIVOR_STATE"; }',
          'cutover_disarm_survivor() { printf "phase=committed\\n" >"$SURVIVOR_STATE"; }',
          `LEASE_TRAIN_ID=${q(sc.trainId)}; LEASE_TARGET_SHA=${q(sc.candSha)}; LEASE_TRAIN_ACTIVE=1; CUTOVER_MUTATED=1`,
          `CUTOVER_PREV_LIVE=${q(sc.prevRel)}; CUTOVER_REL=${q(sc.candRel)}`,
          `OC_V5_RETENTION_RUNNER=${q(runner)}`,
          `OC_V5_RETENTION_ROLLBACK_CMD=${q(`ln -sfn ${q(sc.prevRel)} ${q(sc.liveLink)}`)}`,
          'OC_V5_RETENTION_ROLLBACK_VERIFY_CMD="exit 1"',
          `v5_selfhost_post_cutover_retention_gate ${q(sc.candRel)} ${q(sc.candSha)}`,
        ].join('\n'),
        sc.env,
      )
      assert.equal(r.status, 79)
      assert.equal(sc.sql(`SELECT status FROM train WHERE id='${sc.trainId}';`), 'recovery_required')
    }
  })

  test('B6 real lease_train_begin admission (NO rollback stub) & policy recovery retention PASS proof', async (t) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const addr = server.address() as { port: number }
    const healthzUrl = `http://127.0.0.1:${addr.port}/healthz`

    const sb = makeSandbox(t, 'ocv5-903-b6-real-admit-')
    const db = join(sb.dir, 'lease.db')
    const releases = join(sb.dir, 'releases')
    const prevRel = join(releases, 'rel-prev')
    const candRel = join(releases, 'rel-cand')
    const liveLink = join(sb.dir, 'live')
    const survState = join(sb.dir, 'survivor.state')
    const failRunner = join(sb.dir, 'fail-retention.sh')
    const prevSha = '1'.repeat(40)
    const candSha = '2'.repeat(40)
    const trainId = 'tr-20261126T180000Z-abcdef000001'
    const nonce = 'nonce-real-comp-001'
    mkdirSync(prevRel, { recursive: true })
    mkdirSync(candRel, { recursive: true })
    symlinkSync(candRel, liveLink)
    writeFileSync(failRunner, '#!/usr/bin/env bash\nexit 1\n')
    chmodSync(failRunner, 0o755)

    const b6GovRoot = join(sb.dir, 'b6-governor')
    const b6GovCtrl = join(b6GovRoot, 'control')
    const b6GovBin = join(sb.dir, 'b6-fake-oc-governor')
    mkdirSync(b6GovCtrl, { recursive: true })
    writeFileSync(b6GovBin, '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(b6GovBin, 0o755)

    const env = {
      ...sb.env,
      LEASE_DB: db,
      OC_V5_LEASE_DB: db,
      LEASE_LIB,
      MASTER_RELEASES_ROOT: releases,
      MASTER_LIVE_LINK: liveLink,
      SURVIVOR_STATE: survState,
      OC_GOVERNOR_ROOT: b6GovRoot,
      OC_V5_GOVERNOR_CONTROL_DIR: b6GovCtrl,
      OC_V5_GOVERNOR_BIN: b6GovBin,
      OC_V5_RETENTION_SETTLE_SEC: '0',
      OC_V5_RETENTION_HEALTHZ_URL: healthzUrl,
      OC_V5_RETENTION_HEALTHZ_ATTEMPTS: '2',
      OC_V5_RETENTION_HEALTHZ_INTERVAL_SEC: '1',
    }
    const fnBegin = extractBashFn(readFileSync(DEPLOY_SCRIPT, 'utf8'), 'lease_train_begin')
    const fnLoad = extractBashFn(readFileSync(DEPLOY_SCRIPT, 'utf8'), 'lease_train_load_lib')

    // Seed real SQLite open cutover train with releasePolicyOwner.nonce
    const initR = runBash(
      [
        `source ${q(LEASE_LIB)}`,
        'lease_init_db',
        `sqlite3 ${q(db)} "INSERT INTO train(id,resource,target_sha,status,owner,executor_pid,evidence_json,created_at,updated_at) VALUES('${trainId}','deploy:selfhost','${candSha}','cutover','worker:test',$$,'{\\"releasePolicyOwner\\":{\\"nonce\\":\\"${nonce}\\"}}','2026-11-26T18:00:00Z','2026-11-26T18:00:00Z');"`,
      ].join('\n'),
      env,
    )
    assert.equal(initR.status, 0, initR.stderr)

    // 1. Unrelated concurrent manual deploy/rollback while cutover train is open -> MUST BE REJECTED by real lease_train_begin!
    const rManual = runBash(
      [
        'DRY=0; LEASE_TRAIN_ID=""; LEASE_TARGET_SHA=""; CUTOVER_ROLLBACK=1',
        'log() { echo "$*"; }; die() { echo "✗ $*" >&2; exit 1; }',
        `source ${q(TRAIN_GUARDS_LIB)}`,
        fnLoad,
        fnBegin,
        `lease_train_begin ${q(prevSha)}`,
      ].join('\n'),
      env,
    )
    assert.notEqual(rManual.status, 0, 'unrelated manual rollback MUST still be rejected when open cutover train exists')
    assert.match(rManual.stderr, /Lease Center 有 open train .*拒绝并行人工发布/)

    // 2. Forged compensation with WRONG nonce -> MUST BE REJECTED!
    const rWrongNonce = runBash(
      [
        `sqlite3 ${q(db)} "UPDATE train SET executor_pid=$$ WHERE id='${trainId}';"`,
        'DRY=0; LEASE_TRAIN_ID=""; LEASE_TARGET_SHA=""; CUTOVER_ROLLBACK=1',
        'log() { echo "$*"; }; die() { echo "✗ $*" >&2; exit 1; }',
        `source ${q(TRAIN_GUARDS_LIB)}`,
        fnLoad,
        fnBegin,
        `OC_V5_RETENTION_INTERNAL_ROLLBACK=1 OC_V5_SELFHOST_DEPLOY_LOCK_HELD=1 OC_V5_COMPENSATE_TRAIN_ID=${q(trainId)} OC_V5_COMPENSATE_TARGET_SHA=${q(candSha)} OC_V5_COMPENSATE_PARENT_PID=$$ OC_V5_COMPENSATE_POLICY_NONCE=wrong-nonce lease_train_begin ${q(prevSha)}`,
      ].join('\n'),
      env,
    )
    assert.notEqual(rWrongNonce.status, 0, 'forged compensation with wrong nonce MUST be rejected')
    assert.match(rWrongNonce.stderr, /nonce 不匹配/)

    // 3. REAL same-operation compensation inside v5_selfhost_post_cutover_retention_gate calling REAL lease_train_begin!
    const realCompRollback = join(sb.dir, 'real-comp-rollback.sh')
    writeFileSync(
      realCompRollback,
      [
        '#!/usr/bin/env bash',
        'set -Eeuo pipefail',
        'DRY=0; LEASE_TRAIN_ID=""; LEASE_TARGET_SHA=""; CUTOVER_ROLLBACK=1',
        'log() { echo "$*"; }; die() { echo "✗ $*" >&2; exit 1; }',
        `source ${q(TRAIN_GUARDS_LIB)}`,
        fnLoad,
        fnBegin,
        `lease_train_begin ${q(prevSha)}`,
        `ln -sfn ${q(prevRel)} ${q(liveLink)}`,
        `v5_selfhost_lease_record_compensation_ok ${q(prevRel)} ${q(candRel)}`,
      ].join('\n'),
    )
    chmodSync(realCompRollback, 0o755)

    const rRealComp = await runBashAsync(
      [
        `SCRIPT_DIR=${q(join(REPO_ROOT, 'scripts'))}`,
        `source ${q(LEASE_LIB)}`,
        `source ${q(RELEASE_POLICY_LIB)}`,
        `source ${q(TRAIN_GUARDS_LIB)}`,
        'log() { echo "$*"; }; cutover_clog() { echo "$*"; }; die() { echo "✗ $*" >&2; exit 1; }',
        'tsum_note() { :; }; deploy_alert() { :; }',
        'cutover_persist_phase() { printf "phase=%s\\nexecutor_pid=%s\\n" "$1" "$$" >"$SURVIVOR_STATE"; }',
        'cutover_disarm_survivor() { :; }',
        `sqlite3 ${q(db)} "UPDATE train SET executor_pid=$$ WHERE id='${trainId}';"`,
        'RELEASE_POLICY_MODE=""',
        `LEASE_TRAIN_ID=${q(trainId)}; LEASE_TARGET_SHA=${q(candSha)}; RELEASE_POLICY_NONCE=${q(nonce)}; LEASE_TRAIN_ACTIVE=1; CUTOVER_MUTATED=1`,
        `CUTOVER_PREV_LIVE=${q(prevRel)}; CUTOVER_REL=${q(candRel)}; OC_V5_SELFHOST_DEPLOY_LOCK_HELD=1`,
        `OC_V5_RETENTION_RUNNER=${q(failRunner)}`,
        `OC_V5_RETENTION_ROLLBACK_CMD=${q(realCompRollback)}`,
        `v5_selfhost_post_cutover_retention_gate ${q(candRel)} ${q(candSha)}`,
      ].join('\n'),
      env,
    )
    assert.equal(rRealComp.status, 1, `same-operation compensation should succeed rollback & exit 1 (failed, NOT 79 recovery_required!): stdout=${rRealComp.stdout}\nstderr=${rRealComp.stderr}`)
    const sqlVal = (qStr: string) => execFileSync('sqlite3', [db, qStr], { encoding: 'utf8' }).trim()
    assert.equal(
      sqlVal(`SELECT status FROM train WHERE id='${trainId}';`),
      'failed',
      `original train MUST end as failed (NOT committed, NOT recovery_required!): stdout=${rRealComp.stdout}\nstderr=${rRealComp.stderr}`,
    )
    assert.equal(sqlVal(`SELECT COUNT(*) FROM event WHERE subject_id='${trainId}' AND event='train-compensate-rollback-begin';`), '1')
    assert.equal(sqlVal(`SELECT COUNT(*) FROM event WHERE subject_id='${trainId}' AND event='train-compensate-rollback-ok';`), '1')
    assert.equal(realpathSync(liveLink), realpathSync(prevRel))

    // 4. B6 policy recovery retention PASS proof check: false before retention PASS, true only after lease_train_mark_retention_passed!
    const proofTrain = 'tr-20261126T180500Z-abcdef000002'
    const rProof = runBash(
      [
        `SCRIPT_DIR=${q(join(REPO_ROOT, 'scripts'))}`,
        `source ${q(LEASE_LIB)}`,
        `source ${q(RELEASE_POLICY_LIB)}`,
        'RELEASE_POLICY_MODE=""',
        `sqlite3 ${q(db)} "INSERT INTO train(id,resource,target_sha,status,owner,created_at,updated_at) VALUES('${proofTrain}','deploy:selfhost','${candSha}','cutover','worker:test','2026-11-26T18:05:00Z','2026-11-26T18:05:00Z');"`,
        `LEASE_TRAIN_ID=${q(proofTrain)}; LEASE_TARGET_SHA=${q(candSha)}; LEASE_TRAIN_ACTIVE=1`,
        `if lease_train_has_retention_pass ${q(candRel)} ${q(candSha)}; then echo "BEFORE=PASS"; else echo "BEFORE=MISSING"; fi`,
        `lease_train_mark_retention_passed ${q(candRel)} ${q(candSha)}`,
        `if lease_train_has_retention_pass ${q(candRel)} ${q(candSha)}; then echo "AFTER=PASS"; else echo "AFTER=MISSING"; fi`,
        `if lease_train_has_retention_pass ${q(prevRel)} ${q(candSha)}; then echo "WRONG_REL=PASS"; else echo "WRONG_REL=REJECTED"; fi`,
      ].join('\n'),
      env,
    )
    assert.equal(rProof.status, 0, rProof.stderr)
    assert.match(rProof.stdout, /BEFORE=MISSING/)
    assert.match(rProof.stdout, /AFTER=PASS/)
    assert.match(rProof.stdout, /WRONG_REL=REJECTED/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// B7 (+ Non-blocker 2): Shared Forward Cutover Guard Boundary, Physical
// oc-governor check-blast-radius, Trusted 3-Workflow CI Green & Trailer Escape
// ═════════════════════════════════════════════════════════════════════════════
describe('B7. Shared forward cutover guard boundary, physical blast-radius & trusted CI events', () => {
  test('enforces governor mode, real oc-governor check-blast-radius (commercial branch, DDL, billing + voucher), trusted 3-workflow CI, and rollback exemption', (t) => {
    const f = makeTempGitRepo(t)
    const govRoot = join(f.dir, 'governor')
    const ctrl = join(govRoot, 'control')
    const bin = join(f.dir, 'bin')
    const modeFile = join(ctrl, 'mode.json')
    const ghResp = join(f.dir, 'gh.json')
    const ghStub = join(bin, 'gh')
    const retentionStub = join(bin, 'run-retention.sh')
    mkdirSync(ctrl, { recursive: true })
    mkdirSync(bin, { recursive: true })

    writeFileSync(ghStub, `#!/usr/bin/env bash\ncat ${q(ghResp)}\n`)
    chmodSync(ghStub, 0o755)
    writeFileSync(retentionStub, '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(retentionStub, 0o755)

    // Base commit
    writeFileSync(join(f.repo, 'README.md'), 'base\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): base')
    const baseSha = f.git('rev-parse', 'HEAD')

    // Clean bugfix commit
    writeFileSync(join(f.repo, 'README.md'), 'clean bugfix\n')
    f.git('commit', '-qam', 'bug(v5): clean fix')
    const cleanSha = f.git('rev-parse', 'HEAD')

    // Feature commit (blocked in debt_first)
    writeFileSync(join(f.repo, 'README.md'), 'new feat\n')
    f.git('commit', '-qam', 'feat(v5): shiny new feature')
    const featSha = f.git('rev-parse', 'HEAD')

    // Billing core commit (blocked by oc-governor check-blast-radius without voucher!)
    f.git('checkout', '-q', cleanSha)
    mkdirSync(join(f.repo, 'packages/commercial/src/billing'), { recursive: true })
    writeFileSync(join(f.repo, 'packages/commercial/src/billing/ledger.ts'), 'export const x = 1\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'bug(v5): touch billing ledger')
    const billingSha = f.git('rev-parse', 'HEAD')

    // Destructive DDL migration commit (blocked by oc-governor check-blast-radius without voucher!)
    f.git('checkout', '-q', cleanSha)
    mkdirSync(join(f.repo, 'packages/commercial/src/db/migrations'), { recursive: true })
    writeFileSync(
      join(f.repo, 'packages/commercial/src/db/migrations/9999_drop.sql'),
      'DROP TABLE old_sessions;\n',
    )
    f.git('add', '.')
    f.git('commit', '-qm', 'bug(v5): destructive drop migration')
    const ddlSha = f.git('rev-parse', 'HEAD')

    const setAllGreen = (sha: string, event = 'push') => {
      writeFileSync(
        ghResp,
        JSON.stringify({
          workflow_runs: [
            { id: 1, name: 'V5 selfhost gates', path: '.github/workflows/v5-selfhost-gates.yml', head_sha: sha, event, status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
            { id: 2, name: 'V5 selfhost release gates', path: '.github/workflows/v5-selfhost-release-gates.yml', head_sha: sha, event, status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
            { id: 3, name: 'V5 selfhost commercial', path: '.github/workflows/v5-selfhost-commercial.yml', head_sha: sha, event, status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
          ],
        }),
      )
    }

    const runGuards = (sha: string, extra = '', branch = 'feat/v5-selfhost') =>
      runBash(
        [
          `source ${q(TRAIN_GUARDS_LIB)}`,
          `REPO_ROOT=${q(f.repo)}`,
          `OC_GOVERNOR_ROOT=${q(govRoot)}`,
          `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
          `OC_V5_GOVERNOR_MODE_FILE=${q(modeFile)}`,
          `OC_V5_GOVERNOR_BIN=${q(OC_GOVERNOR)}`,
          `OC_V5_GH_BIN=${q(ghStub)}`,
          'OC_V5_GH_REPO=dream-star-end/openclaude',
          `OC_V5_RETENTION_RUNNER=${q(retentionStub)}`,
          extra,
          `v5_selfhost_enforce_forward_cutover_guards ${q(sha)} ${q(baseSha)} ${q(branch)}`,
        ].join('\n'),
        f.env,
      )

    // 1. Clean commit + autonomous + 3 trusted CI green -> PASS
    writeFileSync(modeFile, JSON.stringify({ mode: 'autonomous', reason: 'ok' }))
    setAllGreen(cleanSha, 'push')
    let r = runGuards(cleanSha)
    assert.equal(r.status, 0, r.stderr + r.stdout)

    // 2. workflow_dispatch green ONLY -> REJECTED!
    setAllGreen(cleanSha, 'workflow_dispatch')
    r = runGuards(cleanSha)
    assert.notEqual(r.status, 0, 'workflow_dispatch MUST be rejected')
    assert.match(r.stderr, /rejected untrusted event\(s\)=workflow_dispatch/)

    // 3. Missing 3rd default workflow (V5 selfhost commercial) -> REJECTED!
    writeFileSync(
      ghResp,
      JSON.stringify({
        workflow_runs: [
          { id: 1, name: 'V5 selfhost gates', path: '.github/workflows/v5-selfhost-gates.yml', head_sha: cleanSha, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
          { id: 2, name: 'V5 selfhost release gates', path: '.github/workflows/v5-selfhost-release-gates.yml', head_sha: cleanSha, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
        ],
      }),
    )
    r = runGuards(cleanSha)
    assert.notEqual(r.status, 0, 'missing V5 selfhost commercial workflow must fail closed')
    assert.match(r.stderr, /V5 selfhost commercial: missing/)

    // 4. Spoofed workflow display name with wrong path -> REJECTED!
    writeFileSync(
      ghResp,
      JSON.stringify({
        workflow_runs: [
          { id: 1, name: 'V5 selfhost gates', path: '.github/workflows/spoofed.yml', head_sha: cleanSha, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
          { id: 2, name: 'V5 selfhost release gates', path: '.github/workflows/v5-selfhost-release-gates.yml', head_sha: cleanSha, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
          { id: 3, name: 'V5 selfhost commercial', path: '.github/workflows/v5-selfhost-commercial.yml', head_sha: cleanSha, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
        ],
      }),
    )
    r = runGuards(cleanSha)
    assert.notEqual(r.status, 0, 'spoofed workflow name with wrong path must fail closed')

    // 5. emergency_stop blocks even clean commit
    setAllGreen(cleanSha, 'push')
    writeFileSync(modeFile, JSON.stringify({ mode: 'emergency_stop', reason: 'sev1 freeze' }))
    r = runGuards(cleanSha)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /emergency_stop/)

    // 6. debt_first blocks feat(...) and allows bug(...)
    writeFileSync(modeFile, JSON.stringify({ mode: 'debt_first', reason: 'rework high' }))
    setAllGreen(featSha, 'push')
    r = runGuards(featSha)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /debt_first/)
    setAllGreen(cleanSha, 'push')
    r = runGuards(cleanSha)
    assert.equal(r.status, 0, r.stderr)

    // 7. Physical oc-governor check-blast-radius:
    writeFileSync(modeFile, JSON.stringify({ mode: 'autonomous', reason: 'ok' }))
    // 7a: Commercial branch hard-lock
    r = runGuards(cleanSha, '', 'feat/v5-aurora-rewrite')
    assert.notEqual(r.status, 0, 'commercial branch MUST be hard-locked by oc-governor')
    assert.match(r.stderr, /COMMERCIAL_BRANCH_HARD_LOCK/)

    // 7b: Unvouchered billing core change blocked!
    setAllGreen(billingSha, 'push')
    r = runGuards(billingSha)
    assert.notEqual(r.status, 0, 'unvouchered billing core edit MUST be blocked')
    assert.match(r.stderr, /BILLING_CORE_LOCKED/)

    // 7c: Issue valid root voucher -> billing core change allowed!
    const vRes = spawnSync(
      'bash',
      [
        OC_GOVERNOR,
        'issue-blast-voucher',
        '--scope',
        'billing',
        '--files',
        'packages/commercial/src/billing/ledger.ts',
        '--reason',
        'OCV5-903 audited billing fix',
      ],
      { env: { ...f.env, OC_GOVERNOR_ROOT: govRoot }, encoding: 'utf8' },
    )
    assert.equal(vRes.status, 0, vRes.stderr)
    const voucherId = JSON.parse(vRes.stdout).id
    r = runGuards(billingSha, `OC_V5_BLAST_VOUCHER=${q(voucherId)}`)
    assert.equal(r.status, 0, `vouchered billing edit should pass: ${r.stderr}`)

    // 7d: Unvouchered destructive DDL blocked!
    setAllGreen(ddlSha, 'push')
    r = runGuards(ddlSha)
    assert.notEqual(r.status, 0, 'unvouchered destructive DDL MUST be blocked')
    assert.match(r.stderr, /DESTRUCTIVE_DDL_LOCKED/)

    // 7e (B7 fail-closed): Missing/non-executable oc-governor MUST fail closed by default!
    setAllGreen(cleanSha, 'push')
    r = runGuards(cleanSha, `OC_V5_GOVERNOR_BIN=${q(join(f.dir, 'nonexistent-oc-governor'))}`)
    assert.notEqual(r.status, 0, 'missing oc-governor MUST fail closed by default in forward mode')
    assert.match(r.stderr, /缺少可执行宿主裁判.*fail-closed/)

    // 7f (B7 fail-closed): Failed git diff (bad base ref) MUST fail closed instead of passing empty file list!
    const rBadDiff = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `OC_GOVERNOR_ROOT=${q(govRoot)}`,
        `OC_V5_GOVERNOR_BIN=${q(OC_GOVERNOR)}`,
        `v5_selfhost_check_blast_radius ${q(cleanSha)} nonexistent-base-ref-xyz feat/v5-selfhost`,
      ].join('\n'),
      f.env,
    )
    assert.notEqual(rBadDiff.status, 0, 'failed git diff MUST fail closed instead of treating changed_files as empty')
    assert.match(rBadDiff.stderr, /git diff .*失败.*fail-closed/)

    // 8. Verified rollback (CUTOVER_ROLLBACK=1) takes emergency exemption even under emergency_stop + red CI!
    writeFileSync(modeFile, JSON.stringify({ mode: 'emergency_stop', reason: 'incident' }))
    r = runGuards(ddlSha, 'CUTOVER_ROLLBACK=1')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /应急回滚豁免/)
  })

  test('OCV5-914 train guards pass NUL diff + --sha/--base-ref, fail-closed on detached branch, honor NB4 on record failure, catch rename of core file, and allow AST pure-type non-core pass', (t) => {
    const f = makeTempGitRepo(t)
    const govRoot = join(f.dir, 'governor')
    const ctrl = join(govRoot, 'control')
    const stewardDir = join(govRoot, 'steward-receipts')
    mkdirSync(ctrl, { recursive: true })
    mkdirSync(stewardDir, { recursive: true })

    const hmacSecret = 'train-guards-914-hmac-secret'
    const hmacPath = join(ctrl, '.hmac-key')
    writeFileSync(hmacPath, `${hmacSecret}\n`, { mode: 0o600 })
    chmodSync(hmacPath, 0o600)

    mkdirSync(join(f.repo, 'packages/commercial/src/billing'), { recursive: true })
    writeFileSync(join(f.repo, 'packages/commercial/src/billing/proxyBilling.ts'), 'export function tag(x: number): string { return String(x) }\n')
    writeFileSync(join(f.repo, 'packages/commercial/src/billing/ledger.ts'), 'export const L = 1\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): base')
    const baseSha = f.git('rev-parse', 'HEAD')

    // 1. Core billing commit -> blocked AND auto-records pending approval gov-billing-<sha12> + prints /admin/#tab=governance
    writeFileSync(join(f.repo, 'packages/commercial/src/billing/ledger.ts'), 'export const L = 2\n')
    f.git('commit', '-qam', 'fix(v5): adjust ledger')
    const coreSha = f.git('rev-parse', 'HEAD')

    const runBlast = (sha: string, branch?: string, extraEnv = '') =>
      runBash(
        [
          `source ${q(TRAIN_GUARDS_LIB)}`,
          `REPO_ROOT=${q(f.repo)}`,
          `OC_GOVERNOR_ROOT=${q(govRoot)}`,
          `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
          `OC_V5_GOVERNOR_BIN=${q(OC_GOVERNOR)}`,
          `OC_GOVERNOR_STEWARD_VERIFIER=${q(join(REPO_ROOT, 'scripts/lib/archStewardReceipt.ts'))}`,
          extraEnv,
          branch !== undefined
            ? `v5_selfhost_check_blast_radius ${q(sha)} ${q(baseSha)} ${q(branch)}`
            : `v5_selfhost_check_blast_radius ${q(sha)} ${q(baseSha)}`,
        ].join('\n'),
        f.env,
      )

    const coreRes = runBlast(coreSha, 'feat/v5-selfhost')
    assert.notEqual(coreRes.status, 0)
    assert.match(coreRes.stderr, /BILLING_CORE_LOCKED/)
    assert.match(coreRes.stderr, /OC_V5_BLAST_VOUCHER/)
    const expectedCoreId = `gov-billing-${coreSha.slice(0, 12)}`
    assert.match(coreRes.stderr, new RegExp(`approvalId=${expectedCoreId}`))
    assert.match(coreRes.stderr, /\/admin\/#tab=governance/)
    const coreApprovalPath = join(ctrl, 'pending-approvals', `${expectedCoreId}.json`)
    assert.equal(existsSync(coreApprovalPath), true, 'must auto-record pending approval for BILLING_CORE_LOCKED')
    const coreApproval = JSON.parse(readFileSync(coreApprovalPath, 'utf8'))
    assert.equal(coreApproval.status, 'pending')
    assert.equal(coreApproval.version, 1)
    assert.equal(coreApproval.classification, 'human_review_required')
    assert.equal(coreApproval.code, 'BILLING_CORE_LOCKED')
    assert.equal(coreApproval.riskCategory, 'billing_change')
    assert.equal(typeof coreApproval.whatChanged, 'string')
    assert.match(coreApproval.whyNeedYou, /计费方式/)
    assert.ok(['approve', 'reject', 'caution'].includes(coreApproval.recommendation?.action))
    assert.equal(coreApproval.sha, coreSha)

    // 2. Commercial branch feat/v5-aurora-rewrite -> blocked AND NEVER creates any pending approval!
    const auroraRes = runBlast(coreSha, 'feat/v5-aurora-rewrite')
    assert.notEqual(auroraRes.status, 0)
    assert.match(auroraRes.stderr, /COMMERCIAL_BRANCH_HARD_LOCK/)
    assert.doesNotMatch(auroraRes.stderr, /approvalId=/)

    // 3. B3: Unresolved branch on detached HEAD -> MUST fail-closed (never silently default to feat/v5-selfhost!)
    f.git('checkout', '-q', '--detach', coreSha)
    const detachedRes = runBlast(coreSha, undefined)
    assert.notEqual(detachedRes.status, 0, 'detached HEAD without branch MUST fail closed')
    assert.match(detachedRes.stderr, /无法解析目标分支.*fail-closed/)

    // 4. B3: Pure comment/type edit on non-core billing with valid HMAC steward -> auto_pass!
    f.git('checkout', '-q', baseSha)
    writeFileSync(
      join(f.repo, 'packages/commercial/src/billing/proxyBilling.ts'),
      '// pure comment\nexport type ProxyHint = { id: string }\nexport function tag(x: number | bigint): string { return String(x) }\n',
    )
    f.git('commit', '-qam', 'refactor(v5): pure comment & type edit in proxyBilling')
    const nonCoreTypeSha = f.git('rev-parse', 'HEAD')

    const signed = signArchStewardReceipt(
      {
        schemaVersion: ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
        headSha: nonCoreTypeSha,
        baseSha,
        authorModel: 'claude-opus-4-6',
        authorFamily: 'anthropic-claude',
        stewardModel: 'gpt-5.4',
        stewardFamily: 'openai-gpt',
        verdict: 'approve',
        triggers: ['CLONE_OR_T2_CORE_PATH'],
        dimensions: {
          godClassAppend: { status: 'pass', notes: 'ok' },
          wheelReinvention: { status: 'pass', notes: 'ok' },
          boundaryIntegrity: { status: 'pass', notes: 'ok' },
          complexityDrift: { status: 'pass', notes: 'ok' },
        },
        blockers: [],
        usageEvidence: { jobId: 'job-914-train', timestamp: '2026-11-27T01:00:00Z' },
      },
      hmacSecret,
    )
    writeFileSync(join(stewardDir, `${nonCoreTypeSha}.json`), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o644 })

    const nonCorePass = runBlast(nonCoreTypeSha, 'feat/v5-selfhost')
    assert.equal(nonCorePass.status, 0, `pure type/comment non-core billing with HMAC steward should pass: ${nonCorePass.stderr}`)

    // 5. B3: Rename of core billing file to outside directory -> old path caught via git diff -z --name-status!
    f.git('checkout', '-q', baseSha)
    f.git('mv', 'packages/commercial/src/billing/ledger.ts', 'packages/commercial/src/moved-ledger.ts')
    f.git('commit', '-qm', 'refactor(v5): rename ledger outside billing')
    const renameSha = f.git('rev-parse', 'HEAD')
    const renameRes = runBlast(renameSha, 'feat/v5-selfhost')
    assert.notEqual(renameRes.status, 0, 'rename moving core billing file MUST be caught via old path in NUL diff')
    assert.match(renameRes.stderr, /BILLING_CORE_LOCKED/)

    // 6. NB4: When pending-approvals dir is unwritable so record-pending-approval fails, do NOT print fake approvalId/link!
    const lockedGovRoot = join(f.dir, 'ro-governor')
    const lockedCtrl = join(lockedGovRoot, 'control')
    const lockedPending = join(lockedCtrl, 'pending-approvals')
    mkdirSync(lockedPending, { recursive: true })
    // Place symlink as pending-approvals/.locks so _assert_safe_dir_chain rejects record-pending-approval
    symlinkSync(join(f.dir, 'nonexistent-target'), join(lockedPending, '.locks'))
    const nb4Res = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `OC_GOVERNOR_ROOT=${q(lockedGovRoot)}`,
        `OC_V5_GOVERNOR_CONTROL_DIR=${q(lockedCtrl)}`,
        `OC_V5_GOVERNOR_BIN=${q(OC_GOVERNOR)}`,
        `v5_selfhost_check_blast_radius ${q(coreSha)} ${q(baseSha)} feat/v5-selfhost`,
      ].join('\n'),
      f.env,
    )
    assert.notEqual(nb4Res.status, 0)
    assert.match(nb4Res.stderr, /BILLING_CORE_LOCKED/)
    assert.doesNotMatch(nb4Res.stderr, /approvalId=/, 'NB4: must NOT print approvalId when record-pending-approval failed')
    assert.doesNotMatch(nb4Res.stderr, /\/admin\/#tab=governance/, 'NB4: must NOT print console link when record-pending-approval failed')
  })

  test('OCV5-914 R2 train guards (B3/B6): enforces OC_V5_EXPECTED_HEAD, preserves space/comma file paths end-to-end through approval+voucher, and applies conservative SQL DDL whitelist', (t) => {
    const f = makeTempGitRepo(t)
    const govRoot = join(f.dir, 'governor')
    const ctrl = join(govRoot, 'control')
    const modeFile = join(ctrl, 'mode.json')
    const ghStub = join(f.dir, 'gh')
    const ghResp = join(f.dir, 'gh-runs.json')
    const retentionStub = join(f.dir, 'run-retention.sh')
    mkdirSync(ctrl, { recursive: true })
    writeFileSync(modeFile, JSON.stringify({ mode: 'autonomous', reason: 'ok' }))
    writeFileSync(ghStub, `#!/usr/bin/env bash\ncat ${q(ghResp)}\n`, { mode: 0o755 })
    writeFileSync(retentionStub, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

    mkdirSync(join(f.repo, 'packages/commercial/src/billing'), { recursive: true })
    mkdirSync(join(f.repo, 'packages/commercial/src/db/migrations'), { recursive: true })
    writeFileSync(join(f.repo, 'README.md'), 'init\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): base')
    const baseSha = f.git('rev-parse', 'HEAD')

    // 1. B6: OC_V5_EXPECTED_HEAD hard-binding in v5_selfhost_enforce_forward_cutover_guards
    writeFileSync(join(f.repo, 'README.md'), 'clean change\n')
    f.git('commit', '-qam', 'fix(v5): clean doc update')
    const cleanSha = f.git('rev-parse', 'HEAD')
    writeFileSync(
      ghResp,
      JSON.stringify({
        workflow_runs: [
          { id: 1, name: 'V5 selfhost gates', path: '.github/workflows/v5-selfhost-gates.yml', head_sha: cleanSha, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
          { id: 2, name: 'V5 selfhost release gates', path: '.github/workflows/v5-selfhost-release-gates.yml', head_sha: cleanSha, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
          { id: 3, name: 'V5 selfhost commercial', path: '.github/workflows/v5-selfhost-commercial.yml', head_sha: cleanSha, event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
        ],
      }),
    )
    const runForwardGuards = (sha: string, extra = '') =>
      runBash(
        [
          `source ${q(TRAIN_GUARDS_LIB)}`,
          `REPO_ROOT=${q(f.repo)}`,
          `OC_GOVERNOR_ROOT=${q(govRoot)}`,
          `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
          `OC_V5_GOVERNOR_MODE_FILE=${q(modeFile)}`,
          `OC_V5_GOVERNOR_BIN=${q(OC_GOVERNOR)}`,
          `OC_V5_GH_BIN=${q(ghStub)}`,
          'OC_V5_GH_REPO=dream-star-end/openclaude',
          `OC_V5_RETENTION_RUNNER=${q(retentionStub)}`,
          extra,
          `v5_selfhost_enforce_forward_cutover_guards ${q(sha)} ${q(baseSha)} feat/v5-selfhost`,
        ].join('\n'),
        f.env,
      )

    const mismatchHead = runForwardGuards(cleanSha, `OC_V5_EXPECTED_HEAD=${q('1'.repeat(40))}`)
    assert.notEqual(mismatchHead.status, 0, 'mismatched OC_V5_EXPECTED_HEAD MUST fail closed')
    assert.match(mismatchHead.stderr, /\[expected-head\]/)

    const matchHead = runForwardGuards(cleanSha, `OC_V5_EXPECTED_HEAD=${q(cleanSha)}`)
    assert.equal(matchHead.status, 0, `matching OC_V5_EXPECTED_HEAD should pass: ${matchHead.stderr}`)

    // 2. B3: Lossless path with space & comma flows 3-way identically: git diff -> pending approval -> blast voucher -> re-check passes!
    f.git('checkout', '-q', baseSha)
    const trickyRel = 'packages/commercial/src/billing/x,y costHelper.ts'
    writeFileSync(join(f.repo, trickyRel), 'export const TRICKY = 1\n')
    f.git('add', trickyRel)
    f.git('commit', '-qm', 'fix(v5): add cost helper with comma and space')
    const trickySha = f.git('rev-parse', 'HEAD')

    const runBlastOnly = (sha: string, extra = '') =>
      runBash(
        [
          `source ${q(TRAIN_GUARDS_LIB)}`,
          `REPO_ROOT=${q(f.repo)}`,
          `OC_GOVERNOR_ROOT=${q(govRoot)}`,
          `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
          `OC_V5_GOVERNOR_BIN=${q(OC_GOVERNOR)}`,
          'OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER=1',
          extra,
          `v5_selfhost_check_blast_radius ${q(sha)} ${q(baseSha)} feat/v5-selfhost`,
        ].join('\n'),
        f.env,
      )

    const trickyBlocked = runBlastOnly(trickySha)
    assert.notEqual(trickyBlocked.status, 0)
    assert.match(trickyBlocked.stderr, /BILLING_CORE_LOCKED/)
    const trickyApprovalId = `gov-billing-${trickySha.slice(0, 12)}`
    const trickyApprovalDoc = JSON.parse(readFileSync(join(ctrl, 'pending-approvals', `${trickyApprovalId}.json`), 'utf8'))
    assert.deepEqual(trickyApprovalDoc.files, [trickyRel], 'pending approval MUST preserve exact path with space & comma')
    assert.equal(trickyApprovalDoc.riskCategory, 'billing_change')

    const decTricky = spawnSync(
      'bash',
      [OC_GOVERNOR, 'decide-pending-approval', '--id', trickyApprovalId, '--decision', 'approve', '--actor', 'admin-r2', '--note', 'Approve tricky filename'],
      { env: { ...f.env, OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER: '1' }, encoding: 'utf8' },
    )
    assert.equal(decTricky.status, 0, decTricky.stderr)
    const trickyVoucherId = JSON.parse(decTricky.stdout).decision.issuedArtifactId
    const trickyPass = runBlastOnly(trickySha, `OC_V5_BLAST_VOUCHER=${q(trickyVoucherId)}`)
    assert.equal(trickyPass.status, 0, `approved voucher for tricky space+comma path MUST pass check-blast-radius: ${trickyPass.stderr}`)

    // 3. B3 SQL DDL whitelist via train guards: safe additive & safe idempotent DO $$ pass; unsafe DO $$ fails closed as DESTRUCTIVE_DDL_LOCKED with riskCategory=ux_degradation
    f.git('checkout', '-q', baseSha)
    writeFileSync(
      join(f.repo, 'packages/commercial/src/db/migrations/100_safe_additive.sql'),
      'CREATE TABLE IF NOT EXISTS r2_events (id bigserial PRIMARY KEY);\nDO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = \'idx_r2_events\') THEN\n    CREATE INDEX IF NOT EXISTS idx_r2_events ON r2_events (id);\n  END IF;\nEND $$;\n',
    )
    f.git('add', '.')
    f.git('commit', '-qm', 'feat(v5): safe additive + idempotent DO migration')
    const safeSqlSha = f.git('rev-parse', 'HEAD')
    const safeSqlPass = runBlastOnly(safeSqlSha)
    assert.equal(safeSqlPass.status, 0, `safe additive + idempotent DO SQL migration should pass: ${safeSqlPass.stderr}`)

    f.git('checkout', '-q', baseSha)
    mkdirSync(join(f.repo, 'packages/commercial/src/db/migrations'), { recursive: true })
    writeFileSync(
      join(f.repo, 'packages/commercial/src/db/migrations/101_unrecognized.sql'),
      'DO $$ BEGIN PERFORM 1; END $$;\n',
    )
    f.git('add', '.')
    f.git('commit', '-qm', 'feat(v5): DO block migration')
    const doSqlSha = f.git('rev-parse', 'HEAD')
    const doSqlBlocked = runBlastOnly(doSqlSha)
    assert.notEqual(doSqlBlocked.status, 0, 'unrecognized DO $$ migration MUST be blocked as DESTRUCTIVE_DDL_LOCKED')
    assert.match(doSqlBlocked.stderr, /DESTRUCTIVE_DDL_LOCKED/)
    const ddlApprovalId = `gov-ddl-${doSqlSha.slice(0, 12)}`
    const ddlApprovalDoc = JSON.parse(readFileSync(join(ctrl, 'pending-approvals', `${ddlApprovalId}.json`), 'utf8'))
    assert.equal(ddlApprovalDoc.riskCategory, 'ux_degradation')
    assert.match(ddlApprovalDoc.whyNeedYou, /用户体验/)
  })

  test('removes OC_V5_SKIP_TRAILER_GATE=1 env escape hatch while allowing exact-SHA host break-glass file', (t) => {
    const sb = makeSandbox(t, 'ocv5-903-trailer-')
    const ctrl = join(sb.dir, 'control')
    mkdirSync(ctrl, { recursive: true })
    const sha = 'c'.repeat(40)
    const fnSrc = extractBashFn(readFileSync(DEPLOY_SCRIPT, 'utf8'), 'assert_fix_trailers')
    const fakeGate = join(sb.dir, 'fake-trailer-gate.sh')
    writeFileSync(fakeGate, '#!/usr/bin/env bash\necho "TRAILER-GATE-FAILED" >&2\nexit 1\n')
    chmodSync(fakeGate, 0o755)

    let r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        'log() { echo "$*"; }; die() { echo "✗ $*" >&2; exit 1; }',
        `REPO_ROOT=${q(REPO_ROOT)}; FIX_TRAILER_GATE=${q(fakeGate)}; OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
        fnSrc,
        `OC_V5_SKIP_TRAILER_GATE=1 assert_fix_trailers ${q(sha)}`,
      ].join('\n'),
      sb.env,
    )
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /OC_V5_SKIP_TRAILER_GATE=1 环境变量逃生口已物理移除/)

    writeFileSync(join(ctrl, `trailer-breakglass-${sha}`), 'p0-outage-root-override\n')
    r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        'log() { echo "$*"; }; die() { echo "✗ $*" >&2; exit 1; }',
        `REPO_ROOT=${q(REPO_ROOT)}; FIX_TRAILER_GATE=${q(fakeGate)}; OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
        fnSrc,
        `assert_fix_trailers ${q(sha)}`,
      ].join('\n'),
      sb.env,
    )
    assert.equal(r.status, 0, r.stderr)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// B8: Commit-Bound Runtime Image Pin & Rollback Isolation
// ═════════════════════════════════════════════════════════════════════════════
describe('B8. Commit-bound runtime image pin & rollback isolation from broken worktree pin', () => {
  test('reads runtime-image-pin from exact target commit even when dirty worktree pin is corrupt, and enforces full runtimeImagePin schema', (t) => {
    const f = makeTempGitRepo(t)

    // Historical commit without pin file -> fallback default
    writeFileSync(join(f.repo, 'a.txt'), 'v0\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): pre-pin commit')
    const legacySha = f.git('rev-parse', 'HEAD')

    // Target commit with valid pin file
    mkdirSync(join(f.repo, 'deploy/v5'), { recursive: true })
    const validPin = {
      schemaVersion: 1,
      channel: 'v5-selfhost',
      runtimeImage: 'openclaude/openclaude-runtime:v5-commit-pinned-20261126',
      previousRuntimeImage: 'openclaude/openclaude-runtime:v5-prev-pinned-20261120',
      cliVersions: { claudeCode: '2.1.332', codex: '0.172.0' },
      capabilities: { chrome: '158', sciVerify: ['pint', 'z3-solver'] },
      ticket: 'OCV5-903',
    }
    writeFileSync(join(f.repo, 'deploy/v5/runtime-image-pin.json'), `${JSON.stringify(validPin, null, 2)}\n`)
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): add valid commit pin')
    const validSha = f.git('rev-parse', 'HEAD')

    // Bad commit with array capabilities (conflicts with TS runtimeImagePin.ts object schema) -> MUST fail closed!
    writeFileSync(
      join(f.repo, 'deploy/v5/runtime-image-pin.json'),
      JSON.stringify({ ...validPin, capabilities: ['chrome'] }),
    )
    f.git('commit', '-qam', 'chore(v5): bad array capabilities')
    const badCapsSha = f.git('rev-parse', 'HEAD')

    // Bad commit with floating :latest tag -> MUST fail closed!
    writeFileSync(
      join(f.repo, 'deploy/v5/runtime-image-pin.json'),
      JSON.stringify({ ...validPin, runtimeImage: 'openclaude/openclaude-runtime:latest' }),
    )
    f.git('commit', '-qam', 'chore(v5): bad latest tag')
    const latestSha = f.git('rev-parse', 'HEAD')

    // Bad commit with non-allowlisted repo prefix -> MUST fail closed!
    writeFileSync(
      join(f.repo, 'deploy/v5/runtime-image-pin.json'),
      JSON.stringify({ ...validPin, runtimeImage: 'evil.example/pwn:v1' }),
    )
    f.git('commit', '-qam', 'chore(v5): bad repo prefix')
    const evilSha = f.git('rev-parse', 'HEAD')

    // Now CORRUPT the dirty working tree pin file completely!
    f.git('checkout', '-q', validSha)
    writeFileSync(join(f.repo, 'deploy/v5/runtime-image-pin.json'), '{{{ BROKEN WORKTREE JSON ; rm -rf /')

    // 1. Commit-bound loader on validSha SUCCEEDS using exact commit pin (ignoring corrupt worktree!)
    let r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `v5_selfhost_load_runtime_image_pin_for_commit ${q(validSha)}`,
        'printf "%s|%s|%s\\n" "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_PIN_SOURCE" "$RUNTIME_IMAGE_PIN_SHA256"',
      ].join('\n'),
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    const [img, src, digest] = r.stdout.trim().split('|')
    assert.equal(img, 'openclaude/openclaude-runtime:v5-commit-pinned-20261126')
    assert.equal(src, `commit:${validSha}:deploy/v5/runtime-image-pin.json`)
    assert.match(digest!, /^[0-9a-f]{64}$/)

    // 2. Commit without pin file falls back to built-in default (still ignoring corrupt worktree!)
    r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `v5_selfhost_load_runtime_image_pin_for_commit ${q(legacySha)}`,
        'printf "%s|%s\\n" "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_PIN_SOURCE"',
      ].join('\n'),
      f.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`fallback-default:${legacySha}`))

    // 3. :latest, array capabilities, and non-allowlisted repo prefix fail closed
    r = runBash(
      `source ${q(TRAIN_GUARDS_LIB)}; REPO_ROOT=${q(f.repo)}; v5_selfhost_load_runtime_image_pin_for_commit ${q(badCapsSha)}`,
      f.env,
    )
    assert.notEqual(r.status, 0, 'array capabilities must fail closed to match TS runtimeImagePin.ts object schema')
    assert.match(r.stderr, /capabilities 必须为 JSON 对象/)

    // 4. REAL repository HEAD pin loads cleanly via production v5_selfhost_load_runtime_image_pin_for_commit!
    const repoHead = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const livePinDoc = JSON.parse(readFileSync(join(REPO_ROOT, 'deploy/v5/runtime-image-pin.json'), 'utf8'))
    r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `REPO_ROOT=${q(REPO_ROOT)}`,
        `v5_selfhost_load_runtime_image_pin_for_commit ${q(repoHead)}`,
        'printf "%s|%s\\n" "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_PIN_SOURCE"',
      ].join('\n'),
      f.env,
    )
    assert.equal(r.status, 0, `real repo HEAD pin MUST pass shell loader: ${r.stderr}`)
    assert.equal(r.stdout.trim(), `${livePinDoc.runtimeImage}|commit:${repoHead}:deploy/v5/runtime-image-pin.json`)

    r = runBash(
      `source ${q(TRAIN_GUARDS_LIB)}; REPO_ROOT=${q(f.repo)}; v5_selfhost_load_runtime_image_pin_for_commit ${q(latestSha)}`,
      f.env,
    )
    assert.notEqual(r.status, 0, ':latest tag must fail closed')
    assert.match(r.stderr, /:latest/)

    r = runBash(
      `source ${q(TRAIN_GUARDS_LIB)}; REPO_ROOT=${q(f.repo)}; v5_selfhost_load_runtime_image_pin_for_commit ${q(evilSha)}`,
      f.env,
    )
    assert.notEqual(r.status, 0, 'untrusted image repo prefix must fail closed')
    assert.match(r.stderr, /允许的镜像仓库前缀/)
  })

  test('cmd_rollback resolves historical runtime image BEFORE preflight_common and succeeds even when worktree runtime-image-pin.json is corrupted', (t) => {
    const f = makeTempGitRepo(t)
    const releases = join(f.dir, 'releases')
    const rtReleases = join(f.dir, 'runtime-releases')
    const bundles = join(f.dir, 'platform/bundles')
    const envFile = join(f.dir, 'selfhost.env')
    const historyFile = join(f.dir, 'runtime-tuple.history')
    const liveLink = join(f.dir, 'live')
    const witnessLog = join(f.dir, 'rollback-witness.log')
    mkdirSync(releases, { recursive: true })
    mkdirSync(rtReleases, { recursive: true })
    mkdirSync(bundles, { recursive: true })

    // Corrupt working tree runtime-image-pin.json!
    mkdirSync(join(f.repo, 'deploy/v5'), { recursive: true })
    writeFileSync(join(f.repo, 'deploy/v5/runtime-image-pin.json'), 'CORRUPT FORWARD WORKTREE PIN {{{')

    const prevSha = '1'.repeat(40)
    const curSha = '2'.repeat(40)
    const prevRel = join(releases, 'rel-prev')
    const curRel = join(releases, 'rel-cur')
    const prevRt = join(rtReleases, 'rel-rt-prev')
    const prevBundle = join(bundles, 'b-prev')
    mkdirSync(prevRel, { recursive: true })
    mkdirSync(curRel, { recursive: true })
    mkdirSync(prevRt, { recursive: true })
    mkdirSync(prevBundle, { recursive: true })
    writeFileSync(join(prevRel, '.complete'), JSON.stringify({ sourceCommit: prevSha }))
    writeFileSync(join(curRel, '.complete'), JSON.stringify({ sourceCommit: curSha }))
    writeFileSync(join(releases, '.prev-release'), `${prevRel}\n`)
    writeFileSync(envFile, 'COMMERCIAL_AUTO_MIGRATE=0\n')
    symlinkSync(curRel, liveLink)

    const histImg = 'openclaude/openclaude-runtime:v5-known-good-historical'
    const histImgId = `sha256:${'a'.repeat(64)}`
    const beforeRec = JSON.stringify({
      masterRelease: prevRel,
      transitionKind: 'joint',
      image: histImg,
      image_id: histImgId,
      release: prevRt,
      bundle: prevBundle,
    })
    const lastRec = JSON.stringify({
      masterRelease: curRel,
      transitionKind: 'joint',
      previousMasterRelease: prevRel,
      image: 'openclaude/openclaude-runtime:v5-bad-forward',
      image_id: `sha256:${'b'.repeat(64)}`,
      release: prevRt,
      bundle: prevBundle,
    })

    const r = runBash(
      [
        `REPO_ROOT=${q(f.repo)}`,
        `V5_ENV=${q(envFile)}`,
        `MASTER_LIVE_LINK=${q(liveLink)}`,
        `MASTER_RELEASES_ROOT=${q(releases)}`,
        `OC_HOTCFG_RELEASES_ROOT=${q(rtReleases)}`,
        `OC_HOTCFG_PLATFORM_ROOT=${q(join(f.dir, 'platform'))}`,
        `OC_HOTCFG_HISTORY=${q(historyFile)}`,
        'DRY=0; CUTOVER_ROLLBACK=0; ROLLBACK_SHA=""; ROLLBACK_FROM=""; ROLLBACK_ORIG_PREV=""',
        'log() { echo "$*"; }; mlog() { echo "$*" >&2; }; die() { echo "✗ $*" >&2; exit 1; }',
        'require_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing $1"; }',
        `canonicalize_prev_release() { printf '%s\\n' "$1"; }`,
        `oc_hotcfg_history_nth_committed() { if [[ "$2" == 1 ]]; then printf '%s\\n' ${q(lastRec)}; else printf '%s\\n' ${q(beforeRec)}; fi; }`,
        'oc_hotcfg_assert_tuple_viable() { return 0; }',
        // Assert preflight_common sees RUNTIME_IMAGE ALREADY bound to historical image!
        `preflight_common() { echo "PREFLIGHT_RUNTIME_IMAGE=$RUNTIME_IMAGE|SOURCE=$RUNTIME_IMAGE_PIN_SOURCE" >> ${q(witnessLog)}; }`,
        'lease_train_begin() { :; }; lease_train_finish() { :; }',
        `cmd_cutover() { echo "CUTOVER_ROLLBACK=$CUTOVER_ROLLBACK|IMAGE=$RUNTIME_IMAGE|MASTER=$DEPLOY_BUILT_RELEASE" >> ${q(witnessLog)}; }`,
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `source ${q(ROLLBACK_LIB)}`,
        'cmd_rollback',
      ].join('\n'),
      f.env,
    )
    assert.equal(r.status, 0, r.stderr + r.stdout)
    const witness = readFileSync(witnessLog, 'utf8')
    assert.match(witness, new RegExp(`PREFLIGHT_RUNTIME_IMAGE=${histImg}\\|SOURCE=rollback-history:`))
    assert.match(witness, new RegExp(`CUTOVER_ROLLBACK=1\\|IMAGE=${histImg}\\|MASTER=${prevRel}`))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Static Wiring & Syntax Integrity Across All Modified Scripts
// ═════════════════════════════════════════════════════════════════════════════
describe('Static wiring & syntax integrity across all modified scripts', () => {
  test('all modified bash scripts pass bash -n and deploy/master-lib enforce shared forward guards & commit-bound pin', () => {
    for (const rel of [
      'scripts/deploy-v5-selfhost.sh',
      'scripts/lib/v5-selfhost-governance-gates.sh',
      'scripts/lib/v5-selfhost-train-guards.sh',
      'scripts/lib/v5-selfhost-release-policy.sh',
      'scripts/lib/v5-selfhost-prepare.sh',
      'scripts/lib/v5-selfhost-rollback.sh',
      'scripts/lib/v5-selfhost-prewarm.sh',
      'scripts/v5-selfhost-master-release-lib.sh',
      'scripts/v5-lease-worker.sh',
      'scripts/lib/v5-lease-train-debounce.sh',
      'scripts/v5-selfhost-cutover-survivor.sh',
      'scripts/check-biome-changed.sh',
    ]) {
      const r = spawnSync('bash', ['-n', join(REPO_ROOT, rel)], { encoding: 'utf8' })
      assert.equal(r.status, 0, `bash -n failed for ${rel}: ${r.stderr}`)
    }
    const deploySrc = readFileSync(DEPLOY_SCRIPT, 'utf8')
    assert.match(deploySrc, /source "\$SCRIPT_DIR\/lib\/v5-selfhost-train-guards\.sh"/)
    // B8: MUST NOT eagerly call v5_selfhost_load_runtime_image_pin at top level before mode/SHA!
    assert.doesNotMatch(deploySrc, /^v5_selfhost_load_runtime_image_pin$/m)
    assert.match(deploySrc, /v5_selfhost_load_runtime_image_pin_for_commit "\$sha"/)
    assert.match(deploySrc, /^FIX_TRAILER_GATE="\$SCRIPT_DIR\/check-v5-fix-trailers\.sh"$/m)

    // B7: BOTH cmd_deploy AND cmd_cutover invoke shared v5_selfhost_enforce_forward_cutover_guards!
    const fnDeploy = extractBashFn(deploySrc, 'cmd_deploy')
    const fnCutover = extractBashFn(deploySrc, 'cmd_cutover')
    assert.match(fnDeploy, /v5_selfhost_enforce_forward_cutover_guards "\$sha"/)
    assert.match(fnCutover, /v5_selfhost_enforce_forward_cutover_guards "\$head"/)
    assert.ok(
      fnCutover.indexOf('v5_selfhost_enforce_forward_cutover_guards "$head"') <
        fnCutover.indexOf('atomic_flip_live_symlink'),
      'forward cutover guards MUST run BEFORE live mutation in cmd_cutover',
    )

    // B6: retention gate runs INSIDE cmd_cutover BEFORE committed & release_policy_finalize_forward!
    assert.doesNotMatch(fnDeploy, /v5_selfhost_post_cutover_retention_gate/)
    const retIdx = fnCutover.indexOf('v5_selfhost_post_cutover_retention_gate "$rel" "$head"')
    const polIdx = fnCutover.indexOf('release_policy_finalize_forward "$rel"')
    const comIdx = fnCutover.indexOf('cutover_persist_phase "committed"')
    assert.ok(retIdx > 0 && retIdx < polIdx && retIdx < comIdx, 'retention MUST run BEFORE finalize_forward and committed')

    const masterSrc = readFileSync(MASTER_LIB, 'utf8')
    assert.match(masterSrc, /master_referee_prepare_exec_root "\$staging" scripts\/check-architecture\.ts "\$full_sha"/)
    assert.match(masterSrc, /env -u NODE_OPTIONS -u NODE_PATH -u TSX_TSCONFIG_PATH npx --no-install tsx scripts\/check-architecture\.ts/)
  })
})
