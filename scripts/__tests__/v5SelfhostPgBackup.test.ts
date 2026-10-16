// OCV5-443: behaviour of scripts/v5-selfhost-pg-backup.sh against stub pg tools.
// No real database is touched: pg_dump / pg_restore / df / the full sink are
// PATH stubs inside a private temp dir, and the script runs with V5SB_PG_AS="".
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'scripts/v5-selfhost-pg-backup.sh')
const GIB = 1024 ** 3

let dir: string

function stub(name: string, body: string) {
  const p = path.join(dir, 'bin', name)
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(p, 0o755)
}

function setAvail(bytes: number) {
  writeFileSync(path.join(dir, 'avail'), String(bytes))
}

function run(args: string[] = ['run'], extraEnv: Record<string, string> = {}, wrap = '') {
  const env: Record<string, string> = {
    PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
    HOME: dir,
    STUB_DIR: dir,
    V5SB_PG_AS: '',
    V5SB_DIR: path.join(dir, 'backups'),
    V5SB_STATUS: path.join(dir, 'state/status.json'),
    V5SB_LOCK: path.join(dir, 'run/backup.lock'),
    V5SB_DEPLOY_LOCK: path.join(dir, 'run/deploy.lock'),
    V5SB_DEPLOY_WAIT_SEC: '0',
    V5SB_WATCH_INTERVAL: '0.1',
    V5SB_MIN_FREE_GIB: '10',
    V5SB_ABORT_FREE_GIB: '9',
    V5SB_CORE_EST_BYTES: String(GIB),
    V5SB_FULL_SINK: '',
    ...extraEnv,
  }
  const cmd = wrap ? ['-c', `${wrap}; exec bash "$0" "$@"`, script, ...args] : [script, ...args]
  const r = spawnSync('bash', cmd, { env, encoding: 'utf8', timeout: 30_000 })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

function status(): any {
  return JSON.parse(readFileSync(path.join(dir, 'state/status.json'), 'utf8'))
}

function backups(): string[] {
  const d = path.join(dir, 'backups')
  return existsSync(d) ? readdirSync(d).sort() : []
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ocv5-443-pgbackup-'))
  mkdirSync(path.join(dir, 'bin'))
  mkdirSync(path.join(dir, 'run'))
  setAvail(50 * GIB)
  // df -PB1 -- <dir>: avail column comes from $STUB_DIR/avail on every call.
  stub(
    'df',
    'printf "Filesystem 1-blocks Used Available Use%% Mounted\\n/dev/x 1 1 %s 1%% /\\n" "$(cat "$STUB_DIR/avail")"',
  )
  // pg_dump: record args; mode from $STUB_DIR/dump_mode (ok|fail|slow|shrink).
  stub(
    'pg_dump',
    [
      'printf "%s\\n" "$@" > "$STUB_DIR/pg_dump.args"',
      'mode=$(cat "$STUB_DIR/dump_mode" 2>/dev/null || echo ok)',
      'case "$mode" in',
      '  fail) echo partial; exit 1 ;;',
      '  slow) echo start; for i in $(seq 1 40); do sleep 0.1; echo chunk; done ;;',
      '  shrink) echo start; echo 1 > "$STUB_DIR/avail"; for i in $(seq 1 40); do sleep 0.1; echo chunk; done ;;',
      '  *) echo "PGDMP-stub-archive" ;;',
      'esac',
    ].join('\n'),
  )
  // pg_restore --list: N " TABLE DATA " lines, N from $STUB_DIR/table_data (default 3).
  stub(
    'pg_restore',
    'n=$(cat "$STUB_DIR/table_data" 2>/dev/null || echo 3); for i in $(seq 1 "$n"); do echo "$i; 0 0 TABLE DATA public t$i root"; done; echo "1; 0 0 TABLE public x root"',
  )
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('v5-selfhost-pg-backup.sh core tier', () => {
  test('ok: dump verified, promoted with sha256, status ok, full unconfigured', () => {
    const r = run()
    assert.equal(r.status, 0, r.out)
    const files = backups()
    assert.equal(
      files.filter((f) => /^core-\d{8}T\d{6}Z\.dump$/.test(f)).length,
      1,
      files.join(','),
    )
    assert.equal(files.filter((f) => f.endsWith('.sha256')).length, 1)
    assert.equal(
      files.some((f) => f.endsWith('.partial')),
      false,
    )
    const s = status()
    assert.equal(s.core.result, 'ok')
    assert.equal(s.core.tableData, 3)
    assert.equal(s.core.lastOkAt, s.core.at)
    assert.ok(s.core.bytes > 0)
    assert.equal(s.full.result, 'unconfigured')
  })

  test('large session tables keep their schema but their data is excluded', () => {
    assert.equal(run().status, 0)
    const args = readFileSync(path.join(dir, 'pg_dump.args'), 'utf8').split('\n')
    for (const t of [
      'client_session_turn_tape_records',
      'client_session_live_frames',
      'client_session_turn_tape_model_records',
    ]) {
      assert.ok(args.includes(`--exclude-table-data=public.${t}`), t)
    }
    assert.ok(args.includes('-Fc'))
    assert.equal(
      args.some((a) => a.startsWith('--exclude-table=')),
      false,
    )
  })

  test('precheck: not enough room for estimate + floor -> exit 3, pg_dump never runs, old lastOkAt kept', () => {
    assert.equal(run().status, 0)
    const okAt = status().core.lastOkAt
    rmSync(path.join(dir, 'pg_dump.args'))
    setAvail(10 * GIB) // < 1 GiB estimate (first run is tiny so default) + 10 GiB floor
    const r = run(['run', '--tier', 'core'], { V5SB_CORE_EST_BYTES: String(GIB) })
    assert.equal(r.status, 3, r.out)
    assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
    const s = status()
    assert.equal(s.core.result, 'skipped_low_disk')
    assert.equal(s.core.lastOkAt, okAt)
    assert.equal(backups().filter((f) => f.endsWith('.dump')).length, 1)
  })

  test('watchdog: free space falling below the abort floor mid-dump aborts and removes the partial', () => {
    writeFileSync(path.join(dir, 'dump_mode'), 'shrink')
    const r = run(['run', '--tier', 'core'])
    assert.equal(r.status, 3, r.out)
    assert.deepEqual(backups(), [])
    assert.equal(status().core.result, 'aborted_low_disk')
  })

  test('pg_dump failure -> exit 1, nothing promoted, earlier backups untouched', () => {
    assert.equal(run().status, 0)
    const before = backups()
    writeFileSync(path.join(dir, 'dump_mode'), 'fail')
    const r = run(['run', '--tier', 'core'])
    assert.equal(r.status, 1, r.out)
    assert.deepEqual(backups(), before)
    assert.equal(status().core.result, 'dump_failed')
  })

  test('verify failure (no TABLE DATA in archive TOC) -> exit 1, file removed', () => {
    writeFileSync(path.join(dir, 'table_data'), '0')
    const r = run(['run', '--tier', 'core'])
    assert.equal(r.status, 1, r.out)
    assert.deepEqual(backups(), [])
    assert.equal(status().core.result, 'verify_failed')
  })

  test('rotation keeps the newest V5SB_KEEP core dumps and never touches other files', () => {
    const b = path.join(dir, 'backups')
    mkdirSync(b, { mode: 0o700 })
    for (const ts of ['20200101T000000Z', '20200102T000000Z', '20200103T000000Z']) {
      writeFileSync(path.join(b, `core-${ts}.dump`), 'old')
      writeFileSync(path.join(b, `core-${ts}.dump.sha256`), 'x')
    }
    writeFileSync(path.join(b, 'operator-notes.txt'), 'keep me')
    const r = run(['run', '--tier', 'core'], { V5SB_KEEP: '2' })
    assert.equal(r.status, 0, r.out)
    const dumps = backups().filter((f) => f.endsWith('.dump'))
    assert.equal(dumps.length, 2, dumps.join(','))
    assert.ok(dumps.includes('core-20200103T000000Z.dump'))
    assert.equal(dumps.includes('core-20200101T000000Z.dump'), false)
    assert.equal(existsSync(path.join(b, 'core-20200101T000000Z.dump.sha256')), false)
    assert.ok(existsSync(path.join(b, 'operator-notes.txt')))
  })

  test('a second run while one holds the backup lock exits 4 without dumping', () => {
    const lock = path.join(dir, 'run/backup.lock')
    const r = run(['run'], {}, `exec 8>"${lock}"; flock 8`)
    assert.equal(r.status, 4, r.out)
    assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
  })

  test('deploy lock busy past the wait budget -> no dump, status skipped_deploy_busy', () => {
    const lock = path.join(dir, 'run/deploy.lock')
    writeFileSync(lock, '')
    const r = run(['run'], {}, `exec 8<>"${lock}"; flock 8`)
    assert.equal(r.status, 1, r.out)
    assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
    assert.equal(status().core.result, 'skipped_deploy_busy')
  })
})

describe('v5-selfhost-pg-backup.sh full tier', () => {
  test('streams the dump to the sink with a full-*.dump name and never writes it locally', () => {
    stub('sink', 'cat > "$STUB_DIR/sink.out"; printf "%s" "$1" > "$STUB_DIR/sink.name"')
    const r = run(['run'], { V5SB_FULL_SINK: path.join(dir, 'bin/sink') })
    assert.equal(r.status, 0, r.out)
    assert.match(readFileSync(path.join(dir, 'sink.name'), 'utf8'), /^full-\d{8}T\d{6}Z\.dump$/)
    assert.match(readFileSync(path.join(dir, 'sink.out'), 'utf8'), /PGDMP-stub-archive/)
    assert.equal(
      backups().some((f) => f.startsWith('full-')),
      false,
    )
    // the full dump has no table-data exclusions
    const args = readFileSync(path.join(dir, 'pg_dump.args'), 'utf8')
    assert.equal(args.includes('--exclude-table-data'), false)
    assert.equal(status().full.result, 'ok')
  })

  test('sink failure -> exit 1 and status failed, core result still ok', () => {
    stub('sink', 'cat >/dev/null; exit 7')
    const r = run(['run'], { V5SB_FULL_SINK: path.join(dir, 'bin/sink') })
    assert.equal(r.status, 1, r.out)
    const s = status()
    assert.equal(s.full.result, 'failed')
    assert.match(s.full.reason, /sink=7/)
    assert.equal(s.core.result, 'ok')
  })
})

describe('v5-selfhost-pg-backup.sh cli and units', () => {
  test('status is read-only and prints a placeholder before any run', () => {
    const r = run(['status'])
    assert.equal(r.status, 0)
    assert.match(r.out, /"core":null/)
    assert.equal(existsSync(path.join(dir, 'backups')), false)
  })

  test('unknown command and bad tier exit 2', () => {
    assert.equal(run(['nope']).status, 2)
    assert.equal(run(['run', '--tier', 'x']).status, 2)
  })

  test('service runs from the live release, alerts on failure, and the timer is persistent', () => {
    const svc = readFileSync(
      path.join(root, 'deploy/v5-selfhost/openclaude-v5-selfhost-pg-backup.service'),
      'utf8',
    )
    assert.match(
      svc,
      /^ExecStart=\/opt\/openclaude\/openclaude-v5-selfhost-live\/scripts\/v5-selfhost-pg-backup\.sh run$/m,
    )
    assert.match(svc, /^OnFailure=openclaude-v5-selfhost-watch-alert@%n\.service$/m)
    assert.match(svc, /^EnvironmentFile=-\/etc\/openclaude\/selfhost-pg-backup\.env$/m)
    const timer = readFileSync(
      path.join(root, 'deploy/v5-selfhost/openclaude-v5-selfhost-pg-backup.timer'),
      'utf8',
    )
    assert.match(timer, /^Persistent=true$/m)
    assert.match(timer, /^OnCalendar=/m)
  })
})

// Review r1 (g443-review-r1.txt) regressions: each case is one P1.
describe('v5-selfhost-pg-backup.sh review r1 hardening', () => {
  test('a failing promote (mv) is reported as failure, never ok', () => {
    // only the promote of the .partial fails; status writes still work
    stub('mv', 'if [[ "$*" == *.partial* ]]; then exit 1; fi; exec /usr/bin/mv "$@"')
    const r = run(['run', '--tier', 'core'])
    assert.equal(r.status, 1, r.out)
    assert.equal(status().core.result, 'promote_failed')
    assert.equal(status().core.lastOkAt, undefined)
    assert.equal(
      backups().some((f) => /\.dump$/.test(f)),
      false,
    )
  })

  test('a failing sha256 is reported as failure and the partial is dropped', () => {
    stub('sha256sum', 'exit 1')
    const r = run(['run', '--tier', 'core'])
    assert.equal(r.status, 1, r.out)
    assert.equal(status().core.result, 'hash_failed')
    assert.deepEqual(backups(), [])
  })

  test('rotation ignores names with newlines and anything not core-<UTC>.dump', () => {
    const b = path.join(dir, 'backups')
    mkdirSync(b, { mode: 0o700 })
    const tricky = 'core-\noperator-notes.txt\nx.dump'
    writeFileSync(path.join(b, tricky), 'x')
    writeFileSync(path.join(b, 'operator-notes.txt'), 'keep me')
    writeFileSync(path.join(b, 'core-20200101T000000Z.dump'), 'old')
    const r = run(['run', '--tier', 'core'], { V5SB_KEEP: '1' })
    assert.equal(r.status, 0, r.out)
    const files = backups()
    assert.ok(files.includes(tricky), files.join(','))
    assert.ok(files.includes('operator-notes.txt'))
    assert.equal(files.includes('core-20200101T000000Z.dump'), false)
    assert.equal(files.filter((f) => /^core-\d{8}T\d{6}Z\.dump$/.test(f)).length, 1)
  })

  test('a pre-planted link at the dump path is refused and its target is not written', () => {
    stub(
      'date',
      'if [[ "$*" == "-u +%Y%m%dT%H%M%SZ" ]]; then echo 20261016T000000Z; else exec /usr/bin/date "$@"; fi',
    )
    const b = path.join(dir, 'backups')
    mkdirSync(b, { mode: 0o700 })
    const victim = path.join(dir, 'victim.txt')
    writeFileSync(victim, 'precious')
    symlinkSync(victim, path.join(b, 'core-20261016T000000Z.dump.partial'))
    const r = run(['run', '--tier', 'core'])
    assert.equal(r.status, 1, r.out)
    assert.equal(status().core.result, 'path_exists')
    assert.equal(readFileSync(victim, 'utf8'), 'precious')
  })

  test('a backup dir that is a symlink is refused', () => {
    const real = path.join(dir, 'elsewhere')
    mkdirSync(real)
    symlinkSync(real, path.join(dir, 'backups'))
    const r = run(['run', '--tier', 'core'])
    assert.equal(r.status, 1, r.out)
    assert.equal(status().core.result, 'dir_unsafe')
    assert.deepEqual(readdirSync(real), [])
  })

  test('free space is re-checked after pg_dump exits (drop between samples)', () => {
    // first sample (t=0) sees plenty; the drop happens inside the 5 s sleep, then pg_dump exits
    stub('pg_dump', 'sleep 0.5; echo archive; echo 1 > "$STUB_DIR/avail"; exit 0')
    const r = run(['run', '--tier', 'core'], { V5SB_WATCH_INTERVAL: '5' })
    assert.equal(r.status, 3, r.out)
    assert.equal(status().core.result, 'aborted_low_disk')
    assert.match(status().core.reason, /after dump/)
    assert.deepEqual(backups(), [])
  })

  test('drill refuses on low disk before creating any database', () => {
    assert.equal(run().status, 0)
    stub('psql', 'printf "%s\\n" "$*" >> "$STUB_DIR/psql.log"')
    setAvail(10 * GIB)
    const r = run(['drill'], { V5SB_PG_DATA_PATH: dir })
    assert.equal(r.status, 3, r.out)
    assert.equal(existsSync(path.join(dir, 'psql.log')), false)
  })

  test('a failing status write keeps the previous status and fails the run', () => {
    assert.equal(run().status, 0)
    const before = readFileSync(path.join(dir, 'state/status.json'), 'utf8')
    stub('failpy', 'cat >/dev/null; exit 1')
    const r = run(['run', '--tier', 'core'], { V5SB_STATUS_PY: path.join(dir, 'bin/failpy') })
    assert.notEqual(r.status, 0, r.out)
    assert.equal(readFileSync(path.join(dir, 'state/status.json'), 'utf8'), before)
    assert.deepEqual(
      readdirSync(path.join(dir, 'state')).filter((f) => f.startsWith('.pg-backup-status.')),
      [],
    )
  })

  test('a second run in the same UTC second waits for a fresh name instead of failing', () => {
    // the first two stamp calls return the same second, the third the next one
    stub(
      'date',
      'if [[ "$*" == "-u +%Y%m%dT%H%M%SZ" ]]; then n=$(cat "$STUB_DIR/datecount" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB_DIR/datecount"; if (( n < 2 )); then echo 20261016T000000Z; else echo 20261016T000001Z; fi; else exec /usr/bin/date "$@"; fi',
    )
    assert.equal(run(['run', '--tier', 'core']).status, 0)
    const r = run(['run', '--tier', 'core'])
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(
      backups().filter((f) => f.endsWith('.dump')),
      ['core-20261016T000000Z.dump', 'core-20261016T000001Z.dump'],
    )
  })

  test('bad knobs and a relative backup dir are usage errors', () => {
    assert.equal(run(['run'], { V5SB_KEEP: '0' }).status, 2)
    assert.equal(run(['run'], { V5SB_MIN_FREE_GIB: 'x' }).status, 2)
    assert.equal(run(['run'], { V5SB_DIR: 'relative/dir' }).status, 2)
    assert.equal(run(['run'], { V5SB_DIR: '/' }).status, 2)
  })
})
