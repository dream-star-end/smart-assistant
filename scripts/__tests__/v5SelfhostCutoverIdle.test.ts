import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lib = readFileSync(path.join(root, 'scripts/v5-selfhost-master-release-lib.sh'), 'utf8')
const fn = lib.match(/^cutover_wait_for_user_idle\(\) \{[\s\S]*?\n\}/m)?.[0]
assert.ok(fn)

function run(stub: string, dry = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-idle-'))
  try {
    return spawnSync(
      'bash',
      [
        '-c',
        `set -Eeuo pipefail
DRY=${dry}; PG_DB=personal_fixture; SECONDS=0; state=${JSON.stringify(path.join(dir, 'state'))}
cutover_clog() { echo "$*"; }
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
  const check = body.indexOf('cutover_wait_for_user_idle || return 1')
  assert.ok(check > body.indexOf('write_prev_release_file "$prev_val"'))
  assert.ok(check < body.indexOf('cutover_persist_phase "pre-install"'))
  assert.ok(check < body.indexOf('cutover_arm_survivor "$backup"'))
  assert.ok(check < body.indexOf('CUTOVER_MUTATED=1'))
  assert.ok(check < body.indexOf('install_unit "$unit_snap/$V5_EGRESS_UNIT"'))
  assert.ok(check < body.indexOf('atomic_flip_live_symlink "$rel"'))
  assert.doesNotMatch(fn, /cutover_compensate|systemctl|survivor|atomic_flip/)
})
