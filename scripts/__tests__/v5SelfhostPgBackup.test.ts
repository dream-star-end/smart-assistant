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

  test('services run from the live release, alert on failure, and the timers are persistent', () => {
    // OCV5-600: core daily, full weekly (a full run every day would not fit the off-host bucket)
    for (const [unit, tier, calendar] of [
      ['openclaude-v5-selfhost-pg-backup', 'core', /^OnCalendar=\*-\*-\* /m],
      // steward 2026-10-23: weekly full at night low traffic
      [
        'openclaude-v5-selfhost-pg-backup-full',
        'full',
        /^OnCalendar=Sun \*-\*-\* 04:00:00 Asia\/Taipei$/m,
      ],
    ] as const) {
      const svc = readFileSync(path.join(root, `deploy/v5-selfhost/${unit}.service`), 'utf8')
      assert.match(
        svc,
        new RegExp(
          `^ExecStart=/opt/openclaude/openclaude-v5-selfhost-live/scripts/v5-selfhost-pg-backup\\.sh run --tier ${tier}$`,
          'm',
        ),
      )
      assert.match(svc, /^OnFailure=openclaude-v5-selfhost-watch-alert@%n\.service$/m)
      assert.match(svc, /^EnvironmentFile=-\/etc\/openclaude\/selfhost-pg-backup\.env$/m)
      const timer = readFileSync(path.join(root, `deploy/v5-selfhost/${unit}.timer`), 'utf8')
      assert.match(timer, /^Persistent=true$/m)
      assert.match(timer, calendar)
      assert.match(timer, new RegExp(`^Unit=${unit}\\.service$`, 'm'))
    }
    const full = readFileSync(
      path.join(root, 'deploy/v5-selfhost/openclaude-v5-selfhost-pg-backup-full.service'),
      'utf8',
    )
    assert.match(full, /^Environment=V5SB_LOCK_WAIT_SEC=\d+$/m)
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

// OCV5-600: scripts/v5-selfhost-pg-backup-r2.sh (encrypted off-host copies on R2) and the
// V5SB_OFFSITE hooks. rclone keeps "objects" in the temp dir, gpg only prefixes a marker,
// psql prints a size from a file: no bucket, key or database is touched.
describe('off-host copies on R2 (V5SB_OFFSITE)', () => {
  const r2 = path.join(root, 'scripts/v5-selfhost-pg-backup-r2.sh')
  const FPR = '818A5364333BDAE64CDE84916203CFEA2A840A7A'

  /** Put an object into the fake bucket (path relative to the bucket root). */
  function putObject(rel: string, bytes: number) {
    const p = path.join(dir, 'bucket', rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, 'x'.repeat(bytes))
  }

  function objects(sub: string): string[] {
    const d = path.join(dir, 'bucket', 'pg', sub)
    return existsSync(d) ? readdirSync(d).sort() : []
  }

  function rcloneLog(): string[] {
    const p = path.join(dir, 'rclone.log')
    return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n') : []
  }

  function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      HOME: dir,
      STUB_DIR: dir,
      V5SB_PG_AS: '',
      V5SB_RCLONE: path.join(dir, 'bin/rclone'),
      V5SB_GPG: path.join(dir, 'bin/gpg'),
      V5SB_PSQL: path.join(dir, 'bin/psql'),
      V5SB_R2_RCLONE_CONF: path.join(dir, 'rclone.conf'),
      V5SB_R2_GPG_HOME: path.join(dir, 'gnupg'),
      V5SB_R2_GPG_RECIPIENT: FPR,
      V5SB_R2_STATE: path.join(dir, 'state/r2.json'),
      V5SB_R2_CAP_BYTES: '10000',
      V5SB_R2_WARN_BYTES: '9000',
      ...extra,
    }
  }

  function runR2(args: string[], extra: Record<string, string> = {}, input = '') {
    const r = spawnSync('bash', [r2, ...args], {
      env: baseEnv(extra),
      input,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  function runBackup(args: string[], extra: Record<string, string> = {}) {
    const env = baseEnv({
      V5SB_DIR: path.join(dir, 'backups'),
      V5SB_STATUS: path.join(dir, 'state/status.json'),
      V5SB_LOCK: path.join(dir, 'run/backup.lock'),
      V5SB_DEPLOY_LOCK: path.join(dir, 'run/deploy.lock'),
      V5SB_DEPLOY_WAIT_SEC: '0',
      V5SB_WATCH_INTERVAL: '0.1',
      V5SB_CORE_EST_BYTES: String(GIB),
      V5SB_FULL_SINK: '',
      V5SB_OFFSITE: r2,
      ...extra,
    })
    const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8', timeout: 30_000 })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  function writeState(bytes: number, dbBytes: number, compress = 'zstd:3') {
    mkdirSync(path.join(dir, 'state'), { recursive: true })
    writeFileSync(
      path.join(dir, 'state/r2.json'),
      JSON.stringify({
        lastFullBytes: bytes,
        lastFullDbBytes: dbBytes,
        lastFullCompress: compress,
      }),
    )
  }

  beforeEach(() => {
    mkdirSync(path.join(dir, 'bucket'))
    writeFileSync(path.join(dir, 'rclone.conf'), '[r2]\ntype = local\n')
    writeFileSync(path.join(dir, 'dbsize'), '20000')
    // rclone: objects are files under $STUB_DIR/bucket; "r2:<bucket>/<key>" maps to bucket/<key>.
    // rcat writes to a temp file outside the bucket and renames at EOF, so a killed upload
    // leaves no object. $STUB_DIR/rclone_fail=<subcommand> makes that subcommand fail.
    stub(
      'rclone',
      [
        'args=()',
        'while (($#)); do case "$1" in',
        '  --config|--s3-chunk-size|--max-transfer|--cutoff-mode|-o) shift 2 ;;',
        '  -R|--files-only) shift ;;',
        '  *) args+=("$1"); shift ;;',
        'esac; done',
        'printf "%s\\n" "${args[*]}" >> "$STUB_DIR/rclone.log"',
        'sub=${args[0]}; rest=${args[1]#*:}',
        'if [[ "$rest" == */* ]]; then key=${rest#*/}; else key=""; fi',
        'B="$STUB_DIR/bucket"',
        '[[ "$(cat "$STUB_DIR/rclone_fail" 2>/dev/null)" == "$sub" ]] && { cat >/dev/null; exit 9; }',
        'case "$sub" in',
        "  lsjson) python3 -c '",
        'import json, os, sys',
        'b, key = sys.argv[1], sys.argv[2]',
        'out = []',
        'if key:',
        '    p = os.path.join(b, key)',
        '    if os.path.isfile(p): out.append({"Path": os.path.basename(p), "Size": os.path.getsize(p)})',
        'else:',
        '    for d, _, fs in os.walk(b):',
        '        for f in fs:',
        '            p = os.path.join(d, f)',
        '            out.append({"Path": os.path.relpath(p, b), "Size": os.path.getsize(p)})',
        'print(json.dumps(out))',
        '\' "$B" "$key" ;;',
        '  deletefile) [[ -f "$B/$key" ]] || exit 4; rm -f -- "$B/$key" ;;',
        '  rcat) t="$STUB_DIR/rcat.$$"; cat > "$t" || exit 1; mkdir -p "$(dirname "$B/$key")"; mv "$t" "$B/$key" ;;',
        // multipart uploads: $STUB_DIR/multipart holds the list-multipart-uploads JSON;
        // cleanup empties it unless $STUB_DIR/cleanup_noop (an abort that fails silently).
        '  backend) case "${args[1]}" in',
        '    cleanup) [[ -f "$STUB_DIR/cleanup_noop" ]] || echo \'{"ocv5-personal-backup": []}\' > "$STUB_DIR/multipart" ;;',
        '    list-multipart-uploads) cat "$STUB_DIR/multipart" 2>/dev/null || echo \'{"ocv5-personal-backup": []}\' ;;',
        '    *) exit 2 ;;',
        '  esac ;;',
        '  *) exit 2 ;;',
        'esac',
      ].join('\n'),
    )
    // gpg: record args, prefix a marker so "encrypted" output is recognisable.
    stub(
      'gpg',
      'printf "%s\\n" "$@" > "$STUB_DIR/gpg.args"; [[ -f "$STUB_DIR/gpg_fail" ]] && exit 2; printf "GPG:"; cat',
    )
    stub('psql', 'cat "$STUB_DIR/dbsize"')
    // pg_dump with two more modes than the file-level stub
    stub(
      'pg_dump',
      [
        'printf "%s\\n" "$@" > "$STUB_DIR/pg_dump.args"',
        'mode=$(cat "$STUB_DIR/dump_mode" 2>/dev/null || echo ok)',
        'case "$mode" in',
        '  fail) echo partial; exit 1 ;;',
        '  big) head -c 50000 /dev/zero ;;',
        // can a deploy take its lock while the dump runs?
        '  probe) if flock -n -x "$STUB_DIR/run/deploy.lock" true; then echo free; else echo held; fi > "$STUB_DIR/probe"; cat "$STUB_DIR/run/deploy.lock.backup" > "$STUB_DIR/marker" 2>/dev/null; echo PGDMP ;;',
        '  *) echo "PGDMP-stub-archive" ;;',
        'esac',
      ].join('\n'),
    )
  })

  describe('v5-selfhost-pg-backup-r2.sh full', () => {
    test('deletes the old full copy before uploading the new one, encrypted to the recipient', () => {
      putObject('pg/full/full-20261018T131000Z.dump.gpg', 3000)
      putObject('pg/core/core-20261022T194000Z.dump.gpg', 100)
      const r = runR2(['full', 'full-20261025T131000Z.dump'], {}, 'PGDMP-archive')
      assert.equal(r.status, 0, r.out)
      assert.deepEqual(objects('full'), ['full-20261025T131000Z.dump.gpg'])
      assert.deepEqual(objects('core'), ['core-20261022T194000Z.dump.gpg'])
      const body = readFileSync(
        path.join(dir, 'bucket/pg/full/full-20261025T131000Z.dump.gpg'),
        'utf8',
      )
      assert.equal(body, 'GPG:PGDMP-archive')
      const log = rcloneLog()
      const del = log.findIndex((l) => l.startsWith('deletefile') && l.includes('full-20261018'))
      const put = log.findIndex((l) => l.startsWith('rcat'))
      assert.ok(del >= 0 && put > del, log.join('\n'))
      const gpgArgs = readFileSync(path.join(dir, 'gpg.args'), 'utf8').split('\n')
      assert.ok(gpgArgs.includes('--encrypt') && gpgArgs.includes(FPR))
      assert.ok(gpgArgs.includes('--compress-algo'))
      const st = JSON.parse(readFileSync(path.join(dir, 'state/r2.json'), 'utf8'))
      assert.equal(st.lastFullBytes, body.length)
      assert.equal(st.lastFullDbBytes, 20000)
      assert.equal(st.lastFullCompress, 'zstd:3')
    })

    test('a stream that would pass the cap is killed before the object completes', () => {
      putObject('pg/full/full-20261018T131000Z.dump.gpg', 3000)
      putObject('pg/core/core-20261022T194000Z.dump.gpg', 2000)
      // cap 10000, core 2000 -> room 8000; the stream is 20000 bytes
      const r = runR2(['full', 'full-20261025T131000Z.dump'], {}, 'y'.repeat(20000))
      assert.equal(r.status, 3, r.out)
      assert.match(r.out, /ABORT over cap/)
      assert.deepEqual(objects('full'), [])
      assert.deepEqual(objects('core'), ['core-20261022T194000Z.dump.gpg'])
      assert.equal(existsSync(path.join(dir, 'state/r2.json')), false)
      // the killed upload's parts are aborted right away, and were before it started (Codex r1 P1)
      const log = rcloneLog()
      const put = log.findIndex((l) => l.startsWith('rcat'))
      const cleanups = log.flatMap((l, i) => (l.startsWith('backend cleanup') ? [i] : []))
      assert.ok(cleanups.some((i) => i < put) && cleanups.some((i) => i > put), log.join('\n'))
    })

    test('a cleanup that exits 0 but leaves uploads behind still stops the command (Codex r2 P1)', () => {
      writeFileSync(path.join(dir, 'cleanup_noop'), '')
      writeFileSync(
        path.join(dir, 'multipart'),
        JSON.stringify({ 'ocv5-personal-backup': [{ Key: 'pg/full/x.gpg', UploadId: 'u1' }] }),
      )
      const r = runR2(['precheck'])
      assert.equal(r.status, 1, r.out)
      assert.match(r.out, /still present after cleanup: 1/)
      assert.equal(runR2(['full', 'full-20261025T131000Z.dump'], {}, 'a').status, 1)
      assert.deepEqual(objects('full'), [])
      rmSync(path.join(dir, 'cleanup_noop'))
      assert.equal(runR2(['precheck']).status, 0)
    })

    test('a failing multipart cleanup stops every command before it writes', () => {
      writeFileSync(path.join(dir, 'rclone_fail'), 'backend')
      putObject('pg/full/full-20261018T131000Z.dump.gpg', 3000)
      assert.equal(runR2(['precheck']).status, 1)
      assert.equal(runR2(['full', 'full-20261025T131000Z.dump'], {}, 'a').status, 1)
      assert.deepEqual(objects('full'), ['full-20261018T131000Z.dump.gpg'])
      mkdirSync(path.join(dir, 'backups'))
      const f = path.join(dir, 'backups/core-20261023T194000Z.dump')
      writeFileSync(f, 'PGDMP-core')
      assert.equal(runR2(['core', f]).status, 1)
      assert.deepEqual(objects('core'), [])
    })

    test('a bucket total above the warning line after the upload exits 5', () => {
      putObject('pg/core/core-20261022T194000Z.dump.gpg', 8990)
      const r = runR2(['full', 'full-20261025T131000Z.dump'], {}, 'z'.repeat(500))
      assert.equal(r.status, 5, r.out)
      assert.match(r.out, /WARN bucket total=9494/)
      assert.deepEqual(objects('full'), ['full-20261025T131000Z.dump.gpg'])
    })

    test('a failed upload leaves no object and exits 1', () => {
      writeFileSync(path.join(dir, 'rclone_fail'), 'rcat')
      const r = runR2(['full', 'full-20261025T131000Z.dump'], {}, 'PGDMP-archive')
      assert.equal(r.status, 1, r.out)
      assert.deepEqual(objects('full'), [])
    })

    test('discard-full drops the copy and the size state', () => {
      putObject('pg/full/full-20261025T131000Z.dump.gpg', 10)
      writeState(10, 20000)
      const r = runR2(['discard-full', 'full-20261025T131000Z.dump'])
      assert.equal(r.status, 0, r.out)
      assert.deepEqual(objects('full'), [])
      assert.equal(existsSync(path.join(dir, 'state/r2.json')), false)
    })
  })

  describe('v5-selfhost-pg-backup-r2.sh precheck', () => {
    test('skips when the estimate scaled by database growth does not fit', () => {
      writeState(8000, 20000)
      writeFileSync(path.join(dir, 'dbsize'), '24000') // 8000 * 1.2 * 1.05 = 10080 > 10000
      const r = runR2(['precheck'])
      assert.equal(r.status, 3, r.out)
      assert.match(r.out, /precheck SKIP estimate=10080 > room=10000/)
    })

    test('real sizes do not overflow the estimate (Codex r1 P1)', () => {
      // 8e9 x 24e9 does not fit 64-bit shell arithmetic
      writeState(8_000_000_000, 20_000_000_000)
      writeFileSync(path.join(dir, 'dbsize'), '24000000000')
      const r = runR2(['precheck'], {
        V5SB_R2_CAP_BYTES: '9500000000',
        V5SB_R2_WARN_BYTES: '9000000000',
      })
      assert.equal(r.status, 3, r.out)
      assert.match(r.out, /precheck SKIP estimate=10080000000 > room=9500000000/)
    })

    test('the old full copy does not count against the room (it is deleted first)', () => {
      writeState(8000, 20000)
      putObject('pg/full/full-20261018T131000Z.dump.gpg', 8000)
      putObject('pg/core/core-20261022T194000Z.dump.gpg', 1000)
      const r = runR2(['precheck']) // estimate 8400, room 10000 - 1000
      assert.equal(r.status, 0, r.out)
      putObject('pg/core/core-20261023T194000Z.dump.gpg', 700) // room 8300 < 8400
      assert.equal(runR2(['precheck']).status, 3)
    })

    test('a changed compression level makes the old size unknown, so precheck lets it run', () => {
      writeState(8000, 20000)
      writeFileSync(path.join(dir, 'dbsize'), '24000')
      const r = runR2(['precheck'], { V5SB_FULL_COMPRESS: 'zstd:9' })
      assert.equal(r.status, 0, r.out)
    })
  })

  describe('v5-selfhost-pg-backup-r2.sh core and config', () => {
    test('uploads the core dump and keeps the newest V5SB_R2_CORE_KEEP copies', () => {
      for (const d of ['20261020', '20261021', '20261022']) {
        putObject(`pg/core/core-${d}T194000Z.dump.gpg`, 10)
      }
      mkdirSync(path.join(dir, 'backups'))
      const f = path.join(dir, 'backups/core-20261023T194000Z.dump')
      writeFileSync(f, 'PGDMP-core')
      const r = runR2(['core', f], { V5SB_R2_CORE_KEEP: '2' })
      assert.equal(r.status, 0, r.out)
      assert.deepEqual(objects('core'), [
        'core-20261022T194000Z.dump.gpg',
        'core-20261023T194000Z.dump.gpg',
      ])
    })

    test('core is skipped when it would pass the cap', () => {
      putObject('pg/full/full-20261018T131000Z.dump.gpg', 9900)
      mkdirSync(path.join(dir, 'backups'))
      const f = path.join(dir, 'backups/core-20261023T194000Z.dump')
      writeFileSync(f, 'x'.repeat(200))
      const r = runR2(['core', f])
      assert.equal(r.status, 3, r.out)
      assert.deepEqual(objects('core'), [])
    })

    test('missing recipient, bad names and bad knobs are usage errors', () => {
      assert.equal(runR2(['precheck'], { V5SB_R2_GPG_RECIPIENT: '' }).status, 2)
      assert.equal(runR2(['full', '../x'], {}, 'a').status, 2)
      assert.equal(runR2(['core', path.join(dir, 'rclone.conf')]).status, 2)
      assert.equal(runR2(['precheck'], { V5SB_R2_WARN_BYTES: '20000' }).status, 2)
      assert.equal(runR2(['precheck'], { V5SB_R2_CAP_BYTES: '09500' }).status, 2)
      assert.equal(runR2(['nope']).status, 2)
    })
  })

  describe('v5-selfhost-pg-backup.sh with V5SB_OFFSITE', () => {
    test('full tier: precheck, then the dump streams to R2 at V5SB_FULL_COMPRESS', () => {
      const r = runBackup(['run', '--tier', 'full'], { V5SB_FULL_COMPRESS: 'zstd:9' })
      assert.equal(r.status, 0, r.out)
      const full = objects('full')
      assert.equal(full.length, 1)
      assert.match(full[0], /^full-\d{8}T\d{6}Z\.dump\.gpg$/)
      const args = readFileSync(path.join(dir, 'pg_dump.args'), 'utf8').split('\n')
      assert.equal(args[args.indexOf('-Z') + 1], 'zstd:9')
      assert.equal(status().full.result, 'ok')
    })

    test('full tier: a precheck skip exits 3 without running pg_dump', () => {
      writeState(9000, 10000)
      const r = runBackup(['run', '--tier', 'full'])
      assert.equal(r.status, 3, r.out)
      assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
      assert.equal(status().full.result, 'skipped_over_cap')
    })

    test('full tier: a stream over the cap is reported as aborted_over_cap', () => {
      writeFileSync(path.join(dir, 'dump_mode'), 'big')
      const r = runBackup(['run', '--tier', 'full'])
      assert.equal(r.status, 3, r.out)
      assert.equal(status().full.result, 'aborted_over_cap')
      assert.deepEqual(objects('full'), [])
    })

    test('full tier: a failed pg_dump has the truncated copy discarded', () => {
      writeFileSync(path.join(dir, 'dump_mode'), 'fail')
      const r = runBackup(['run', '--tier', 'full'])
      assert.equal(r.status, 1, r.out)
      assert.equal(status().full.result, 'failed')
      assert.deepEqual(objects('full'), [])
    })

    test('core tier: the verified dump also goes to R2', () => {
      const r = runBackup(['run', '--tier', 'core'])
      assert.equal(r.status, 0, r.out)
      assert.equal(objects('core').length, 1)
      assert.equal(status().core.result, 'ok')
      assert.equal(status().coreOffsite.result, 'ok')
    })

    test('core tier: a failed upload fails the run but keeps the local core ok', () => {
      writeFileSync(path.join(dir, 'rclone_fail'), 'rcat')
      const r = runBackup(['run', '--tier', 'core'])
      assert.equal(r.status, 1, r.out)
      assert.equal(status().core.result, 'ok')
      assert.equal(status().coreOffsite.result, 'failed')
      assert.equal(
        readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.dump')).length,
        1,
      )
    })

    test('the deploy lock is held (shared) for the whole dump, so a train cannot start mid-dump', () => {
      writeFileSync(path.join(dir, 'run/deploy.lock'), '')
      writeFileSync(path.join(dir, 'dump_mode'), 'probe')
      for (const tier of ['full', 'core']) {
        const r = runBackup(['run', '--tier', tier])
        assert.equal(r.status, 0, r.out)
        assert.equal(readFileSync(path.join(dir, 'probe'), 'utf8').trim(), 'held', tier)
        // while it runs, the backup names itself next to the lock; gone afterwards
        assert.match(
          readFileSync(path.join(dir, 'marker'), 'utf8'),
          new RegExp(`^pid=\\d+ starttime=\\d+ tier=${tier} started=`),
        )
        assert.equal(existsSync(path.join(dir, 'run/deploy.lock.backup')), false, tier)
      }
    })

    test('V5SB_LOCK_WAIT_SEC waits for a running backup instead of exiting 4', () => {
      const lock = path.join(dir, 'run/backup.lock')
      for (const [wait, want] of [
        ['0', 4],
        ['15', 0],
      ] as const) {
        const r = spawnSync(
          'bash',
          [
            '-c',
            '( flock -x 9; sleep 2 ) 9>"$LOCKF" & sleep 0.5; bash "$0" run --tier core; rc=$?; wait; exit $rc',
            script,
          ],
          {
            env: {
              ...process.env,
              PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
              LOCKF: lock,
              STUB_DIR: dir,
              V5SB_PG_AS: '',
              V5SB_DIR: path.join(dir, 'backups'),
              V5SB_STATUS: path.join(dir, 'state/status.json'),
              V5SB_LOCK: lock,
              V5SB_DEPLOY_LOCK: path.join(dir, 'run/deploy.lock'),
              V5SB_DEPLOY_WAIT_SEC: '0',
              V5SB_WATCH_INTERVAL: '0.1',
              V5SB_CORE_EST_BYTES: String(GIB),
              V5SB_FULL_SINK: '',
              V5SB_LOCK_WAIT_SEC: wait,
            },
            encoding: 'utf8',
            timeout: 30_000,
          },
        )
        assert.equal(r.status, want, `${wait}: ${r.stdout}${r.stderr}`)
      }
    })

    test('V5SB_OFFSITE and V5SB_FULL_SINK together are a usage error', () => {
      stub('sink', 'cat >/dev/null')
      const r = runBackup(['run'], { V5SB_FULL_SINK: path.join(dir, 'bin/sink') })
      assert.equal(r.status, 2, r.out)
    })
  })
})

// OCV5-600 (steward): deploy waits behind a running backup instead of timing out.
// The real lock functions are cut out of deploy-v5-selfhost.sh and run against a real
// shared flock held by a fake backup process (cmdline names the backup script).
describe('deploy-v5-selfhost.sh lock wait with a backup holding the lock', () => {
  const deploy = path.join(root, 'scripts/deploy-v5-selfhost.sh')

  function extract(name: string): string {
    const lines = readFileSync(deploy, 'utf8').split('\n')
    const start = lines.findIndex((l) => l.startsWith(`${name}() {`))
    assert.ok(start >= 0, name)
    for (let end = start + 1; end <= lines.length; end++) {
      if (lines[end - 1].trim() !== '}') continue
      const body = `${lines.slice(start, end).join('\n')}\n`
      if (spawnSync('bash', ['-n'], { input: body }).status === 0) return body
    }
    throw new Error(`function not found: ${name}`)
  }

  function acquire(opts: {
    marker: 'backup' | 'none' | 'stale'
    hold: number
    backupWait: number | string
  }) {
    const lib = path.join(dir, 'acquire.sh')
    writeFileSync(
      lib,
      ['proc_starttime_of', 'selfhost_backup_lock_holder', 'acquire_selfhost_deploy_lock']
        .map(extract)
        .join('\n'),
    )
    mkdirSync(path.join(dir, 'fake'), { recursive: true })
    const fake = path.join(dir, 'fake/v5-selfhost-pg-backup.sh')
    writeFileSync(
      fake,
      [
        'exec 7<"$1"; flock -s 7',
        "st=$(awk '{print $22}' /proc/$$/stat)",
        '[[ "$3" == stale ]] && st=1',
        '[[ "$3" != none ]] && printf "pid=%s starttime=%s tier=full started=x\\n" $$ "$st" > "$1.backup"',
        'sleep "$2"',
      ].join('\n'),
    )
    const lock = path.join(dir, 'run/deploy.lock')
    writeFileSync(lock, '')
    const body = [
      'source "$LIB"',
      'log() { echo "LOG $*"; }; die() { echo "DIE $*"; exit 1; }',
      'selfhost_lock_py() { case "$1" in prepare) : >"$2" ;; esac; }',
      'release_policy_mutation_barrier() { :; }',
      'selfhost_lock_holder_info() { echo "holder=x"; }',
      'SELFHOST_DEPLOY_LOCK_DIR="$(dirname "$LOCKF")"; SELFHOST_DEPLOY_LOCK="$LOCKF"',
      'SELFHOST_DEPLOY_LOCK_WAIT=1; SELFHOST_DEPLOY_LOCK_POLL=1; SELFHOST_DEPLOY_LOCK_BACKUP_WAIT="$BW"',
      'unset OC_V5_SELFHOST_DEPLOY_LOCK_HELD',
      'bash "$FAKE" "$LOCKF" "$HOLD" "$MODE" & sleep 0.5',
      '( acquire_selfhost_deploy_lock && echo ACQUIRED ); rc=$?; kill %1 2>/dev/null; wait; exit $rc',
    ].join('\n')
    const r = spawnSync('bash', ['-c', body], {
      env: {
        ...process.env,
        LIB: lib,
        FAKE: fake,
        LOCKF: lock,
        HOLD: String(opts.hold),
        MODE: opts.marker,
        BW: String(opts.backupWait),
      },
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  test('a backup holding the lock: deploy says so and queues past its own timeout', () => {
    const r = acquire({ marker: 'backup', hold: 4, backupWait: 30 })
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /个人版 PG 备份占锁中\(pid=\d+ starttime=\d+ tier=full/)
    assert.match(r.out, /ACQUIRED/)
    assert.doesNotMatch(r.out, /等待 selfhost 发布锁超时/)
  })

  test('a backup holding past the backup cap fails with an explicit message', () => {
    const r = acquire({ marker: 'backup', hold: 8, backupWait: 2 })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /个人版 PG 备份占锁中,已排队 \d+s 仍未结束/)
  })

  test('a malformed backup wait is refused up front instead of waiting forever (Codex r1)', () => {
    // '08' passes a plain digit check but is invalid octal in bash arithmetic (Codex r2)
    for (const bad of ['4h', '08']) {
      const r = acquire({ marker: 'backup', hold: 8, backupWait: bad })
      assert.equal(r.status, 1, `${bad}: ${r.out}`)
      assert.match(r.out, /DIE OC_V5_SELFHOST_DEPLOY_LOCK_BACKUP_WAIT 必须是非负整数秒/)
      assert.doesNotMatch(r.out, /ACQUIRED/)
    }
  })

  test('any other holder keeps the plain timeout', () => {
    const r = acquire({ marker: 'none', hold: 8, backupWait: 30 })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /等待 selfhost 发布锁超时/)
  })

  test('a marker whose starttime does not match (PID reuse, stale file) is not trusted', () => {
    const r = acquire({ marker: 'stale', hold: 8, backupWait: 30 })
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /等待 selfhost 发布锁超时/)
    assert.doesNotMatch(r.out, /备份占锁中/)
  })
})
