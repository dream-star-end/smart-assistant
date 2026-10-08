import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// 假 ssh:只回答 deploy-v5.sh egress surface gate 的两次只读查询(egress 进程 cwd、release sourceCommit)。
function preflightFixture(egressSha: string): {
  env: NodeJS.ProcessEnv
  queue: (args: string[]) => ReturnType<typeof spawnSync>
  cleanup: () => void
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-deploy-preflight-'))
  const bin = path.join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  writeFileSync(
    path.join(bin, 'ssh'),
    `#!/usr/bin/env bash
case "$*" in
  *MainPID*) printf '%s\\n' /opt/openclaude/openclaude-v5-releases/rel-egress-fixture ;;
  *sourceCommit*) printf '%s\\n' "$FAKE_EGRESS_SHA" ;;
  *) exit 97 ;;
esac
`,
  )
  chmodSync(path.join(bin, 'ssh'), 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ALLOW_ANY_BRANCH: '1',
    KL_HOST: 'kl-preflight-fixture',
    FAKE_EGRESS_SHA: egressSha,
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
  return { env, queue, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
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
  return spawnSync(preflight, ['--', ...args], { cwd: root, encoding: 'utf8', env })
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
