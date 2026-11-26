/**
 * OCV5-904: Host Pinned Referee, Pre-Dispatch CI Green Gate, Trailer Escape Removal,
 * Declarative Runtime Image Pin, Host Governor Mode Gate, Post-Cutover Retention
 * Auto-Rollback + Breaker Trip, 45s Train Debounce, and Planned Auto Fast-Forward.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GOV_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-governance-gates.sh')
const TRAIN_GUARDS_LIB = join(REPO_ROOT, 'scripts/lib/v5-selfhost-train-guards.sh')
const DEPLOY_SCRIPT = join(REPO_ROOT, 'scripts/deploy-v5-selfhost.sh')
const MASTER_LIB = join(REPO_ROOT, 'scripts/v5-selfhost-master-release-lib.sh')
const LEASE_WORKER = join(REPO_ROOT, 'scripts/v5-lease-worker.sh')
const LEASE_CLI = join(REPO_ROOT, 'scripts/oc-lease.sh')
const LEASE_LIB = join(REPO_ROOT, 'scripts/v5-lease-lib.sh')
const DEBOUNCE_LIB = join(REPO_ROOT, 'scripts/lib/v5-lease-train-debounce.sh')

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

function makeSandbox(t: { after: (fn: () => void) => void }, prefix = 'ocv5-904-') {
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

function makeTempGitRepo(t: { after: (fn: () => void) => void }) {
  const sb = makeSandbox(t, 'ocv5-904-git-')
  const repo = join(sb.dir, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env: sb.env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'feat/v5-selfhost')
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

function exportArchive(repo: string, sha: string, staging: string, env: NodeJS.ProcessEnv) {
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const r = spawnSync(
    'bash',
    ['-euo', 'pipefail', '-c', `git -C ${q(repo)} archive --format=tar ${q(sha)} | tar -x -C ${q(staging)}`],
    { env, encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(staging, 'node_modules'))
}

describe('1. Host Pinned Referee physical isolation & first-roll bootstrap (OCV5-904)', () => {
  test('prefers external REFEREE_ROOT over staging/live and blocks forged staging script', (t) => {
    const f = makeTempGitRepo(t)
    const staging = join(f.dir, 'staging')
    const gateTmp = join(f.dir, 'gate-tmp')
    const extRef = join(f.dir, 'ext-referee')
    const liveRel = join(f.dir, 'rel-live')
    const liveLink = join(f.dir, 'live')
    const invokedLog = join(f.dir, 'referee-invoked.log')
    mkdirSync(gateTmp, { recursive: true })
    mkdirSync(extRef, { recursive: true })
    mkdirSync(liveRel, { recursive: true })

    // Candidate repo: forge check-docs-links.ts to always pass (exit 0)
    seedGovStubs(f.repo)
    writeFileSync(join(f.repo, 'changelog.json'), '[]\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): base')
    const baseSha = f.git('rev-parse', 'HEAD')

    writeFileSync(join(f.repo, 'README.md'), 'updated\n')
    writeFileSync(join(f.repo, 'scripts/check-docs-links.ts'), 'console.log("FAKE-STAGING-PASSED"); process.exit(0)\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'feat(v5): candidate tries to tamper gate')
    const headSha = f.git('rev-parse', 'HEAD')
    exportArchive(f.repo, headSha, staging, f.env)

    // Verified live release has benign stubs, while external referee has strict check that catches violation
    seedGovStubs(liveRel)
    writeFileSync(join(liveRel, '.complete'), JSON.stringify({ sourceCommit: baseSha }))
    symlinkSync(liveRel, liveLink)

    seedGovStubs(extRef, invokedLog)
    writeFileSync(
      join(extRef, 'scripts/check-docs-links.ts'),
      'console.error("REFEREE-CAUGHT-STAGING-TAMPER"); process.exit(1)\n',
    )

    const res = runBash(
      [
        'mlog() { echo "$*" >&2; }',
        'tsum_note() { :; }',
        `source ${q(GOV_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `MASTER_LIVE_LINK=${q(liveLink)}`,
        `OC_V5_REFEREE_ROOT=${q(extRef)}`,
        `MASTER_GATE_TMPDIR=${q(gateTmp)}`,
        `OC_V5_GOVERNANCE_BASE_REF=${q(baseSha)}`,
        `master_run_governance_fast_gates ${q(staging)} ${q(headSha)}`,
      ].join('\n'),
      f.env,
    )
    assert.notEqual(res.status, 0, 'referee must override forged staging script and reject')
    assert.match(res.stderr, /REFEREE-CAUGHT-STAGING-TAMPER/)
    assert.doesNotMatch(res.stdout + res.stderr, /FAKE-STAGING-PASSED/)

    // Now make external referee pass and verify all newly wired flags + first-roll bootstrap of new gates
    writeFileSync(
      join(extRef, 'scripts/check-docs-links.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(invokedLog)}, 'referee:check-docs-links ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n`,
    )
    // Add NEW gates ONLY in candidate staging (not in extRef) -> must bootstrap with [referee-bootstrap]
    writeFileSync(
      join(f.repo, 'scripts/check-a0-monotonic.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(invokedLog)}, 'bootstrap:check-a0-monotonic ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n`,
    )
    writeFileSync(
      join(f.repo, 'scripts/check-ai-smells-ratchet.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(invokedLog)}, 'bootstrap:check-ai-smells ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n`,
    )
    writeFileSync(
      join(f.repo, 'scripts/check-complexity-ratchet.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(invokedLog)}, 'bootstrap:check-complexity ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n`,
    )
    writeFileSync(
      join(f.repo, 'scripts/check-clones-ratchet.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(invokedLog)}, 'bootstrap:check-clones ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n`,
    )
    writeFileSync(
      join(f.repo, 'scripts/check-cross-family-audit.ts'),
      `// supports --enforce-commit\nimport { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(invokedLog)}, 'bootstrap:check-cross-family ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n`,
    )
    writeFileSync(
      join(f.repo, 'scripts/check-debt-ttl.ts'),
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(invokedLog)}, 'bootstrap:check-debt-ttl ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n`,
    )
    f.git('add', '.')
    f.git('commit', '-qm', 'feat(v5): introduce new gates on first roll')
    const rollSha = f.git('rev-parse', 'HEAD')
    exportArchive(f.repo, rollSha, staging, f.env)
    rmSync(invokedLog, { force: true })

    const res2 = runBash(
      [
        'mlog() { echo "$*" >&2; }',
        'tsum_note() { :; }',
        `source ${q(GOV_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `MASTER_LIVE_LINK=${q(liveLink)}`,
        `OC_V5_REFEREE_ROOT=${q(extRef)}`,
        `MASTER_GATE_TMPDIR=${q(gateTmp)}`,
        `OC_V5_GOVERNANCE_BASE_REF=${q(baseSha)}`,
        `master_run_governance_fast_gates ${q(staging)} ${q(rollSha)}`,
      ].join('\n'),
      f.env,
    )
    assert.equal(res2.status, 0, res2.stderr)
    const logText = readFileSync(invokedLog, 'utf8')
    assert.match(logText, /referee:check-docs-links --root/)
    assert.match(logText, /scripts\/check-feature-flags-ttl\.ts .*--fail-on-expired/)
    assert.match(logText, /scripts\/check-context-static\.ts --skip-sub-evals/)
    assert.match(logText, /scripts\/check-file-size-ratchet\.ts --base .* --head /)
    assert.match(logText, /scripts\/check-gate-couplings\.ts --root .* --check/)
    assert.match(logText, /scripts\/check-biome-changed\.sh --base /)
    assert.match(logText, /bootstrap:check-a0-monotonic --base /)
    assert.match(logText, /bootstrap:check-ai-smells --enforce/)
    assert.match(logText, /bootstrap:check-complexity --enforce/)
    assert.match(logText, /bootstrap:check-clones --enforce/)
    assert.match(logText, /bootstrap:check-cross-family --enforce-commit --root .* --base .* --head /)
    assert.match(logText, /bootstrap:check-debt-ttl --enforce/)
    assert.match(res2.stderr, /\[referee-bootstrap\] scripts\/check-a0-monotonic\.ts/)
    assert.match(res2.stderr, /\[referee-bootstrap\] scripts\/check-ai-smells-ratchet\.ts/)

    // Once check-a0-monotonic.ts is synced into extRef, candidate staging tamper is physically ignored
    writeFileSync(
      join(extRef, 'scripts/check-a0-monotonic.ts'),
      'console.error("REFEREE-A0-REJECTED-SELF-LOOSEN"); process.exit(1)\n',
    )
    const res3 = runBash(
      [
        'mlog() { echo "$*" >&2; }',
        'tsum_note() { :; }',
        `source ${q(GOV_LIB)}`,
        `REPO_ROOT=${q(f.repo)}`,
        `MASTER_LIVE_LINK=${q(liveLink)}`,
        `OC_V5_REFEREE_ROOT=${q(extRef)}`,
        `MASTER_GATE_TMPDIR=${q(gateTmp)}`,
        `OC_V5_GOVERNANCE_BASE_REF=${q(baseSha)}`,
        `master_run_governance_fast_gates ${q(staging)} ${q(rollSha)}`,
      ].join('\n'),
      f.env,
    )
    assert.notEqual(res3.status, 0, 'once present in referee, check-a0-monotonic must execute referee copy')
    assert.match(res3.stderr, /REFEREE-A0-REJECTED-SELF-LOOSEN/)
  })

  test('master_referee_prepare_exec_root isolates check-architecture.ts against forged staging', (t) => {
    const sb = makeSandbox(t, 'ocv5-904-archref-')
    const staging = join(sb.dir, 'staging')
    const extRef = join(sb.dir, 'referee')
    const gateTmp = join(sb.dir, 'gate-tmp')
    mkdirSync(join(staging, 'scripts'), { recursive: true })
    mkdirSync(join(extRef, 'scripts'), { recursive: true })
    mkdirSync(gateTmp, { recursive: true })
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(staging, 'node_modules'))

    writeFileSync(join(staging, 'scripts/check-architecture.ts'), 'console.log("STAGING-FAKE-ARCH"); process.exit(0)\n')
    writeFileSync(join(extRef, 'scripts/check-architecture.ts'), 'console.error("REFEREE-REAL-ARCH-FAIL"); process.exit(1)\n')

    const res = runBash(
      [
        'mlog() { echo "$*" >&2; }',
        `source ${q(GOV_LIB)}`,
        `OC_V5_REFEREE_ROOT=${q(extRef)}`,
        `MASTER_LIVE_LINK=${q(join(sb.dir, 'no-live'))}`,
        `MASTER_GATE_TMPDIR=${q(gateTmp)}`,
        `exec_root="$(master_referee_prepare_exec_root ${q(staging)} scripts/check-architecture.ts)"`,
        `cd "$exec_root" && node "$exec_root/node_modules/tsx/dist/cli.mjs" scripts/check-architecture.ts --root ${q(staging)}`,
      ].join('\n'),
      sb.env,
    )
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /REFEREE-REAL-ARCH-FAIL/)
    assert.doesNotMatch(res.stdout, /STAGING-FAKE-ARCH/)
  })
})

describe('2. Declarative Runtime Image Pin & Pre-Dispatch CI Green + Trailer Escape Removal', () => {
  test('loads runtimeImage from deploy/v5/runtime-image-pin.json, falls back when absent, fails closed when corrupt', (t) => {
    const sb = makeSandbox(t, 'ocv5-904-pin-')
    const pinFile = join(sb.dir, 'runtime-image-pin.json')

    // Absent file -> fallback default
    let res = runBash(
      `source ${q(TRAIN_GUARDS_LIB)}; OC_V5_RUNTIME_IMAGE_PIN_FILE=${q(pinFile)}; v5_selfhost_load_runtime_image_pin; printf '%s|%s\n' "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_PIN_SOURCE"`,
      sb.env,
    )
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /^openclaude\/openclaude-runtime:.*\|fallback-default/)

    // Valid pin JSON -> loads exact runtimeImage + previous + cliVersions
    writeFileSync(
      pinFile,
      JSON.stringify({
        schemaVersion: 1,
        channel: 'v5-selfhost',
        runtimeImage: 'openclaude/openclaude-runtime:v5-test-pin-20261126',
        previousRuntimeImage: 'openclaude/openclaude-runtime:v5-prev-pin',
        cliVersions: { claudeCode: '2.1.332', codex: '0.172.0' },
      }),
    )
    res = runBash(
      `source ${q(TRAIN_GUARDS_LIB)}; OC_V5_RUNTIME_IMAGE_PIN_FILE=${q(pinFile)}; v5_selfhost_load_runtime_image_pin; printf '%s|%s|%s\n' "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_PIN_PREVIOUS" "$RUNTIME_IMAGE_PIN_CLI_VERSIONS"`,
      sb.env,
    )
    assert.equal(res.status, 0, res.stderr)
    assert.equal(
      res.stdout.trim(),
      'openclaude/openclaude-runtime:v5-test-pin-20261126|openclaude/openclaude-runtime:v5-prev-pin|{"claudeCode":"2.1.332","codex":"0.172.0"}',
    )

    // Corrupt pin JSON -> fail-closed
    writeFileSync(pinFile, '{"schemaVersion": 99, "runtimeImage": ""}\n')
    res = runBash(
      `source ${q(TRAIN_GUARDS_LIB)}; OC_V5_RUNTIME_IMAGE_PIN_FILE=${q(pinFile)}; v5_selfhost_load_runtime_image_pin`,
      sb.env,
    )
    assert.notEqual(res.status, 0, 'corrupt pin file must fail closed')
  })

  test('v5_selfhost_verify_ci_green enforces completed/success, blocks red/missing/env-bypass, allows --rollback & root break-glass', (t) => {
    const sb = makeSandbox(t, 'ocv5-904-ci-')
    const ctrl = join(sb.dir, 'control')
    const bin = join(sb.dir, 'bin')
    mkdirSync(ctrl, { recursive: true })
    mkdirSync(bin, { recursive: true })
    const sha = 'a'.repeat(40)
    const ghStub = join(bin, 'gh')
    const respFile = join(sb.dir, 'gh-resp.json')
    writeFileSync(ghStub, `#!/usr/bin/env bash\ncat ${q(respFile)}\n`)
    chmodSync(ghStub, 0o755)

    const runCi = (extra = '') =>
      runBash(
        [
          `source ${q(TRAIN_GUARDS_LIB)}`,
          `REPO_ROOT=${q(REPO_ROOT)}`,
          `OC_V5_GH_BIN=${q(ghStub)}`,
          'OC_V5_GH_REPO=dream-star-end/smart-assistant',
          `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
          extra,
          `v5_selfhost_verify_ci_green ${q(sha)}`,
        ].join('\n'),
        sb.env,
      )

    // 1) All required workflows completed/success -> PASS
    writeFileSync(
      respFile,
      JSON.stringify({
        workflow_runs: [
          { id: 1, name: 'V5 selfhost gates', head_sha: sha, status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
          { id: 2, name: 'V5 selfhost release gates', head_sha: sha, status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:01:00Z' },
        ],
      }),
    )
    let r = runCi()
    assert.equal(r.status, 0, r.stderr + r.stdout)

    // 2) Latest run of required workflow failed -> FAIL
    writeFileSync(
      respFile,
      JSON.stringify({
        workflow_runs: [
          { id: 1, name: 'V5 selfhost gates', head_sha: sha, status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
          { id: 3, name: 'V5 selfhost gates', head_sha: sha, status: 'completed', conclusion: 'failure', created_at: '2026-11-26T10:05:00Z' },
          { id: 2, name: 'V5 selfhost release gates', head_sha: sha, status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:01:00Z' },
        ],
      }),
    )
    r = runCi()
    assert.notEqual(r.status, 0, 'failed workflow must reject dispatch')
    assert.match(r.stderr + r.stdout, /V5 selfhost gates: status=completed conclusion=failure/)

    // 3) Missing workflow -> FAIL
    writeFileSync(
      respFile,
      JSON.stringify({
        workflow_runs: [
          { id: 1, name: 'V5 selfhost gates', head_sha: sha, status: 'completed', conclusion: 'success', created_at: '2026-11-26T10:00:00Z' },
        ],
      }),
    )
    r = runCi()
    assert.notEqual(r.status, 0, 'missing required workflow must reject dispatch')
    assert.match(r.stderr + r.stdout, /V5 selfhost release gates: missing/)

    // 4) Env var OC_V5_SKIP_CI_GATE=1 MUST be rejected!
    r = runCi('OC_V5_SKIP_CI_GATE=1')
    assert.notEqual(r.status, 0, 'env bypass must fail closed')

    // 5) --rollback mode (CUTOVER_ROLLBACK=1) exempts CI check
    r = runCi('CUTOVER_ROLLBACK=1')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /--rollback 模式豁免/)

    // 6) Host break-glass file bound to exact SHA exempts (empty or wrong SHA rejected)
    const wrongBg = join(ctrl, `ci-breakglass-${'b'.repeat(40)}`)
    writeFileSync(wrongBg, 'wrong sha reason\n')
    r = runCi()
    assert.notEqual(r.status, 0, 'break-glass for different SHA must not exempt')

    const bg = join(ctrl, `ci-breakglass-${sha}`)
    writeFileSync(bg, '')
    r = runCi()
    assert.notEqual(r.status, 0, 'empty break-glass file must fail closed')

    writeFileSync(bg, 'emergency-hotfix-approved-by-root\n')
    r = runCi()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /break-glass 豁免/)
  })

  test('removes OC_V5_SKIP_TRAILER_GATE=1 env escape hatch while allowing exact-SHA host break-glass file', (t) => {
    const sb = makeSandbox(t, 'ocv5-904-trailer-')
    const ctrl = join(sb.dir, 'control')
    mkdirSync(ctrl, { recursive: true })
    const sha = 'c'.repeat(40)
    const deploySrc = readFileSync(DEPLOY_SCRIPT, 'utf8')
    const fnMatch = deploySrc.match(/^assert_fix_trailers\(\) \{[\s\S]*?^\}/m)
    assert.ok(fnMatch, 'assert_fix_trailers must exist in deploy-v5-selfhost.sh')

    const fakeGate = join(sb.dir, 'fake-trailer-gate.sh')
    writeFileSync(fakeGate, '#!/usr/bin/env bash\necho "TRAILER-GATE-FAILED" >&2\nexit 1\n')
    chmodSync(fakeGate, 0o755)

    // 1) Setting OC_V5_SKIP_TRAILER_GATE=1 MUST fail loudly (never bypass!)
    let r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        'log() { echo "$*"; }',
        'die() { echo "✗ $*" >&2; exit 1; }',
        `REPO_ROOT=${q(REPO_ROOT)}`,
        `FIX_TRAILER_GATE=${q(fakeGate)}`,
        `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
        fnMatch[0],
        `OC_V5_SKIP_TRAILER_GATE=1 assert_fix_trailers ${q(sha)}`,
      ].join('\n'),
      sb.env,
    )
    assert.notEqual(r.status, 0, 'OC_V5_SKIP_TRAILER_GATE=1 must be physically rejected')
    assert.match(r.stderr, /OC_V5_SKIP_TRAILER_GATE=1 环境变量逃生口已物理移除/)

    // 2) Without break-glass file, real gate runs and blocks
    r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        'log() { echo "$*"; }',
        'die() { echo "✗ $*" >&2; exit 1; }',
        `REPO_ROOT=${q(REPO_ROOT)}`,
        `FIX_TRAILER_GATE=${q(fakeGate)}`,
        `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
        fnMatch[0],
        `assert_fix_trailers ${q(sha)}`,
      ].join('\n'),
      sb.env,
    )
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /TRAILER-GATE-FAILED/)

    // 3) Valid exact-SHA host break-glass file exempts
    writeFileSync(join(ctrl, `trailer-breakglass-${sha}`), 'p0-outage-root-override\n')
    r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        'log() { echo "$*"; }',
        'die() { echo "✗ $*" >&2; exit 1; }',
        `REPO_ROOT=${q(REPO_ROOT)}`,
        `FIX_TRAILER_GATE=${q(fakeGate)}`,
        `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
        fnMatch[0],
        `assert_fix_trailers ${q(sha)}`,
      ].join('\n'),
      sb.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /trailer-gate.*break-glass/)
  })
})

describe('3. Host Governor Mode Gate (emergency_stop & debt_first)', () => {
  test('emergency_stop rejects all deploys; debt_first blocks feat(v5): and allows refactor/bug/chore', (t) => {
    const f = makeTempGitRepo(t)
    const modeFile = join(f.dir, 'mode.json')

    writeFileSync(join(f.repo, 'a.txt'), '1\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'chore(v5): init base')
    const baseSha = f.git('rev-parse', 'HEAD')

    writeFileSync(join(f.repo, 'a.txt'), '2\n')
    f.git('commit', '-qam', 'refactor(v5): extract clean helper')
    const refactorSha = f.git('rev-parse', 'HEAD')

    writeFileSync(join(f.repo, 'a.txt'), '3\n')
    f.git('commit', '-qam', 'feat(v5): add brand new feature')
    const featSha = f.git('rev-parse', 'HEAD')

    const checkMode = (sha: string, base: string) =>
      runBash(
        [
          `source ${q(TRAIN_GUARDS_LIB)}`,
          `REPO_ROOT=${q(f.repo)}`,
          `OC_V5_GOVERNOR_MODE_FILE=${q(modeFile)}`,
          `v5_selfhost_check_governor_mode ${q(sha)} ${q(base)}`,
        ].join('\n'),
        f.env,
      )

    // emergency_stop blocks even refactor
    writeFileSync(modeFile, JSON.stringify({ mode: 'emergency_stop', reason: 'sev1 freeze' }))
    let r = checkMode(refactorSha, baseSha)
    assert.notEqual(r.status, 0, 'emergency_stop must block deploy')
    assert.match(r.stderr, /emergency_stop.*sev1 freeze/)

    // debt_first blocks feat(v5):
    writeFileSync(modeFile, JSON.stringify({ mode: 'debt_first', reason: 'rework > 40%' }))
    r = checkMode(featSha, baseSha)
    assert.notEqual(r.status, 0, 'debt_first must block feat(v5):')
    assert.match(r.stderr, /debt_first/)
    assert.match(r.stderr, /feat\(v5\): add brand new feature/)

    // debt_first allows refactor(v5):
    r = checkMode(refactorSha, baseSha)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /debt_first 校验通过/)

    // autonomous allows feat(v5):
    writeFileSync(modeFile, JSON.stringify({ mode: 'autonomous', reason: 'healthy' }))
    r = checkMode(featSha, baseSha)
    assert.equal(r.status, 0, r.stderr)
  })
})

describe('4. Post-Cutover Retention Gate + Auto-Rollback + Breaker Trip', () => {
  test('triggers official auto-rollback and notifies oc-governor breaker when retention runner fails', async (t) => {
    const sb = makeSandbox(t, 'ocv5-904-ret-')
    const ctrl = join(sb.dir, 'control')
    const bin = join(sb.dir, 'bin')
    mkdirSync(ctrl, { recursive: true })
    mkdirSync(bin, { recursive: true })

    // Local loopback /healthz 200 server
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const addr = server.address() as { port: number }
    const healthzUrl = `http://127.0.0.1:${addr.port}/healthz`

    const rollbackLog = join(sb.dir, 'rollback.log')
    const breakerLog = join(sb.dir, 'breaker.log')
    const trainFinishLog = join(sb.dir, 'train-finish.log')
    const retentionRunner = join(bin, 'run-retention.sh')
    const govBin = join(bin, 'oc-governor')
    const sha = 'd'.repeat(40)

    // Mock oc-governor supporting record-rollback (verifies trip-breaker -> record-rollback fallback too)
    writeFileSync(
      govBin,
      [
        '#!/usr/bin/env bash',
        `if [[ "$1" == "trip-breaker" && "\${MOCK_NO_TRIP_ALIAS:-0}" == 1 ]]; then exit 2; fi`,
        `echo "$*" >> ${q(breakerLog)}`,
        'exit 0',
      ].join('\n'),
    )
    chmodSync(govBin, 0o755)

    // Case A: Retention PASS -> exit 0, no rollback, no breaker call
    writeFileSync(retentionRunner, '#!/usr/bin/env bash\necho "retention 6/6 PASS"\nexit 0\n')
    chmodSync(retentionRunner, 0o755)
    let r = await runBashAsync(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
        `OC_V5_GOVERNOR_BIN=${q(govBin)}`,
        `OC_V5_RETENTION_RUNNER=${q(retentionRunner)}`,
        'OC_V5_RETENTION_SETTLE_SEC=0',
        `OC_V5_RETENTION_HEALTHZ_URL=${q(healthzUrl)}`,
        `OC_V5_RETENTION_ROLLBACK_CMD=${q(`echo "RB:$1:$2:$3" >> ${q(rollbackLog)}`)}`,
        'LEASE_TRAIN_ID=tr-test-pass',
        `v5_selfhost_post_cutover_retention_gate /opt/rel-new ${q(sha)}`,
      ].join('\n'),
      sb.env,
    )
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.equal(existsSync(rollbackLog), false)
    assert.equal(existsSync(breakerLog), false)

    // Case B: Retention FAIL -> marks train failed, triggers official rollback, notifies oc-governor breaker, exits non-zero
    writeFileSync(retentionRunner, '#!/usr/bin/env bash\necho "retention FAIL 02-min-chat-loop" >&2\nexit 1\n')
    chmodSync(retentionRunner, 0o755)
    r = await runBashAsync(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `lease_train_finish() { echo "$1|$2" >> ${q(trainFinishLog)}; }`,
        `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
        `OC_V5_GOVERNOR_BIN=${q(govBin)}`,
        `OC_V5_RETENTION_RUNNER=${q(retentionRunner)}`,
        'OC_V5_RETENTION_SETTLE_SEC=0',
        `OC_V5_RETENTION_HEALTHZ_URL=${q(healthzUrl)}`,
        `OC_V5_RETENTION_ROLLBACK_CMD=${q(`echo "RB:$1:$2:$3" >> ${q(rollbackLog)}`)}`,
        'LEASE_TRAIN_ID=tr-test-fail',
        `v5_selfhost_post_cutover_retention_gate /opt/rel-bad ${q(sha)}`,
      ].join('\n'),
      sb.env,
    )
    assert.notEqual(r.status, 0, 'retention failure must exit non-zero after auto-rollback')
    assert.match(readFileSync(trainFinishLog, 'utf8'), /^failed\|post-cutover retention gate failed/)
    assert.match(readFileSync(rollbackLog, 'utf8'), new RegExp(`RB:/opt/rel-bad:${sha}:1`))
    assert.match(readFileSync(breakerLog, 'utf8'), /trip-breaker --train tr-test-fail/)
    assert.equal(existsSync(join(ctrl, 'retention-rollbacks.jsonl')), true)

    // Case C: Verify fallback to `oc-governor record-rollback` when `trip-breaker` is absent
    rmSync(breakerLog, { force: true })
    r = runBash(
      [
        `source ${q(TRAIN_GUARDS_LIB)}`,
        `OC_V5_GOVERNOR_CONTROL_DIR=${q(ctrl)}`,
        `OC_V5_GOVERNOR_BIN=${q(govBin)}`,
        'export MOCK_NO_TRIP_ALIAS=1',
        'v5_selfhost_notify_governor_breaker tr-test-fallback retention-failed',
      ].join('\n'),
      sb.env,
    )
    assert.equal(r.status, 0, r.stderr)
    assert.match(readFileSync(breakerLog, 'utf8'), /record-rollback --train tr-test-fallback/)
  })
})

describe('5. 45s Train Debounce, Governor emergency_stop Pause & Planned Auto Fast-Forward', () => {
  test('coalesces burst pushes within 45s debounce window, respects emergency_stop, and fast-forwards planned train to newest CI-green SHA', (t) => {
    const sb = makeSandbox(t, 'ocv5-904-worker-')
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
    const fakeDeploy = join(bin, 'fake-deploy.sh')
    const fakeTask = join(bin, 'fake-oc-task')
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
      g(cwd, 'commit', '-qm', `chore(v5): ${name}`)
      return g(cwd, 'rev-parse', 'HEAD')
    }
    const c0 = mk(wt, 'c0')
    const c1 = mk(wt, 'c1')
    const c2 = mk(wt, 'c2')
    g(wt, 'remote', 'add', 'origin', origin)
    g(wt, 'push', '-q', 'origin', 'feat/v5-selfhost')

    // Live at c0
    const rel0 = join(releases, `rel-${c0}`)
    mkdirSync(rel0, { recursive: true })
    writeFileSync(join(rel0, '.complete'), JSON.stringify({ sourceCommit: c0 }))
    symlinkSync(rel0, join(sb.dir, 'live'))
    writeFileSync(join(runDir, 'survivor.state'), JSON.stringify({ phase: 'committed' }))
    writeFileSync(join(runDir, 'survivor.committed'), '')

    writeFileSync(fakeDeploy, `#!/usr/bin/env bash\necho "$*" >> ${q(startsLog)}\nexit 0\n`)
    chmodSync(fakeDeploy, 0o755)
    writeFileSync(fakeTask, '#!/usr/bin/env bash\necho "{}"\nexit 0\n')
    chmodSync(fakeTask, 0o755)

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
      OC_USER_ID: '3',
      INVOCATION_ID: '',
    }

    // Register ride 1 (c1) & ride 2 (c2)
    let r = spawnSync('bash', [LEASE_CLI, 'register', '--resource', 'deploy:selfhost', '--mode', 'ride', '--sha', c1, '--owner', 'a1', '--callback', 'none'], { env: workerEnv, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    r = spawnSync('bash', [LEASE_CLI, 'register', '--resource', 'deploy:selfhost', '--mode', 'ride', '--sha', c2, '--owner', 'a2', '--callback', 'none'], { env: workerEnv, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)

    const minEpoch = Number(
      execFileSync('sqlite3', ['-noheader', db, "SELECT CAST(strftime('%s', MIN(created_at)) AS INTEGER) FROM lease;"], { encoding: 'utf8' }).trim(),
    )

    const runWorkerTick = (nowEpoch: number) =>
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
        { env: { ...workerEnv, OC_V5_NOW_EPOCH: String(nowEpoch) }, encoding: 'utf8', timeout: 60_000 },
      )

    // Tick at +15s (< 45s debounce window): MUST NOT dispatch!
    r = runWorkerTick(minEpoch + 15)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /合流防抖窗口中/)
    assert.equal(existsSync(startsLog), false, 'must not spawn deploy before 45s debounce elapses')

    // Tick at +46s (>= 45s), BUT governor mode is emergency_stop: MUST pause with clear reason!
    writeFileSync(modeFile, JSON.stringify({ mode: 'emergency_stop', reason: 'operator-halt' }))
    r = runWorkerTick(minEpoch + 46)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /emergency_stop.*operator-halt/)
    assert.equal(existsSync(startsLog), false, 'emergency_stop must block worker dispatch')

    // Lift emergency_stop to autonomous and tick at +46s -> coalesced single train launches targeting c2!
    writeFileSync(modeFile, JSON.stringify({ mode: 'autonomous', reason: 'resumed' }))
    r = runWorkerTick(minEpoch + 46)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /合流防抖窗口已满/)
    const lines = readFileSync(startsLog, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, 'both rides must coalesce into 1 single train')
    assert.match(lines[0]!, new RegExp(`--target-sha=${c2}`))

    // Now test planned-phase auto fast-forward to latest pushed CI-green SHA (skipping ungreen tip):
    // Clone pushWt, push c3 (CI green) and c4 (CI NOT green) to origin while wt stays at c2.
    execFileSync('git', ['clone', '-q', '-b', 'feat/v5-selfhost', origin, pushWt], { env: sb.env })
    g(pushWt, 'config', 'user.name', 'worker-test')
    g(pushWt, 'config', 'user.email', 'worker-test@example.invalid')
    const c3 = mk(pushWt, 'c3-green')
    const c4 = mk(pushWt, 'c4-red')
    g(pushWt, 'push', '-q', 'origin', 'feat/v5-selfhost')

    // Seed a clean planned train at c2 plus an extra ride wanting c3
    const trainId = 'tr-20261126T120000Z-abcdef123456'
    execFileSync(
      'sqlite3',
      [
        db,
        `DELETE FROM train;
         INSERT INTO train(id,resource,target_sha,status,owner,created_at,updated_at)
           VALUES('${trainId}','deploy:selfhost','${c2}','planned','worker:test','2026-11-26T12:00:00Z','2026-11-26T12:00:00Z');
         INSERT INTO lease(id,resource,mode,status,owner,owner_uid,want_sha,created_at,updated_at)
           VALUES('ls-20261126T120001Z-111111111111','deploy:selfhost','ride','registered','a3','3','${c3}','2026-11-26T12:00:01Z','2026-11-26T12:00:01Z');`,
      ],
    )

    // Invoke worker_planned_fast_forward_green_tip where only c3 is CI-green (c4 is red/pending)
    const ffRes = runBash(
      [
        `source ${q(LEASE_LIB)}`,
        `source ${q(DEBOUNCE_LIB)}`,
        'RESOURCE=deploy:selfhost; ACTOR=worker:test',
        'wlog() { echo "$*"; }',
        // Extract real canonical_fast_forward from v5-lease-worker.sh
        readFileSync(LEASE_WORKER, 'utf8').match(/^canonical_fast_forward\(\) \{[\s\S]*?^\}/m)![0],
        `tip=${q(c2)}`,
        `worker_planned_fast_forward_green_tip ${q(trainId)} tip`,
        'echo "FINAL_TIP=$tip"',
      ].join('\n'),
      {
        ...workerEnv,
        OC_V5_WORKER_CI_CHECK_CMD: `[[ "$1" == "${c3}" ]]`,
      },
    )
    assert.equal(ffRes.status, 0, ffRes.stderr + ffRes.stdout)
    assert.match(ffRes.stdout, new RegExp(`FINAL_TIP=${c3}`), 'must fast-forward to newest CI-green c3 and skip red c4')
    assert.match(ffRes.stdout, /planned 自动快进.*合并覆盖祖先 rides=3/)
    assert.equal(g(wt, 'rev-parse', 'HEAD'), c3, 'canonical worktree HEAD must fast-forward to c3')
    const dbTarget = execFileSync('sqlite3', ['-noheader', db, `SELECT target_sha FROM train WHERE id='${trainId}';`], { encoding: 'utf8' }).trim()
    assert.equal(dbTarget, c3, 'train.target_sha in lease.db must update to c3')
    const evCount = execFileSync('sqlite3', ['-noheader', db, `SELECT COUNT(*) FROM event WHERE subject_id='${trainId}' AND event='train-fast-forward';`], { encoding: 'utf8' }).trim()
    assert.equal(evCount, '1', 'train-fast-forward event must be recorded')
  })
})

describe('6. Static wiring & syntax integrity across all modified scripts', () => {
  test('all modified bash scripts pass bash -n and deploy/master-lib keep required wiring', () => {
    for (const rel of [
      'scripts/deploy-v5-selfhost.sh',
      'scripts/lib/v5-selfhost-governance-gates.sh',
      'scripts/lib/v5-selfhost-train-guards.sh',
      'scripts/v5-selfhost-master-release-lib.sh',
      'scripts/v5-lease-worker.sh',
      'scripts/lib/v5-lease-train-debounce.sh',
    ]) {
      const r = spawnSync('bash', ['-n', join(REPO_ROOT, rel)], { encoding: 'utf8' })
      assert.equal(r.status, 0, `bash -n failed for ${rel}: ${r.stderr}`)
    }
    const deploySrc = readFileSync(DEPLOY_SCRIPT, 'utf8')
    assert.match(deploySrc, /source "\$SCRIPT_DIR\/lib\/v5-selfhost-train-guards\.sh"/)
    assert.match(deploySrc, /v5_selfhost_load_runtime_image_pin/)
    assert.match(deploySrc, /v5_selfhost_check_governor_mode "\$sha"/)
    assert.match(deploySrc, /v5_selfhost_verify_ci_green "\$sha"/)
    assert.match(deploySrc, /v5_selfhost_post_cutover_retention_gate "\$DEPLOY_BUILT_RELEASE" "\$sha"/)
    assert.match(deploySrc, /^FIX_TRAILER_GATE="\$SCRIPT_DIR\/check-v5-fix-trailers\.sh"$/m)

    const masterSrc = readFileSync(MASTER_LIB, 'utf8')
    assert.match(masterSrc, /master_referee_prepare_exec_root "\$staging" scripts\/check-architecture\.ts/)
  })
})
