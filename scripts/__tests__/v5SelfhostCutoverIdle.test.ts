import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lib = readFileSync(path.join(root, 'scripts/v5-selfhost-master-release-lib.sh'), 'utf8')
const fn = lib.match(/^cutover_wait_for_user_idle\(\) \{[\s\S]*?\n\}/m)?.[0]
assert.ok(fn)

function run(stub: string, dry = 0, allow = 0, bound = 1, db = 'openclaude_v5_selfhost') {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-idle-'))
  try {
    return spawnSync(
      'bash',
      [
        '-c',
        `set -Eeuo pipefail
DRY=${dry}; ALLOW_INFLIGHT=${allow}; PG_DB=${db}; SECONDS=0; state=${JSON.stringify(path.join(dir, 'state'))}
cutover_clog() { echo "$*"; }
LEASE_TRAIN_ID=fixture; LEASE_TARGET_SHA=fixture
lease_train_load_lib() { return 0; }
lease_inflight_train_allowed() { return $((1 - ${bound})); }
sleep() { SECONDS=$((SECONDS + 300)); echo SLEPT; }
psql_as_postgres() { ${stub}; }
${fn}
cutover_wait_for_user_idle
printf 'MUTATION_ALLOWED\n'
`,
      ],
      { encoding: 'utf8' },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a turn started during build finishes before mutation is allowed', () => {
  const r = run('if [[ ! -f "$state" ]]; then touch "$state"; echo "1|0"; else echo "0|0"; fi')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(r.stdout.indexOf('SLEPT') < r.stdout.indexOf('MUTATION_ALLOWED'))
  assert.match(r.stdout, /open_dispatches=1/)
  assert.match(r.stdout, /open_dispatches=0/)
})

test('an unresolved journal also waits; busy timeout never reaches mutation', () => {
  for (const counts of ['1|0', '0|1']) {
    const r = run(`echo '${counts}'`)
    assert.notEqual(r.status, 0)
    assert.match(r.stdout, /600s 超时/)
    assert.doesNotMatch(r.stdout, /MUTATION_ALLOWED/)
  }
})

test('SQL failure, empty or malformed snapshots fail closed', () => {
  for (const stub of [
    'return 2',
    'true',
    "echo '0|0oops'",
    "printf '0|0\\n1|0\\n'",
    "echo '-1|0'",
  ]) {
    const r = run(stub)
    assert.notEqual(r.status, 0, stub)
    assert.doesNotMatch(r.stdout, /MUTATION_ALLOWED/, stub)
  }
})

test('dry-run never invokes the database or sleeps', () => {
  const r = run('echo DATABASE_CALLED; return 2', 1)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /DATABASE_CALLED|SLEPT/)
  assert.match(r.stdout, /MUTATION_ALLOWED/)
})

test('the actual query includes all roles and excludes only definitely terminal history', () => {
  const r = run(`printf '%s\\n' "$@" > "$state"; echo '0|0'`)
  assert.equal(r.status, 0, r.stderr)
  assert.match(fn, /BEGIN READ ONLY/)
  assert.match(fn, /statement_timeout = '5s'/)
  assert.match(fn, /status IN \('admitted','accepted','rejecting'\)/)
  assert.match(fn, /j\.state NOT IN \('aborted','committed'\) AND NOT EXISTS/)
  assert.match(fn, /d\.dispatch_id=j\.dispatch_id/)
  assert.match(fn, /d\.status='terminal' AND d\.terminal_at IS NOT NULL/)
  assert.doesNotMatch(fn, /users\b|user_id\s*[=!<>]|UPDATE|INSERT|DELETE/)
})

test('cutover refuses before survivor/mutation and does not compensate idle failure', () => {
  const deploy = readFileSync(path.join(root, 'scripts/deploy-v5-selfhost.sh'), 'utf8')
  const body = deploy.match(/^cmd_cutover\(\) \{[\s\S]*?\n\}/m)?.[0]
  assert.ok(body)
  const check = body.indexOf('selfhost_wait_idle_or_defer 600 "$rel" || return $?')
  assert.ok(check > body.indexOf('write_prev_release_file "$prev_val"'))
  assert.ok(check < body.indexOf('cutover_persist_phase "pre-install"'))
  assert.ok(check < body.indexOf('cutover_arm_survivor "$backup"'))
  assert.ok(check < body.indexOf('CUTOVER_MUTATED=1'))
  const installPolicy = body.indexOf('install_host_log_policy_from_snapshot "$rel" "$unit_snap"')
  assert.ok(installPolicy > body.indexOf('CUTOVER_MUTATED=1'))
  assert.ok(check < installPolicy)
  assert.ok(installPolicy < body.indexOf('install_unit "$unit_snap/$V5_EGRESS_UNIT"'))
  assert.ok(check < body.indexOf('install_unit "$unit_snap/$V5_EGRESS_UNIT"'))
  assert.ok(check < body.indexOf('atomic_flip_live_symlink "$rel"'))
  assert.doesNotMatch(fn, /cutover_compensate|systemctl|survivor|atomic_flip/)
})


