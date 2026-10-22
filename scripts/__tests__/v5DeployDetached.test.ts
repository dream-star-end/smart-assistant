import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runner = path.join(root, 'scripts/v5-deploy-detached.sh')

function fakeTools(): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-deploy-detached-'))
  const bin = path.join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])

  const scripts: Record<string, string> = {
    git: `#!/usr/bin/env bash
case "$*" in
  *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' "\${FAKE_BRANCH:-feat/v5-aurora-rewrite}" ;;
  *"status --porcelain"*) printf '%s' "\${FAKE_DIRTY:-}" ;;
  *"rev-parse --short=8 HEAD"*) printf '%s\\n' deadbeef ;;
  *) exit 2 ;;
esac
`,
    systemctl: `#!/usr/bin/env bash
if [[ "$*" == *"list-units"* ]]; then
  [[ "\${FAKE_ACTIVE:-0}" == 1 ]] && printf '%s\\n' 'openclaude-v5-deploy-existing.service loaded active running test'
  exit 0
fi
if [[ "$*" == *"--property=LoadState --value"* ]]; then printf '%s\\n' "\${FAKE_LOAD_STATE:-loaded}"; exit 0; fi
if [[ "$*" == *"--property=ActiveState --value"* ]]; then
  if [[ -n "\${FAKE_STATE_FILE:-}" ]]; then
    count="$(cat "$FAKE_STATE_FILE")"
    count="$((count + 1))"
    printf '%s' "$count" >"$FAKE_STATE_FILE"
    printf '%s\\n' active
  else
    printf '%s\\n' "\${FAKE_STATE:-inactive}"
  fi
  exit 0
fi
if [[ "$*" == *"--property=SubState --value"* ]]; then
  if [[ -n "\${FAKE_STATE_FILE:-}" ]] && (( $(cat "$FAKE_STATE_FILE") > 1 )); then
    printf '%s\\n' exited
  else
    printf '%s\\n' "\${FAKE_SUBSTATE:-running}"
  fi
  exit 0
fi
if [[ "$*" == *"--property=ExecMainStatus --value"* ]]; then printf '%s\\n' "\${FAKE_STATUS:-0}"; exit 0; fi
if [[ "$1" == stop ]]; then printf '%s\\n' "$*" >>"\${FAKE_SYSTEMCTL_LOG:-/dev/null}"; exit 0; fi
printf '%s\\n' 'LoadState=loaded' "ActiveState=\${FAKE_STATE:-inactive}" "ExecMainStatus=\${FAKE_STATUS:-0}"
`,
    'systemd-run': `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$FAKE_LOG"
`,
    journalctl: `#!/usr/bin/env bash
printf '%s\\n' 'journal-ok'
`,
  }
  for (const [name, body] of Object.entries(scripts)) {
    const target = path.join(bin, name)
    writeFileSync(target, body)
    chmodSync(target, 0o755)
  }
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('start launches exact deploy arguments in a production-shaped transient unit', () => {
  const fake = fakeTools()
  const log = path.join(path.dirname(fake.bin), 'systemd-run.args')
  try {
    const result = spawnSync(runner, ['start', '--', '--canary', '--egress'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fake.bin}:${process.env.PATH}`,
        FAKE_LOG: log,
        OC_V5_RELEASE_QUEUE_ID: 'rq-20260807T000000Z-abcdef123456',
        KL_HOST: 'kl-test',
        OC_V5_PROOF_TEST_DATABASE_URL: 'postgres://fixture@127.0.0.1:55432/detached_test',
        // 本用例只钉 unit 形状;预检由下方专门用例覆盖。
        OC_V5_DETACHED_SKIP_PREFLIGHT: '1',
      },
    })
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      }),
    )
    assert.match(
      result.stdout.trim(),
      /^openclaude-v5-deploy-[0-9]{8}-[0-9]{6}-deadbeef-canary\.service$/,
    )

    const args = readFileSync(log, 'utf8').trim().split('\n')
    assert.ok(args.includes('--property=Type=exec'))
    assert.ok(args.includes('--property=KillMode=control-group'))
    assert.ok(args.includes('--property=RemainAfterExit=yes'))
    assert.ok(args.includes(`--property=WorkingDirectory=${root}`))
    assert.ok(args.includes('--setenv=HOME=/root'))
    assert.ok(args.includes('--setenv=XDG_CONFIG_HOME=/root/.config'))
    assert.ok(args.includes('--setenv=XDG_CACHE_HOME=/root/.cache'))
    assert.ok(args.includes('--setenv=GH_CONFIG_DIR=/root/.config/gh'))
    assert.ok(args.includes('--setenv=OC_V5_RELEASE_QUEUE_ID=rq-20260807T000000Z-abcdef123456'))
    assert.ok(args.includes('--setenv=KL_HOST=kl-test'))
    // build_release 的 Box 事故证明门只认显式测试库;transient unit 不继承调用方环境。
    assert.ok(
      args.includes(
        '--setenv=OC_V5_PROOF_TEST_DATABASE_URL=postgres://fixture@127.0.0.1:55432/detached_test',
      ),
    )
    assert.deepEqual(args.slice(-4), [
      '/usr/bin/bash',
      path.join(root, 'scripts/deploy-v5.sh'),
      '--canary',
      '--egress',
    ])
  } finally {
    fake.cleanup()
  }
})

test('start refuses a non-canonical branch, dirty tree, or active detached runner', () => {
  const fake = fakeTools()
  try {
    const common = {
      ...process.env,
      PATH: `${fake.bin}:${process.env.PATH}`,
      FAKE_LOG: path.join(tmpdir(), 'unused'),
    }
    const branch = spawnSync(runner, ['start', '--', '--canary'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...common, FAKE_BRANCH: 'fix/not-canonical' },
    })
    assert.equal(branch.status, 2)
    assert.match(branch.stderr, /只允许从 V5 canonical/)

    const dirty = spawnSync(runner, ['start', '--', '--canary'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...common, FAKE_DIRTY: ' M CLAUDE.md' },
    })
    assert.equal(dirty.status, 2)
    assert.match(dirty.stderr, /canonical 非 clean/)

    const active = spawnSync(runner, ['start', '--', '--canary'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...common, FAKE_ACTIVE: '1' },
    })
    assert.equal(active.status, 2)
    assert.match(active.stderr, /已有 detached V5 deploy unit/)
  } finally {
    fake.cleanup()
  }
})

test('wait returns the official deploy process exit status', () => {
  const fake = fakeTools()
  try {
    const result = spawnSync(
      runner,
      ['wait', 'openclaude-v5-deploy-20260807-000000-deadbeef-canary.service'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_STATUS: '7' },
      },
    )
    assert.equal(result.status, 7, result.stderr)
    assert.match(result.stdout, /ExecMainStatus=7/)
    assert.match(result.stdout, /journal-ok/)
  } finally {
    fake.cleanup()
  }
})

test('wait preserves and returns a successful result after running becomes exited', () => {
  const fake = fakeTools()
  const stateFile = path.join(path.dirname(fake.bin), 'state-count')
  const systemctlLog = path.join(path.dirname(fake.bin), 'systemctl.log')
  const unit = 'openclaude-v5-deploy-20260807-000000-deadbeef-canary.service'
  writeFileSync(stateFile, '0')
  try {
    const result = spawnSync(runner, ['wait', unit], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fake.bin}:${process.env.PATH}`,
        FAKE_STATE_FILE: stateFile,
        FAKE_SYSTEMCTL_LOG: systemctlLog,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(Number(readFileSync(stateFile, 'utf8')) >= 2)
    assert.match(readFileSync(systemctlLog, 'utf8'), new RegExp(`^stop ${unit}$`, 'm'))
  } finally {
    fake.cleanup()
  }
})

test('wrapper intentionally exposes no stop or arbitrary-unit control', () => {
  const stop = spawnSync(runner, ['stop', 'openclaude-v5.service'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(stop.status, 2)
  assert.match(stop.stderr, /There is intentionally no stop\/kill command/)

  const invalid = spawnSync(runner, ['status', 'openclaude-v5.service'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /非法 V5 deploy unit/)
})

test('status and wait reject a valid-looking unit that systemd does not know', () => {
  const fake = fakeTools()
  const unit = 'openclaude-v5-deploy-20260807-000000-deadbeef-canary.service'
  try {
    for (const command of ['status', 'wait']) {
      const result = spawnSync(runner, [command, unit], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fake.bin}:${process.env.PATH}`,
          FAKE_LOAD_STATE: 'not-found',
        },
      })
      assert.equal(result.status, 2, `${command}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, /找不到 detached deploy unit/)
    }
  } finally {
    fake.cleanup()
  }
})

// ── 发车前只读预检(v5-deploy-preflight.sh)──
// 2026-10-04..07:30 次 detached 发车 6 次失败,4 次是几秒可判的确定性错误(漏证明门 DSN ×2、
// 漏 --egress ×1、队列项未 active ×1),却要等 unit 跑 20s–7min 才报。预检把它们提前到建 unit 之前。

const preflight = path.join(root, 'scripts/v5-deploy-preflight.sh')

function git(args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

// 假 ssh:只回答 deploy-v5.sh egress surface gate 的两次只读查询(egress 进程 cwd、release sourceCommit),
// 以及 OCV5-581 L0 的三类只读查询:deploy_state 快照(psql)、serving release(readlink)、
// baseline 结构复验(把本 checkout 的 guard 脚本在本机对 fixture release 真跑一遍)。
// OCV5-391:egress 进程 cwd 经 scripts/v5-egress-slots.sh active 读取(legacy 或双槽之一)。
const BASELINE_REL = 'packages/commercial/agent-sandbox/ccb-baseline'
function preflightFixture(egressSha: string): {
  env: NodeJS.ProcessEnv
  queue: (args: string[]) => ReturnType<typeof spawnSync>
  serving: string
  previous: string
  bin: string
  cleanup: () => void
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-deploy-preflight-'))
  const bin = path.join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  // serving / 回退目标 release:本 checkout 的 baseline 原样复制,结构必兼容。
  const serving = path.join(dir, 'releases', 'rel-serving')
  const previous = path.join(dir, 'releases', 'rel-previous')
  for (const rel of [serving, previous]) {
    mkdirSync(path.join(rel, path.dirname(BASELINE_REL)), { recursive: true })
    cpSync(path.join(root, BASELINE_REL), path.join(rel, BASELINE_REL), { recursive: true })
  }
  writeFileSync(
    path.join(bin, 'ssh'),
    `#!/usr/bin/env bash
case "$*" in
  *"bash -s -- active"*) printf '%s\\n' 'openclaude-v5-egress@A.service 4242 /opt/openclaude/openclaude-v5-releases/rel-egress-fixture' ;;
  *sourceCommit*) printf '%s\\n' "$FAKE_EGRESS_SHA" ;;
  *psql*) cat >/dev/null; [[ "\${FAKE_DS_FAIL:-0}" == 1 ]] && exit 2
          printf '%s\\n' "7|stable|A||$FAKE_SERVING||A|A|0||0||5|$FAKE_PREVIOUS" ;;
  *"readlink -f"*) printf '%s\\n' "$FAKE_SERVING" ;;
  *"bash -s -- check-structure-release"*) shift; eval "$*" ;;
  *) exit 97 ;;
esac
`,
  )
  chmodSync(path.join(bin, 'ssh'), 0o755)
  // 本机没有 Postgres 的用例:探针换成只回结论的假探针(真探针的判定在 proofDbPreflight.test.mjs)。
  writeFileSync(path.join(bin, 'fake-proof-probe.mjs'),
    `process.stdout.write(process.env.FAKE_PROBE_LINE ?? "ok\\tfake probe\\n"); process.exit(process.env.FAKE_PROBE_LINE?.startsWith("fail") ? 1 : 0)\n`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ALLOW_ANY_BRANCH: '1',
    KL_HOST: 'kl-preflight-fixture',
    // 默认关掉 nightly 提示,别让用例去打真 GitHub;专门的用例用假 gh 打开。
    OC_V5_PREFLIGHT_NIGHTLY: '0',
    FAKE_EGRESS_SHA: egressSha,
    FAKE_SERVING: serving,
    FAKE_PREVIOUS: previous,
    OC_V5_PREFLIGHT_PROOF_PROBE: path.join(bin, 'fake-proof-probe.mjs'),
    OC_V5_RELEASE_QUEUE_DB: path.join(dir, 'queue.db'),
    OC_V5_RELEASE_QUEUE_LOCK: path.join(dir, 'queue.lock'),
    OC_V5_RELEASE_QUEUE_REPO_ROOT: root,
    OC_V5_RELEASE_QUEUE_RUN_DIR: path.join(dir, 'run'),
  }
  delete env.OC_V5_RELEASE_QUEUE_ID
  delete env.OC_V5_PROOF_TEST_DATABASE_URL
  delete env.OC_V5_DETACHED_SKIP_PREFLIGHT
  const queue = (args: string[]) =>
    spawnSync(path.join(root, 'scripts/v5-release-queue.sh'), args, { cwd: root, encoding: 'utf8', env })
  return { env, queue, serving, previous, bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function activePinnedQueue(fx: ReturnType<typeof preflightFixture>, sha: string): string {
  const submit = fx.queue(['submit', '--task', 'preflight', '--branch', 'feat/x', '--sha', sha, '--actor', 'preflight-test'])
  assert.equal(submit.status, 0, String(submit.stderr) + String(submit.stdout))
  const id = String(submit.stdout).trim()
  const acquire = fx.queue(['acquire', '--id', id, '--owner', 'preflight-test'])
  assert.equal(acquire.status, 0, String(acquire.stderr) + String(acquire.stdout))
  const pin = fx.queue(['pin', '--id', id, '--sha', sha, '--actor', 'preflight-test'])
  assert.equal(pin.status, 0, String(pin.stderr) + String(pin.stdout))
  return id
}

function runPreflight(env: NodeJS.ProcessEnv, args: string[]) {
  // 外层上限:回归时让用例确定性失败(ETIMEDOUT),而不是把测试进程挂住。
  return spawnSync(preflight, ['--', ...args], { cwd: root, encoding: 'utf8', env, timeout: 60_000 })
}

test('preflight passes a ready release and writes nothing to stdout', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const id = activePinnedQueue(fx, head)
    const result = runPreflight(
      { ...fx.env, OC_V5_RELEASE_QUEUE_ID: id, OC_V5_PROOF_TEST_DATABASE_URL: 'postgres://t@127.0.0.1:55432/x_test' },
      ['--with-dist'],
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /发车预检通过\(MODE=deploy egress=0\)/)
  } finally {
    fx.cleanup()
  }
})

test('preflight refuses a missing queue item and a missing proof DSN before any unit exists', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const result = runPreflight(fx.env, ['--with-dist'])
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /发布队列未就绪\(MODE=deploy\)/)
    assert.match(result.stderr, /未设置 OC_V5_PROOF_TEST_DATABASE_URL/)
    assert.match(result.stderr, /未创建 detached unit/)
  } finally {
    fx.cleanup()
  }
})

test('preflight refuses a queued-but-not-active item', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const submit = fx.queue(['submit', '--task', 'preflight', '--branch', 'feat/x', '--sha', head, '--actor', 'preflight-test'])
    assert.equal(submit.status, 0, String(submit.stderr))
    const result = runPreflight(
      { ...fx.env, OC_V5_RELEASE_QUEUE_ID: String(submit.stdout).trim(), OC_V5_PROOF_TEST_DATABASE_URL: 'postgres://t@127.0.0.1:55432/x_test' },
      ['--with-dist', '--egress'],
    )
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /不是 active/)
  } finally {
    fx.cleanup()
  }
})

