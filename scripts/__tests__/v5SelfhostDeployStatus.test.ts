// OCV5-449: deploy-v5-selfhost.sh --status prints one state word per unit and
// reads spa dist / .complete from the live release, not the worktree.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = readFileSync(path.join(root, 'scripts/deploy-v5-selfhost.sh'), 'utf8')
const diagnostics = readFileSync(path.join(root, 'scripts/lib/v5-selfhost-diagnostics.sh'), 'utf8')

function fnBody(name: string): string {
  const source = src.includes(`${name}() {`) ? src : diagnostics
  if (source === diagnostics) assert.ok(src.includes('source "$SCRIPT_DIR/lib/v5-selfhost-diagnostics.sh"'))
  const start = source.indexOf(`${name}() {`)
  assert.ok(start >= 0, `${name} not found`)
  return source.slice(start, source.indexOf('\n}\n', start) + 2)
}

function unitState(stub: string, args: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-449-'))
  try {
    writeFileSync(path.join(dir, 'systemctl'), `#!/usr/bin/env bash\n${stub}\n`)
    chmodSync(path.join(dir, 'systemctl'), 0o755)
    const r = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail; ${fnBody('status_unit_state')}\nstatus_unit_state "$@"`,
        'x',
        ...args,
      ],
      { env: { PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' },
    )
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('deploy-v5-selfhost.sh --status', () => {
  test('inactive unit: exactly one word, no appended fallback line', () => {
    assert.equal(unitState('echo inactive; exit 3', ['u.service']), 'inactive')
  })

  test('active unit: active', () => {
    assert.equal(unitState('echo active; exit 0', ['u.service']), 'active')
  })

  test('systemctl prints nothing: fallback word (default n/a)', () => {
    assert.equal(unitState('exit 1', ['u.service']), 'n/a')
    assert.equal(unitState('exit 1', ['u.service', 'inactive']), 'inactive')
  })

  test('cmd_status has no `systemctl is-active … || echo` left', () => {
    const body = fnBody('cmd_status')
    assert.equal(/systemctl is-active[^\n]*\|\| echo/.test(body), false)
    assert.ok(body.includes('status_unit_state "$V5_UNIT"'))
  })

  test('spa dist and .complete are read from the live release', () => {
    const body = fnBody('cmd_status')
    assert.ok(body.includes('"$live_now/packages/web-react/dist/index.html"'))
    assert.ok(body.includes('"$live_now/.complete"'))
    assert.equal(body.includes('"$REPO_ROOT/packages/web-react/dist/index.html"'), false)
    assert.equal(body.includes('"$REPO_ROOT/.complete"'), false)
  })
})

function statusWithPolicyResult(policyResult: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-606-status-'))
  try {
    const live = path.join(dir, 'release')
    mkdirSync(live)
    symlinkSync(live, path.join(dir, 'live'))
    const prelude = `
set -u
REPO_ROOT="$1"; MASTER_LIVE_LINK="$1/live"; MASTER_RELEASES_ROOT="$1/releases"
V5_ENV="$1/absent-env"; SURVIVOR_STATE="$1/absent-survivor"; V5_WATCH_MAINT="$1/absent-maintenance"
V5_UNIT=master; V5_EGRESS_UNIT=egress; V5_HOSTNET_UNIT=hostnet
V5_CCB_PROXY_UNIT=ccb; V5_SSHGATE_UNIT=sshgate; V5_TUNNEL_UNIT=tunnel; PERSONAL_UNIT=personal
V5_PORT=18790; V5_EGRESS_PORT=18892; PERSONAL_PORT=18789; PG_DB=fixture
log() { printf '%s\\n' "$*"; }
status_unit_state() { echo inactive; }
egress_slot_unit() { echo fake-slot; }
egress_describe_topology() { echo fixture; }
watch_summary() { echo fixture; }
gate_fail_policy() { echo stay; }
docker() { return 1; }
sudo() { return 1; }
sysctl() { echo 0; }
port_in_use() { return 0; }
host_log_policy_check_release() { printf 'policy-target=%s\\n' "$1"; return ${policyResult}; }
`
    const r = spawnSync('bash', ['-c', prelude + fnBody('cmd_status') + '\ncmd_status', '_', dir], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    })
    assert.ok(r.stdout.includes('policy-target=' + live))
    assert.match(r.stdout, /port 18789: listen/)
    return r
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
test('status returns success after a successful policy check and all diagnostics', () => {
  const r = statusWithPolicyResult(0)
  assert.equal(r.status, 0, r.stderr + r.stdout)
})
test('status preserves the policy failure code after the final port diagnostics', () => {
  const r = statusWithPolicyResult(17)
  assert.equal(r.status, 17, r.stderr + r.stdout)
})