test('explicit selfhost permission skips only the idle query and sleep', () => {
  const r = run('echo DATABASE_CALLED; echo "1|1"; return 2', 0, 1)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /--allow-inflight.*600s/)
  assert.match(r.stdout, /MUTATION_ALLOWED/)
  assert.doesNotMatch(r.stdout, /DATABASE_CALLED|SLEPT/)
})

test('inflight permission needs the official source-bound train and selfhost database', () => {
  for (const r of [run('echo "1|1"', 0, 1, 0), run('echo "1|1"', 0, 1, 1, 'commercial_fixture')]) {
    assert.notEqual(r.status, 0)
    assert.doesNotMatch(r.stdout, /MUTATION_ALLOWED/)
  }
})

test('real registration, SQL binding and both worker spawn paths keep permission source-bound', () => {
  const r = spawnSync('python3', [path.join(root, 'scripts/__tests__/v5SelfhostInflight.test.py')], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /PASS selfhost inflight registration, frozen binding, old-worker adoption and worker argv/)
})

test('selfhost CLI accepts the explicit argument and never inherits permission from env', () => {
  const deploy = readFileSync(path.join(root, 'scripts/deploy-v5-selfhost.sh'), 'utf8')
  const parser = deploy.match(/^for arg in "\$@"; do\n[\s\S]*?^done$/m)?.[0]
  const init = deploy.match(/^ALLOW_DIRTY=0[^\n]*$/m)?.[0]
  assert.ok(parser && init)
  for (const allow of [false, true]) {
    const r = spawnSync('bash', ['-c', `set -euo pipefail
MODE=''; DRY=0
${init}
usage() { return 2; }
${parser}
printf 'MODE=%s ALLOW=%s\n' "$MODE" "$ALLOW_INFLIGHT"
`, 'fixture', '--deploy', ...(allow ? ['--allow-inflight'] : [])], {
      encoding: 'utf8', env: { ...process.env, ALLOW_INFLIGHT: '1' },
    })
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, new RegExp(`MODE=deploy ALLOW=${allow ? 1 : 0}`))
  }
})

test('commercial deployment rejects the parameter without invoking external operations', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-commercial-no-inflight-'))
  try {
    const bin = path.join(dir, 'bin')
    const spy = path.join(dir, 'external.calls')
    mkdirSync(bin)
    for (const name of ['ssh', 'sudo', 'systemctl', 'docker']) {
      const file = path.join(bin, name)
      writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$SPY_LOG"\nexit 99\n')
      chmodSync(file, 0o755)
    }
    const r = spawnSync('bash', [path.join(root, 'scripts/deploy-v5.sh'), '--allow-inflight'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', ALLOW_INFLIGHT: '1',
        PATH: `${bin}:${process.env.PATH}`, SPY_LOG: spy },
    })
    assert.equal(r.status, 2, r.stderr + r.stdout)
    assert.match(r.stderr + r.stdout, /未知参数.*--allow-inflight/)
    assert.equal(existsSync(spy), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('an early claimed train keeps its exact source when shared HEAD advances during auxiliary setup', () => {
  const deploy = readFileSync(path.join(root, 'scripts/deploy-v5-selfhost.sh'), 'utf8')
  const start = deploy.indexOf('  ensure_model_authority\n', deploy.indexOf('cmd_deploy()'))
  const end = deploy.indexOf('  build_master_release "$sha"', start)
  assert.ok(start > 0 && end > start)
  const actual = `${deploy.slice(start, end)}  build_master_release "$sha"\n  fi\n`
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  for (const active of [0, 1]) {
    const r = spawnSync('bash', ['-c', `set -Eeuo pipefail
sha=${a}; LEASE_TRAIN_ACTIVE=${active}; BUILT_MASTER_RELEASE=fixture
source_commit() { echo ${b}; }
ensure_model_authority() { :; }
assert_env_key_drift() { :; }
lease_train_begin() { echo "CLAIM:$1"; }
selfhost_release_preflight() { echo "L0:$1"; }
selfhost_wait_idle_or_defer() { [[ "$1" == 0 ]]; }
selfhost_idle_retry_load() { return 1; }
assert_fix_trailers() { :; }
assert_p0_web_overlay_contained() { :; }
log() { :; }
build_master_release() { echo "MASTER:$1 BG:\${MASTER_RUNTIME_BG_AFTER_ADMISSION:-0}"; }
${actual}`], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const expected = active ? a : b
    // OCV5-648 (P2): build_master_release starts the runtime bg build from its own $1 after admission
    assert.match(r.stdout, new RegExp(`MASTER:${expected} BG:1`))
    // OCV5-581: L0 checks the same exact source the build uses, after the claim and before the build
    assert.match(r.stdout, new RegExp(`L0:${expected}[\\s\\S]*MASTER:${expected}`))
    if (!active) assert.match(r.stdout, new RegExp(`CLAIM:${b}[\\s\\S]*L0:${b}`))
    if (active) assert.doesNotMatch(r.stdout, /CLAIM:/)
    else assert.match(r.stdout, new RegExp(`CLAIM:${b}`))
  }
})