test('preflight runs the real egress surface gate: egress-surface diff without --egress is refused', () => {
  const head = git(['rev-parse', 'HEAD'])
  // 最近一次改动 egress 面的提交的父提交:从它到 HEAD 一定有 egress 面 diff。
  const lastEgressChange = git(['log', '-1', '--format=%H', 'HEAD', '--', 'packages/commercial/src/egress'])
  const egressSha = git(['rev-parse', `${lastEgressChange}^`])
  const fx = preflightFixture(egressSha)
  try {
    const id = activePinnedQueue(fx, head)
    const env = { ...fx.env, OC_V5_RELEASE_QUEUE_ID: id, OC_V5_PROOF_TEST_DATABASE_URL: 'postgres://t@127.0.0.1:55432/x_test' }
    const refused = runPreflight(env, ['--with-dist'])
    assert.equal(refused.status, 2, refused.stderr)
    assert.match(refused.stderr, /却未带 --egress/)
    assert.match(refused.stderr, /packages\/commercial\/src\/egress/)

    const withEgress = runPreflight(env, ['--with-dist', '--egress'])
    assert.equal(withEgress.status, 0, withEgress.stderr)
  } finally {
    fx.cleanup()
  }
})

test('preflight skips dry-run and does not demand a proof DSN for recovery lanes or canary reuse', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const dry = runPreflight(fx.env, ['--dry-run', '--with-dist'])
    assert.equal(dry.status, 0, dry.stderr)
    const rollback = runPreflight(fx.env, ['--rollback'])
    assert.equal(rollback.status, 0, rollback.stderr)
    const id = activePinnedQueue(fx, head)
    const reuse = runPreflight({ ...fx.env, OC_V5_RELEASE_QUEUE_ID: id }, ['--canary=rel-existing'])
    assert.equal(reuse.status, 0, reuse.stderr)
  } finally {
    fx.cleanup()
  }
})

