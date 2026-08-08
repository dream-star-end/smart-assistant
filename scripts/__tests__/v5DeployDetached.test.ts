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
