/**
 * Tests for ops/selfheal-release-lane.sh.
 *
 *  (1) `bash -n` must parse the lane cleanly (syntax gate).
 *  (2) A hermetic smoke in a tmp dir: a real local git canonical + bare origin +
 *      candidate commit, a stubbed scripts/deploy-v5.sh (exit 0), a PATH-shimmed
 *      fake `ssh` (canned stable deploy_state, no recovery marker), and a stub
 *      proof command via OC_SELFHEAL_PROOF_CMD. No real ssh / deploy / kl-mirror.
 *      Asserts:
 *        - baseSha != actual HEAD → last stdout line is a manual receipt
 *          (reason=canonical_advanced);
 *        - happy path → a checkpoint line followed by a deployed receipt.
 *  Guarded with a skip when git/jq/bash are unavailable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LANE = fileURLToPath(new URL('../../../../ops/selfheal-release-lane.sh', import.meta.url))

function toolsAvailable(): boolean {
  for (const t of [['git', '--version'], ['jq', '--version'], ['bash', '--version']]) {
    try {
      execFileSync(t[0], [t[1]], { stdio: 'ignore' })
    } catch {
      return false
    }
  }
  return true
}
const HAVE_TOOLS = toolsAvailable()

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.local',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim()
}

interface Fixture {
  work: string
  bare: string
  branch: string
  baseSha: string
  candidateSha: string
  candidateRef: string
  binDir: string
  proofStub: string
  lockFile: string
}

/** Build a canonical repo (with a committed deploy-v5.sh stub) + bare origin +
 *  a candidate commit, and the PATH-shim / proof-stub / lock scaffolding. */
function buildFixture(root: string, proofVerdictJson: string): Fixture {
  const branch = 'canon'
  const bare = join(root, 'origin.git')
  const work = join(root, 'canonical')
  mkdirSync(bare)
  mkdirSync(work)
  execFileSync('git', ['init', '--bare', '--initial-branch', branch, bare], { stdio: 'ignore' })
  git(work, 'init', '--initial-branch', branch)

  // Base commit — includes a committed deploy-v5.sh stub so the worktree is CLEAN.
  mkdirSync(join(work, 'scripts'))
  writeFileSync(join(work, 'scripts', 'deploy-v5.sh'), '#!/usr/bin/env bash\nexit 0\n')
  writeFileSync(join(work, 'app.txt'), 'base\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', 'base')
  const baseSha = git(work, 'rev-parse', 'HEAD')

  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', 'origin', branch)

  // Candidate commit on top, then reset the branch back to base (HEAD == base).
  git(work, 'checkout', '-b', 'cand')
  writeFileSync(join(work, 'app.txt'), 'candidate\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', 'candidate')
  const candidateSha = git(work, 'rev-parse', 'HEAD')
  git(work, 'checkout', branch)

  // PATH shim: fake ssh (stable deploy_state, no recovery marker).
  const binDir = join(root, 'bin')
  mkdirSync(binDir)
  const fakeSsh = join(binDir, 'ssh')
  writeFileSync(
    fakeSsh,
    [
      '#!/usr/bin/env bash',
      '# fake ssh: $1=host, $2=remote script. Route on the remote script.',
      'script="${2:-}"',
      'case "$script" in',
      '  *manual-recovery-required*) exit 1 ;;', // marker ABSENT
      "  *deploy_state*) printf 'stable|A|||\\n'; exit 0 ;;",
      // axis pre-gate probe (§F4): echo a non-empty value ONLY when the axis is
      // "enabled" for this run (FAKE_AXIS_ENABLED set); otherwise empty → manual.
      '  *OC_RUNTIME_RELEASE*|*OC_PLATFORM_BUNDLE*) [ -n "${FAKE_AXIS_ENABLED:-}" ] && printf "/var/lib/openclaude-v5/runtime-releases/rel-x\\n"; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n') + '\n',
  )
  chmodSync(fakeSsh, 0o755)

  // Proof stub honored via OC_SELFHEAL_PROOF_CMD.
  const proofStub = join(binDir, 'proofstub.sh')
  writeFileSync(proofStub, `#!/usr/bin/env bash\nprintf '%s\\n' '${proofVerdictJson}'\n`)
  chmodSync(proofStub, 0o755)

  const candidateRef = `refs/heads/selfheal/candidates/testrepair-${candidateSha.slice(0, 12)}`
  return {
    work,
    bare,
    branch,
    baseSha,
    candidateSha,
    candidateRef,
    binDir,
    proofStub,
    lockFile: join(root, 'deploy.lock'),
  }
}