// ── OCV5-581 L0:2026-10-22 seq365 的三个面在建 unit 之前拒绝 ──
function readyRun(fx: ReturnType<typeof preflightFixture>, sha: string, extra: NodeJS.ProcessEnv = {}, args = ['--with-dist']) {
  const id = activePinnedQueue(fx, sha)
  return runPreflight({ ...fx.env, OC_V5_RELEASE_QUEUE_ID: id,
    OC_V5_PROOF_TEST_DATABASE_URL: 'postgres://t@127.0.0.1:55432/x_test', ...extra }, args)
}

test('L0 green: pin, links, proof probe and both baselines are reported and pass', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const r = readyRun(fx, head)
    assert.equal(r.status, 0, r.stderr)
    for (const check of ['source-pin', 'workspace-links', 'proof-db', 'baseline', 'baseline-rollback']) {
      assert.match(r.stderr, new RegExp(`✓ preflight ${check}:`), check)
    }
  } finally {
    fx.cleanup()
  }
})

test('L0 refuses a serving release whose baseline structure this checkout rejects (seq365 attempt 3)', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    mkdirSync(path.join(fx.serving, BASELINE_REL, 'skills', 'zz-retired-elsewhere'))
    writeFileSync(path.join(fx.serving, BASELINE_REL, 'skills', 'zz-retired-elsewhere', 'SKILL.md'), '# x\n')
    const r = readyRun(fx, head)
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /✗ preflight baseline: serving rel-serving: skill manifest mismatch \[\+zz-retired-elsewhere -\]/)
    assert.match(r.stderr, /未创建 detached unit/)
  } finally {
    fx.cleanup()
  }
})

