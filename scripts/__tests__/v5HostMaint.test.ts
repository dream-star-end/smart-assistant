import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lib = path.join(root, 'scripts/v5-host-maint-lib.sh')
const installScript = path.join(root, 'scripts/host/install-needrestart-exclusions.sh')
const detached = path.join(root, 'scripts/v5-deploy-detached.sh')

function shims(dir: string): string {
  const bin = path.join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const stateDir = path.join(dir, 'timer-state')
  mkdirSync(stateDir, { recursive: true })
  const log = path.join(dir, 'systemctl.log')
  const pgrepHits = path.join(dir, 'pgrep-hits')
  const loggerLog = path.join(dir, 'logger.log')
  writeFileSync(log, '')
  writeFileSync(pgrepHits, '')
  writeFileSync(loggerLog, '')

  writeFileSync(
    path.join(bin, 'systemctl'),
    `#!/usr/bin/env bash
set -euo pipefail
log="${log}"
state_dir="${stateDir}"
printf '%s\\n' "$*" >>"$log"
cmd="\${1:-}"; shift || true
case "\$cmd" in
  is-active)
    quiet=0
    [[ "\${1:-}" == --quiet ]] && { quiet=1; shift; }
    unit="\${1:-}"
    val="$(cat "$state_dir/\$unit" 2>/dev/null || echo inactive)"
    if [[ "\$val" == active ]]; then
      [[ "\$quiet" == 1 ]] || printf '%s\\n' active
      exit 0
    fi
    [[ "\$quiet" == 1 ]] || printf '%s\\n' inactive
    exit 3
    ;;
  is-enabled)
    quiet=0
    [[ "\${1:-}" == --quiet ]] && { quiet=1; shift; }
    [[ "\$quiet" == 1 ]] || printf '%s\\n' enabled
    exit 0
    ;;
  stop)
    unit="\${1:-}"
    printf '%s\\n' inactive >"$state_dir/\$unit"
    exit 0
    ;;
  start)
    unit="\${1:-}"
    printf '%s\\n' active >"$state_dir/\$unit"
    exit 0
    ;;
  list-units)
    if [[ "\${FAKE_DEPLOY_UNIT:-}" != "" ]]; then
      printf '%s loaded active running fake\\n' "\$FAKE_DEPLOY_UNIT"
    fi
    exit 0
    ;;
  show)
    unit=""
    for a in "\$cmd" "\$@"; do :; done
    # last non-flag arg is the unit; systemd-run tests pass glob as last
    unit="\${@: -1}"
    if [[ "\$*" == *"--property=MainPID"* ]]; then
      printf '%s\\n' "\${FAKE_DEPLOY_MAINPID:-0}"
      exit 0
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
  )
  writeFileSync(
    path.join(bin, 'pgrep'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == -x ]]; then
  hits="$(cat "${pgrepHits}" 2>/dev/null || true)"
  if [[ -n "\$hits" ]]; then
    printf '%s\\n' "\$hits"
    exit 0
  fi
  exit 1
fi
exit 1
`,
  )
  writeFileSync(
    path.join(bin, 'logger'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${loggerLog}"
`,
  )
  writeFileSync(
    path.join(bin, 'ps'),
    `#!/usr/bin/env bash
printf '%s\\n' "\${FAKE_PS_ARGS:-apt-get update}"
`,
  )
  writeFileSync(
    path.join(bin, 'sudo'),
    `#!/usr/bin/env bash
exec "$@"
`,
  )
  for (const name of ['systemctl', 'pgrep', 'logger', 'ps', 'sudo']) {
    chmodSync(path.join(bin, name), 0o755)
  }
  return bin
}

function runLib(
  dir: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const bin = path.join(dir, 'bin')
  const result = spawnSync('bash', [lib, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OC_V5_MAINT_STATE_FILE: path.join(dir, 'maint-suspended.json'),
      ...extraEnv,
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function setTimer(dir: string, unit: string, state: 'active' | 'inactive') {
  writeFileSync(path.join(dir, 'timer-state', unit), `${state}\n`)
}

function setPgrepHits(dir: string, hits: string) {
  writeFileSync(path.join(dir, 'pgrep-hits'), hits)
}

test('timer active → suspend writes json and stops both active timers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-host-maint-'))
  try {
    shims(dir)
    setTimer(dir, 'apt-daily.timer', 'active')
    setTimer(dir, 'apt-daily-upgrade.timer', 'active')
    const r = runLib(dir, ['suspend', 'abc123deadbeef'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const json = JSON.parse(readFileSync(path.join(dir, 'maint-suspended.json'), 'utf8'))
    assert.equal(json.deployId, 'abc123deadbeef')
    assert.ok(typeof json.suspendedAt === 'string' && json.suspendedAt.endsWith('Z'))
    assert.deepEqual(json.timers.sort(), ['apt-daily-upgrade.timer', 'apt-daily.timer'])
    assert.equal(readFileSync(path.join(dir, 'timer-state', 'apt-daily.timer'), 'utf8').trim(), 'inactive')
    assert.equal(
      readFileSync(path.join(dir, 'timer-state', 'apt-daily-upgrade.timer'), 'utf8').trim(),
      'inactive',
    )
    const log = readFileSync(path.join(dir, 'systemctl.log'), 'utf8')
    assert.match(log, /stop apt-daily\.timer/)
    assert.match(log, /stop apt-daily-upgrade\.timer/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timers inactive → suspend does not write json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-host-maint-'))
  try {
    shims(dir)
    setTimer(dir, 'apt-daily.timer', 'inactive')
    setTimer(dir, 'apt-daily-upgrade.timer', 'inactive')
    const r = runLib(dir, ['suspend', 'abc123deadbeef'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    let exists = true
    try {
      readFileSync(path.join(dir, 'maint-suspended.json'))
    } catch {
      exists = false
    }
    assert.equal(exists, false)
    assert.match(r.stdout, /nothing to suspend/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('abnormal EXIT trap restores timers and deletes json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-host-maint-'))
  try {
    const bin = shims(dir)
    setTimer(dir, 'apt-daily.timer', 'active')
    setTimer(dir, 'apt-daily-upgrade.timer', 'inactive')
    const wrapper = path.join(dir, 'crash.sh')
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/v5-host-maint-lib.sh
source ${JSON.stringify(lib)}
HOST_MAINT_DEPLOY_ID=crash42
trap 'host_maint_restore_owned "$HOST_MAINT_DEPLOY_ID"' EXIT
host_maint_begin "$HOST_MAINT_DEPLOY_ID"
exit 42
`,
    )
    const result = spawnSync('bash', [wrapper], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OC_V5_MAINT_STATE_FILE: path.join(dir, 'maint-suspended.json'),
      },
    })
    assert.equal(result.status, 42, result.stdout + result.stderr)
    let exists = true
    try {
      readFileSync(path.join(dir, 'maint-suspended.json'))
    } catch {
      exists = false
    }
    assert.equal(exists, false, 'json must be removed on trap restore')
    assert.equal(readFileSync(path.join(dir, 'timer-state', 'apt-daily.timer'), 'utf8').trim(), 'active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('leftover json with different deployId is restored before takeover', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-host-maint-'))
  try {
    shims(dir)
    setTimer(dir, 'apt-daily.timer', 'inactive')
    setTimer(dir, 'apt-daily-upgrade.timer', 'inactive')
    writeFileSync(
      path.join(dir, 'maint-suspended.json'),
      JSON.stringify({
        deployId: 'old-deploy',
        suspendedAt: '2026-09-05T00:00:00Z',
        timers: ['apt-daily.timer'],
      }) + '\n',
    )
    const r = runLib(dir, ['suspend', 'new-deploy'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /上一轮维护租约未恢复/)
    const json = JSON.parse(readFileSync(path.join(dir, 'maint-suspended.json'), 'utf8'))
    assert.equal(json.deployId, 'new-deploy')
    assert.deepEqual(json.timers, ['apt-daily.timer'])
    // Final state is suspended again; the takeover must have started then stopped.
    assert.equal(readFileSync(path.join(dir, 'timer-state', 'apt-daily.timer'), 'utf8').trim(), 'inactive')
    const log = readFileSync(path.join(dir, 'systemctl.log'), 'utf8')
    assert.match(log, /start apt-daily\.timer/)
    assert.match(log, /stop apt-daily\.timer/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pgrep hit refuses start (fail-closed)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-host-maint-'))
  try {
    shims(dir)
    setPgrepHits(dir, '4242')
    const r = runLib(dir, ['precheck'], { FAKE_PS_ARGS: 'apt-get update' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /拒绝启动:宿主维护进程仍在运行/)
    assert.match(r.stderr, /apt-get update/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unattended-upgrade-shutdown --wait-for-signal is not a blocking maint process', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-host-maint-'))
  try {
    shims(dir)
    setPgrepHits(dir, '990')
    const r = runLib(dir, ['precheck'], {
      FAKE_PS_ARGS: '/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal',
    })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /ignore unattended-upgrade-shutdown/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore-stale restores when suspendedAt is older than 6h and no in-flight deploy', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-host-maint-'))
  try {
    shims(dir)
    setTimer(dir, 'apt-daily.timer', 'inactive')
    writeFileSync(
      path.join(dir, 'maint-suspended.json'),
      JSON.stringify({
        deployId: 'stale-one',
        suspendedAt: '2020-01-01T00:00:00Z',
        timers: ['apt-daily.timer'],
      }) + '\n',
    )
    const r = runLib(dir, ['restore-stale'], { FAKE_DEPLOY_MAINPID: '0' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    let exists = true
    try {
      readFileSync(path.join(dir, 'maint-suspended.json'))
    } catch {
      exists = false
    }
    assert.equal(exists, false)
    assert.equal(readFileSync(path.join(dir, 'timer-state', 'apt-daily.timer'), 'utf8').trim(), 'active')
    assert.match(readFileSync(path.join(dir, 'logger.log'), 'utf8'), /stale maint lease restored/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore-stale leaves fresh json and in-flight deploys alone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-host-maint-'))
  try {
    shims(dir)
    const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    writeFileSync(
      path.join(dir, 'maint-suspended.json'),
      JSON.stringify({
        deployId: 'fresh-one',
        suspendedAt: nowIso,
        timers: ['apt-daily.timer'],
      }) + '\n',
    )
    const fresh = runLib(dir, ['restore-stale'])
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr)
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'maint-suspended.json'), 'utf8')).deployId, 'fresh-one')

    writeFileSync(
      path.join(dir, 'maint-suspended.json'),
      JSON.stringify({
        deployId: 'live-one',
        suspendedAt: '2020-01-01T00:00:00Z',
        timers: ['apt-daily.timer'],
      }) + '\n',
    )
    const live = runLib(dir, ['restore-stale'], {
      FAKE_DEPLOY_UNIT: 'openclaude-v5-deploy-20260905-000000-deadbeef-deploy.service',
      FAKE_DEPLOY_MAINPID: '4321',
    })
    assert.equal(live.status, 0, live.stdout + live.stderr)
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'maint-suspended.json'), 'utf8')).deployId, 'live-one')
    assert.match(live.stderr, /MainPID is live/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('install-needrestart-exclusions is idempotent and diffs before write', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-needrestart-install-'))
  try {
    const bin = shims(dir)
    const src = path.join(root, 'scripts/host/needrestart-openclaude.conf')
    const dest = path.join(dir, 'conf.d/openclaude.conf')
    const first = spawnSync('bash', [installScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OC_V5_NEEDRESTART_SRC: src,
        OC_V5_NEEDRESTART_DEST: dest,
      },
    })
    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.match(first.stdout, /installed/)
    const body = readFileSync(dest, 'utf8')
    assert.match(body, /openclaude-v5-deploy-/)
    const second = spawnSync('bash', [installScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OC_V5_NEEDRESTART_SRC: src,
        OC_V5_NEEDRESTART_DEST: dest,
      },
    })
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.match(second.stdout, /already installed \(identical\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deploy-v5.sh wires host-maint precheck/begin/restore and does not use KillMode=none', () => {
  const body = readFileSync(path.join(root, 'scripts/deploy-v5.sh'), 'utf8')
  assert.match(body, /v5-host-maint-lib\.sh/)
  assert.match(body, /host_maint_precheck/)
  assert.match(body, /host_maint_begin/)
  assert.match(body, /host_maint_restore_owned/)
  assert.equal(body.includes('KillMode=none'), false)
})

test('detached runner sets ExecStopPost restore and keeps KillMode=control-group', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-deploy-detached-maint-'))
  try {
    const bin = path.join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    const log = path.join(dir, 'systemd-run.args')
    const scripts: Record<string, string> = {
      git: `#!/usr/bin/env bash
case "$*" in
  *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' feat/v5-aurora-rewrite ;;
  *"status --porcelain"*) printf '%s' "" ;;
  *"rev-parse --short=8 HEAD"*) printf '%s\\n' deadbeef ;;
  *) exit 2 ;;
esac
`,
      systemctl: `#!/usr/bin/env bash
if [[ "$*" == *"list-units"* ]]; then exit 0; fi
exit 0
`,
      'systemd-run': `#!/usr/bin/env bash
printf '%s\\n' "$@" >"${log}"
`,
    }
    for (const [name, body] of Object.entries(scripts)) {
      writeFileSync(path.join(bin, name), body)
      chmodSync(path.join(bin, name), 0o755)
    }
    const result = spawnSync(detached, ['start', '--', '--canary'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const args = readFileSync(log, 'utf8').trim().split('\n')
    assert.ok(args.includes('--property=KillMode=control-group'))
    assert.equal(args.some((a) => a.includes('KillMode=none')), false)
    const stopPost = args.find((a) => a.startsWith('--property=ExecStopPost='))
    assert.ok(stopPost, `missing ExecStopPost in ${args.join(' | ')}`)
    assert.match(stopPost!, /v5-host-maint-lib\.sh/)
    assert.match(stopPost!, /restore/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