function runLane(
  fx: Fixture,
  argsObj: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): string[] {
  const argsFile = join(fx.work, '..', 'args.json')
  writeFileSync(argsFile, JSON.stringify(argsObj))
  const out = execFileSync('bash', [LANE, argsFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${fx.binDir}:${process.env.PATH ?? ''}`,
      OC_SELFHEAL_PROOF_CMD: fx.proofStub,
      OC_V5_DEPLOY_LOCK: fx.lockFile,
      ...extraEnv,
    },
  })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

function argsFor(fx: Fixture, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rrid: 'rrid-test-1',
    repairId: 'testrepair',
    canonicalRepo: fx.work,
    canonicalBranch: fx.branch,
    baseSha: fx.baseSha,
    sha: fx.candidateSha,
    candidateRef: fx.candidateRef,
    deployArgs: [],
    manifestHash: 'a'.repeat(64),
    planHash: 'b'.repeat(64),
    proofPlan: { surfaces: ['master'] },
    ...over,
  }
}

test('bash -n parses the lane cleanly', () => {
  // This gate has no external-tool dependency beyond bash.
  execFileSync('bash', ['-n', LANE], { stdio: 'ignore' })
})

test('canonical_advanced early-exit → manual receipt', { skip: !HAVE_TOOLS }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-adv-'))
  const fx = buildFixture(root, '{"faces":{},"allOk":true,"verdict":"deployed"}')
  // baseSha in argsFile deliberately != actual HEAD.
  const lines = runLane(fx, argsFor(fx, { baseSha: 'f'.repeat(40) }))
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(last.evt, 'receipt')
  assert.equal(last.outcome, 'manual')
  assert.equal(last.reason, 'canonical_advanced')
  // Nothing should have been pushed to the bare origin candidate ref.
  const ls = git(fx.work, 'ls-remote', 'origin', fx.candidateRef)
  assert.equal(ls, '')
})

test('happy path → checkpoint line then deployed receipt', { skip: !HAVE_TOOLS }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-ok-'))
  const fx = buildFixture(root, '{"faces":{},"allOk":true,"verdict":"deployed"}')
  const lines = runLane(fx, argsFor(fx))
  const events = lines.map((l) => JSON.parse(l))

  const checkpoint = events.find((e) => e.evt === 'checkpoint')
  const receipt = events.find((e) => e.evt === 'receipt')
  assert.ok(checkpoint, 'expected a checkpoint line')
  assert.equal(checkpoint.kind, 'deploy_effect_applied')
  assert.equal(checkpoint.sha, fx.candidateSha)
  assert.equal(checkpoint.candidateRef, fx.candidateRef)

  assert.ok(receipt, 'expected a receipt line')
  assert.equal(receipt.outcome, 'deployed')
  assert.equal(receipt.sha, fx.candidateSha)
  assert.equal(receipt.canonicalPush, 'pushed')
  assert.equal(receipt.exit, 0)

  // checkpoint must precede the receipt on stdout.
  assert.ok(
    lines.findIndex((l) => l.includes('"checkpoint"')) <
      lines.findIndex((l) => l.includes('"receipt"')),
    'checkpoint must precede receipt',
  )

  // The lane actually fast-forwarded the bare origin branch to the candidate.
  const originHead = git(fx.work, 'ls-remote', 'origin', fx.branch).split('\t')[0]
  assert.equal(originHead, fx.candidateSha)
})

// ── §F3: verdict-driven local-canonical reset semantics ──────────────────────

test('deploy_failed → local canonical reset back to base (F3)', { skip: !HAVE_TOOLS }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-failed-'))
  const fx = buildFixture(root, '{"faces":{},"allOk":false,"verdict":"deploy_failed"}')
  const lines = runLane(fx, argsFor(fx))
  const receipt = lines.map((l) => JSON.parse(l)).find((e) => e.evt === 'receipt')
  assert.ok(receipt)
  assert.equal(receipt.outcome, 'deploy_failed')
  assert.equal(receipt.canonicalPush, 'failed')
  // The ff-merge (which advanced local HEAD to the candidate) must be UNDONE so a
  // retry doesn't die on canonical_advanced. origin canonical was never advanced.
  assert.equal(git(fx.work, 'rev-parse', 'HEAD'), fx.baseSha, 'local canonical reset to base')
  assert.equal(
    git(fx.work, 'ls-remote', 'origin', fx.branch).split('\t')[0],
    fx.baseSha,
    'origin canonical never advanced on deploy_failed',
  )
})

test('deploy_unknown → local canonical is NOT reset (stays at candidate) (F3)', { skip: !HAVE_TOOLS }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-unknown-'))
  const fx = buildFixture(root, '{"faces":{},"allOk":false,"verdict":"deploy_unknown"}')
  const lines = runLane(fx, argsFor(fx))
  const receipt = lines.map((l) => JSON.parse(l)).find((e) => e.evt === 'receipt')
  assert.ok(receipt)
  assert.equal(receipt.outcome, 'deploy_unknown')
  assert.equal(receipt.canonicalPush, 'pending')
  // deploy_unknown may be live — a reset could split source from prod → NOT reset.
  assert.equal(
    git(fx.work, 'rev-parse', 'HEAD'),
    fx.candidateSha,
    'local canonical stays at the candidate sha (human adjudicates)',
  )
})

// ── §F4: axis pre-gate ───────────────────────────────────────────────────────

test('a required axis that is NOT enabled on the remote → manual (axis_not_enabled)', { skip: !HAVE_TOOLS }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-axis-off-'))
  const fx = buildFixture(root, '{"faces":{},"allOk":true,"verdict":"deployed"}')
  // FAKE_AXIS_ENABLED unset → the axis probe returns empty → refuse before merge.
  const lines = runLane(fx, argsFor(fx, { requiredAxes: ['runtime-release'] }))
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(last.evt, 'receipt')
  assert.equal(last.outcome, 'manual')
  assert.equal(last.reason, 'axis_not_enabled')
  // Nothing merged / pushed.
  assert.equal(git(fx.work, 'ls-remote', 'origin', fx.candidateRef), '')
})

test('a required axis that IS enabled on the remote → proceeds to deploy', { skip: !HAVE_TOOLS }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-axis-on-'))
  const fx = buildFixture(root, '{"faces":{},"allOk":true,"verdict":"deployed"}')
  const lines = runLane(fx, argsFor(fx, { requiredAxes: ['runtime-release'] }), {
    FAKE_AXIS_ENABLED: '1',
  })
  const receipt = lines.map((l) => JSON.parse(l)).find((e) => e.evt === 'receipt')
  assert.ok(receipt)
  assert.equal(receipt.outcome, 'deployed', 'axis enabled → the lane runs the deploy')
})