test('L0 only warns about an incompatible rollback target', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    rmSync(path.join(fx.previous, BASELINE_REL, 'AGENTS.md'))
    const r = readyRun(fx, head)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /⚠ preflight baseline-rollback: 回退目标 rel-previous/)
  } finally {
    fx.cleanup()
  }
})

test('L0 refuses when the deploy_state snapshot cannot be read, as deploy would', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const r = readyRun(fx, head, { FAKE_DS_FAIL: '1' })
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /✗ preflight baseline: deploy_state 只读快照读不到/)
  } finally {
    fx.cleanup()
  }
})

test('L0 refuses a proof database the probe rejects (seq365 attempt 2) and the DSN never reaches output', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const r = readyRun(fx, head, { FAKE_PROBE_LINE: 'fail\tpgcrypto is installed in schema extensions, not public\n' })
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /✗ preflight proof-db: pgcrypto is installed in schema extensions/)
    assert.doesNotMatch(r.stderr + r.stdout, /postgres:\/\//)
  } finally {
    fx.cleanup()
  }
})

test('L0 refuses a checkout HEAD that moved past the pinned SHA (build_release :4010)', () => {
  const head = git(['rev-parse', 'HEAD'])
  const parent = git(['rev-parse', 'HEAD~1'])
  const fx = preflightFixture(head)
  try {
    // pin 只能落在当时的 HEAD;模拟「pin 之后共享 canonical 又前进了一个提交」:队列里的 pin 改成父提交。
    const id = activePinnedQueue(fx, head)
    const db = String(fx.env.OC_V5_RELEASE_QUEUE_DB)
    const upd = spawnSync('sqlite3', [db, `UPDATE release_queue_jobs SET canonical_sha='${parent}' WHERE id='${id}';`], { encoding: 'utf8' })
    assert.equal(upd.status, 0, upd.stderr)
    const r = runPreflight({ ...fx.env, OC_V5_RELEASE_QUEUE_ID: id,
      OC_V5_PROOF_TEST_DATABASE_URL: 'postgres://t@127.0.0.1:55432/x_test' }, ['--with-dist'])
    assert.match(r.stderr, /✓ V5 release queue active=.* canonical_sha=/, 'the queue itself still accepts an ancestor pin')
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /✗ preflight source-pin: .* HEAD [0-9a-f]{12} ≠ target [0-9a-f]{12}/)
  } finally {
    fx.cleanup()
  }
})

test('baseline guard structure modes are read-only and ignore modes the harden step fixes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-baseline-structure-'))
  try {
    const rel = path.join(dir, 'rel-x')
    mkdirSync(path.join(rel, path.dirname(BASELINE_REL)), { recursive: true })
    cpSync(path.join(root, BASELINE_REL), path.join(rel, BASELINE_REL), { recursive: true })
    const agents = path.join(rel, BASELINE_REL, 'AGENTS.md')
    chmodSync(agents, 0o666) // group/other writable: check-release refuses, harden would fix it
    const guard = path.join(root, 'scripts/v5-baseline-security.sh')
    const run = (mode: string) => spawnSync('bash', [guard, mode, rel], { encoding: 'utf8' })
    for (const mode of ['check-structure-release', 'check-structure-release-legacy-cursor']) {
      const r = run(mode)
      assert.equal(r.status, 0, `${mode}: ${r.stderr}`)
      assert.match(r.stdout, /^ok structure=/)
    }
    assert.notEqual(run('check-release').status, 0, 'owner/mode check still refuses the same tree')
    assert.equal(statSync(agents).mode & 0o777, 0o666, 'structure modes changed nothing')
    mkdirSync(path.join(rel, BASELINE_REL, 'skills', 'zz-extra'))
    writeFileSync(path.join(rel, BASELINE_REL, 'skills', 'zz-extra', 'SKILL.md'), '# x\n')
    const extra = run('check-structure-release-legacy-cursor')
    assert.notEqual(extra.status, 0)
    assert.match(extra.stderr, /skill manifest/)
    assert.ok(existsSync(path.join(rel, BASELINE_REL, 'skills', 'zz-extra')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('start runs the preflight and never creates a unit when it fails', () => {
  const fake = fakeTools()
  const log = path.join(path.dirname(fake.bin), 'systemd-run.args')
  writeFileSync(path.join(fake.bin, 'ssh'), '#!/usr/bin/env bash\nexit 97\n')
  chmodSync(path.join(fake.bin, 'ssh'), 0o755)
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_LOG: log }
    delete env.OC_V5_RELEASE_QUEUE_ID
    delete env.OC_V5_PROOF_TEST_DATABASE_URL
    delete env.OC_V5_DETACHED_SKIP_PREFLIGHT
    const result = spawnSync(runner, ['start', '--', '--with-dist'], { cwd: root, encoding: 'utf8', env })
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /发车预检未通过/)
    assert.equal(result.stdout, '')
    assert.throws(() => readFileSync(log, 'utf8'))
  } finally {
    fake.cleanup()
  }
})

test('preflight neither blocks on a held release-queue lock nor writes the queue DB', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const id = activePinnedQueue(fx, head)
    const db = String(fx.env.OC_V5_RELEASE_QUEUE_DB)
    const lock = String(fx.env.OC_V5_RELEASE_QUEUE_LOCK)
    // 先让队列库落盘稳定,再取 hash。
    spawnSync('sqlite3', [db, 'PRAGMA wal_checkpoint(TRUNCATE);'])
    const before = createHash('sha256').update(readFileSync(db)).digest('hex')
    // 另一个进程持有队列锁 60s:assert 路径会在 flock 上无限等;预检必须不受影响。
    const holder = spawn('flock', [lock, 'sleep', '60'], { stdio: 'ignore', detached: true })
    try {
      spawnSync('sleep', ['0.3'])
      const started = Date.now()
      const result = spawnSync(preflight, ['--', '--with-dist', '--egress'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...fx.env, OC_V5_RELEASE_QUEUE_ID: id, OC_V5_PROOF_TEST_DATABASE_URL: 'postgres://t@127.0.0.1:55432/x_test' },
      })
      assert.equal(result.error, undefined, 'preflight hung on the queue lock')
      assert.equal(result.status, 0, result.stderr)
      assert.ok(Date.now() - started < 15_000)
      assert.match(result.stderr, /只读检查/)
    } finally {
      if (holder.pid) process.kill(-holder.pid, 'SIGKILL')
    }
    const after = createHash('sha256').update(readFileSync(db)).digest('hex')
    assert.equal(after, before)
  } finally {
    fx.cleanup()
  }
})

test('preflight requires the proof DSN for knowledge-planet-verify (it calls build_release)', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    const id = activePinnedQueue(fx, head)
    const result = runPreflight({ ...fx.env, OC_V5_RELEASE_QUEUE_ID: id }, ['--verify-knowledge-planet-user=1'])
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /MODE=knowledge-planet-verify 会 build_release/)
  } finally {
    fx.cleanup()
  }
})

test('preflight lane matrix: recovery lanes need neither queue nor DSN; queue lanes need the queue', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  try {
    for (const lane of ['--rollback', '--abort', '--recover', '--smoke', '--reclaim-mutation-lease', '--reclaim-mutation-inflight', '--hide-luna']) {
      const r = runPreflight(fx.env, [lane])
      assert.equal(r.status, 0, `${lane}: ${r.stderr}`)
    }
    for (const lane of ['--finalize', '--promote=50']) {
      const refused = runPreflight(fx.env, [lane])
      assert.equal(refused.status, 2, `${lane}: ${refused.stderr}`)
      assert.match(refused.stderr, /发布队列未就绪/)
      assert.doesNotMatch(refused.stderr, /OC_V5_PROOF_TEST_DATABASE_URL/)
    }
    const id = activePinnedQueue(fx, head)
    for (const lane of ['--finalize', '--promote=50']) {
      const ok = runPreflight({ ...fx.env, OC_V5_RELEASE_QUEUE_ID: id }, [lane])
      assert.equal(ok.status, 0, `${lane}: ${ok.stderr}`)
    }
  } finally {
    fx.cleanup()
  }
})

test('preflight DSN lane list matches every build_release caller in deploy-v5.sh', () => {
  // 新增 build_release 调用方时本用例变红:先在 v5-deploy-preflight.sh 的 builds_release 分支补上对应 MODE。
  const lines = readFileSync(path.join(root, 'scripts/deploy-v5.sh'), 'utf8').split('\n')
  const callers = new Set<string>()
  let fn = ''
  for (const line of lines) {
    const def = /^([a-z_][a-z0-9_]*)\(\)\s*\{/.exec(line)
    if (def) fn = def[1]!
    if (/^\s*#/.test(line)) continue
    // 只认命令位置的调用(行首缩进后 build_release,后接 || / ; / 行尾),不认字符串和注释里的提及。
    if (/^\s+build_release(\s*\|\||\s*;|\s*$)/.test(line)) callers.add(fn)
  }
  assert.deepEqual([...callers].sort(), ['canary', 'deploy', 'deploy_dist', 'knowledge_planet_build_release_mutation'])
})

test('queue check is read-only and reports an unreadable queue as undecidable (exit 3), not as refusal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-rq-check-'))
  try {
    const r = spawnSync(path.join(root, 'scripts/v5-release-queue.sh'), ['check', '--id', 'rq-20261008T000000Z-abcdef123456'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        OC_V5_RELEASE_QUEUE_DB: path.join(dir, 'missing.db'),
        OC_V5_RELEASE_QUEUE_LOCK: path.join(dir, 'queue.lock'),
        OC_V5_RELEASE_QUEUE_RUN_DIR: path.join(dir, 'run'),
      },
    })
    assert.equal(r.status, 3, r.stderr)
    assert.throws(() => readFileSync(path.join(dir, 'missing.db')))
    assert.throws(() => readFileSync(path.join(dir, 'queue.lock')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 发车预检的 nightly 红提示(只提示、不阻断)──
function nightlyGh(dir: string, runs: Array<{ conclusion: string; databaseId: number; createdAt: string }>, failGh = false): string {
  const bin = path.join(dir, 'nightly-bin')
  spawnSync('mkdir', ['-p', bin])
  writeFileSync(path.join(dir, 'runs.json'), JSON.stringify(runs))
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
${failGh ? 'exit 1' : ''}
if [[ "$1 $2" == "run list" ]]; then
  jq_expr=""; while [[ $# -gt 0 ]]; do [[ "$1" == --jq ]] && jq_expr="$2"; shift; done
  jq -r "$jq_expr" "${dir}/runs.json"; exit 0
fi
if [[ "$1" == api ]]; then printf '%s\\n' 'integ nightly-3, integ nightly-5'; exit 0; fi
exit 1
`,
  )
  chmodSync(path.join(bin, 'gh'), 0o755)
  return bin
}

test('preflight warns (never blocks) when integ nightly has been red, with streak and red shards', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  const bin = nightlyGh(path.dirname(String(fx.env.OC_V5_RELEASE_QUEUE_DB)), [
    { conclusion: 'failure', databaseId: 3, createdAt: '2026-10-07T23:28:47Z' },
    { conclusion: 'failure', databaseId: 2, createdAt: '2026-10-06T22:55:05Z' },
    { conclusion: 'success', databaseId: 1, createdAt: '2026-10-05T22:00:00Z' },
    { conclusion: 'failure', databaseId: 0, createdAt: '2026-10-04T22:00:00Z' },
  ])
  try {
    const r = runPreflight({ ...fx.env, PATH: `${bin}:${fx.env.PATH}`, OC_V5_PREFLIGHT_NIGHTLY: '1' }, ['--rollback'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /integ nightly 已连续 2 次红\(最早 2026-10-06,最近 2026-10-07 run 3;红分片:integ nightly-3, integ nightly-5\)/)
  } finally {
    fx.cleanup()
  }
})

test('no nightly warning when the latest nightly is green, when gh fails, or when disabled', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  const dir = path.dirname(String(fx.env.OC_V5_RELEASE_QUEUE_DB))
  try {
    const green = nightlyGh(path.join(dir, 'g'), [{ conclusion: 'success', databaseId: 9, createdAt: '2026-10-08T00:00:00Z' }])
    const failing = nightlyGh(path.join(dir, 'f'), [], true)
    const red = nightlyGh(path.join(dir, 'r'), [{ conclusion: 'failure', databaseId: 9, createdAt: '2026-10-08T00:00:00Z' }])
    for (const [bin, enabled] of [[green, '1'], [failing, '1'], [red, '0']] as const) {
      const r = runPreflight({ ...fx.env, PATH: `${bin}:${fx.env.PATH}`, OC_V5_PREFLIGHT_NIGHTLY: enabled }, ['--rollback'])
      assert.equal(r.status, 0, r.stderr)
      assert.doesNotMatch(r.stderr, /integ nightly/)
    }
  } finally {
    fx.cleanup()
  }
})

test('a failing preflight still fails; the nightly advisory never turns a refusal into a pass', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  const bin = nightlyGh(path.dirname(String(fx.env.OC_V5_RELEASE_QUEUE_DB)), [{ conclusion: 'failure', databaseId: 3, createdAt: '2026-10-07T23:28:47Z' }])
  try {
    const r = runPreflight({ ...fx.env, PATH: `${bin}:${fx.env.PATH}`, OC_V5_PREFLIGHT_NIGHTLY: '1' }, ['--with-dist'])
    assert.equal(r.status, 2, r.stderr)
  } finally {
    fx.cleanup()
  }
})

test('a gh that hangs and ignores TERM cannot hold up the preflight (hard kill after the timeout)', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  const bin = path.join(path.dirname(String(fx.env.OC_V5_RELEASE_QUEUE_DB)), 'hang-bin')
  spawnSync('mkdir', ['-p', bin])
  writeFileSync(path.join(bin, 'gh'), "#!/usr/bin/env bash\ntrap '' TERM\nsleep 60\n")
  chmodSync(path.join(bin, 'gh'), 0o755)
  try {
    const started = Date.now()
    const r = runPreflight(
      { ...fx.env, PATH: `${bin}:${fx.env.PATH}`, OC_V5_PREFLIGHT_NIGHTLY: '1', OC_V5_PREFLIGHT_NIGHTLY_TIMEOUT: '1', OC_V5_PREFLIGHT_NIGHTLY_KILL_AFTER: '1' },
      ['--rollback'],
    )
    assert.equal(r.status, 0, r.stderr)
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms`)
    assert.doesNotMatch(r.stderr, /integ nightly/)
  } finally {
    fx.cleanup()
  }
})

test('the second gh call (red shards) hanging with a pipe-holding grandchild cannot hold up the preflight either', () => {
  const head = git(['rev-parse', 'HEAD'])
  const fx = preflightFixture(head)
  const dir = path.dirname(String(fx.env.OC_V5_RELEASE_QUEUE_DB))
  const bin = path.join(dir, 'hang2-bin')
  spawnSync('mkdir', ['-p', bin])
  writeFileSync(path.join(dir, 'runs2.json'), JSON.stringify([{ conclusion: 'failure', databaseId: 5, createdAt: '2026-10-07T23:00:00Z' }]))
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
if [[ "$1 $2" == "run list" ]]; then
  jq_expr=""; while [[ $# -gt 0 ]]; do [[ "$1" == --jq ]] && jq_expr="$2"; shift; done
  jq -r "$jq_expr" "${dir}/runs2.json"; exit 0
fi
# api: leave a grandchild that inherits stdout, then ignore TERM and hang.
( trap '' TERM; sleep 60 ) &
trap '' TERM
sleep 60
`,
  )
  chmodSync(path.join(bin, 'gh'), 0o755)
  try {
    const started = Date.now()
    const r = runPreflight(
      { ...fx.env, PATH: `${bin}:${fx.env.PATH}`, OC_V5_PREFLIGHT_NIGHTLY: '1', OC_V5_PREFLIGHT_NIGHTLY_TIMEOUT: '1', OC_V5_PREFLIGHT_NIGHTLY_KILL_AFTER: '1' },
      ['--rollback'],
    )
    assert.equal(r.error, undefined, 'preflight hung')
    assert.equal(r.status, 0, r.stderr)
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms`)
    // run list answered, so the advisory still prints (shards unknown).
    assert.match(r.stderr, /integ nightly 已连续 1 次红.*红分片:\?/)
  } finally {
    fx.cleanup()
  }
})
