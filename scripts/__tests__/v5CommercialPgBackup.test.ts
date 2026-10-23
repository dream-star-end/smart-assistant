// OCV5-600: scripts/v5-commercial-pg-backup.sh (commercial PG backup, local + encrypted copy on R2)
// against stub tools. No database, bucket, key or unit is touched: pg_dump / pg_restore / psql /
// lease verifier / systemctl / df / rclone / gpg are PATH stubs in a private temp dir; the real shared R2
// helper (scripts/v5-selfhost-pg-backup-r2.sh) runs against the stub rclone.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { qualifyBackupLease } from '../v5-commercial-pg-backup-lease'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'scripts/v5-commercial-pg-backup.sh')
const GIB = 1024 ** 3

let dir: string

function stub(name: string, body: string) {
  const p = path.join(dir, 'bin', name)
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(p, 0o755)
}

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X', 'x'].includes(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0])
  } catch { return false }
}

function objects(sub: string): string[] {
  const d = path.join(dir, 'bucket', sub)
  return existsSync(d) ? readdirSync(d).sort() : []
}

function local(): string[] {
  const d = path.join(dir, 'backups')
  return existsSync(d) ? readdirSync(d).sort() : []
}

function status(): any {
  return JSON.parse(readFileSync(path.join(dir, 'state/status.json'), 'utf8'))
}

function run(args: string[] = ['run'], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
    HOME: dir,
    STUB_DIR: dir,
    V5CB_PG_AS: '',
    V5CB_BUN: 'bash',
    V5CB_LEASE_VERIFY: path.join(dir, 'bin/lease-verify'),
    V5CB_COMMERCIAL_ENV: path.join(dir, 'commercial.env'),
    V5CB_DIR: path.join(dir, 'backups'),
    V5CB_LOCK: path.join(dir, 'run/backup.lock'),
    V5CB_MARKER: path.join(dir, 'run/openclaude/pg-r2-backup.running'),
    V5CB_RUN_DIR: path.join(dir, 'run/v5'),
    V5CB_FILES_SRC: path.join(dir, 'files'),
    V5CB_STATUS: path.join(dir, 'state/status.json'),
    V5CB_POLL_SEC: '1',
    V5CB_FILE_BACKUP_WAIT_SEC: '5',
    V5SB_RCLONE: path.join(dir, 'bin/rclone'),
    V5SB_GPG: path.join(dir, 'bin/gpg'),
    V5SB_R2_RCLONE_CONF: path.join(dir, 'rclone.conf'),
    V5SB_R2_GPG_HOME: path.join(dir, 'gnupg'),
    V5SB_R2_GPG_RECIPIENT: '818A5364333BDAE64CDE84916203CFEA2A840A7A',
    V5SB_R2_STATE: path.join(dir, 'state/r2.json'),
    V5SB_R2_CAP_BYTES: '100000',
    V5SB_R2_WARN_BYTES: '90000',
    ...extra,
  }
  const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ocv5-600-commercial-pgbackup-'))
  for (const d of ['bin', 'run/v5', 'bucket', 'state', 'files/v5-20261022-200001Z']) {
    mkdirSync(path.join(dir, d), { recursive: true })
  }
  writeFileSync(path.join(dir, 'files/v5-20261022-200001Z/sessions.db'), 'sqlite')
  writeFileSync(path.join(dir, 'commercial.env'), '', { mode: 0o600 })
  stub('lease-verify', '[[ ! -f "$STUB_DIR/lease_invalid" ]] || exit 1; if [[ -f "$STUB_DIR/verify_hang" && -f "$STUB_DIR/dump.pid" ]]; then sleep 30; fi')
  writeFileSync(path.join(dir, 'rclone.conf'), '[r2]\ntype = local\n')
  writeFileSync(path.join(dir, 'avail'), String(50 * GIB))
  writeFileSync(path.join(dir, 'deploy_state'), 'stable||')
  stub(
    'df',
    'printf "Filesystem 1-blocks Used Available Use%% Mounted\\n/dev/x 1 1 %s 1%% /\\n" "$(cat "$STUB_DIR/avail")"',
  )
  // pg_dump: probe mode records whether the release marker exists while the dump runs.
  stub(
    'pg_dump',
    [
      'printf "%s\\n" "$@" > "$STUB_DIR/pg_dump.args"',
      'mode=$(cat "$STUB_DIR/dump_mode" 2>/dev/null || echo ok)',
      '(( $(cat "$STUB_DIR/sc_calls" 2>/dev/null || echo 0) > $(cat "$STUB_DIR/active_polls" 2>/dev/null || echo 0) )) || { echo "dump started during file backup" >&2; exit 1; }',
      'case "$mode" in',
      '  fail) echo partial; exit 1 ;;',
      '  lose) echo $$ > "$STUB_DIR/dump.pid"; touch "$STUB_DIR/lease_invalid"; exec sleep 40 ;;',
      '  parentdie) echo $$ > "$STUB_DIR/dump.pid"; kill -KILL "$V5CB_SUPERVISOR_PID"; exec sleep 40 ;;',
      '  guarddie) echo $$ > "$STUB_DIR/dump.pid"; kill -KILL "$V5CB_GUARDIAN_PID"; exec sleep 40 ;;',
      '  waiterdie) echo $$ > "$STUB_DIR/dump.pid"; kill -KILL "$V5CB_WAITER_PID"; exec sleep 40 ;;',
      '  bodydie) echo $$ > "$STUB_DIR/dump.pid"; sleep 40 & echo $! > "$STUB_DIR/dump-child.pid"; body=$(cut -d" " -f1 "$V5CB_MARKER"); kill -KILL "${body#pid=}"; exec sleep 40 ;;',
      '  hold) echo $$ > "$STUB_DIR/dump.pid"; exec sleep 40 ;;',
      '  big) head -c 300000 /dev/zero ;;',
      '  *) cat "$STUB_DIR/run/openclaude/pg-r2-backup.running" > "$STUB_DIR/marker_during_dump" 2>/dev/null; echo "PGDMP-commercial" ;;',
      'esac',
    ].join('\n'),
  )
  stub(
    'pg_restore',
    'for i in 1 2 3; do echo "$i; 0 0 TABLE DATA public t$i root"; done; echo "1; 0 0 TABLE public x root"',
  )
  // psql: deploy_state query -> $STUB_DIR/deploy_state; pg_database_size -> 20000
  stub(
    'psql',
    'if [[ "$*" == *deploy_state* ]]; then cat "$STUB_DIR/deploy_state"; else echo 20000; fi',
  )
  // A running oneshot is activating; systemctl is-active returns 3 for it.
  stub(
    'systemctl',
    [
      'n=$(( $(cat "$STUB_DIR/sc_calls" 2>/dev/null || echo 0) + 1 )); echo $n > "$STUB_DIR/sc_calls"',
      'state=inactive; (( n <= $(cat "$STUB_DIR/active_polls" 2>/dev/null || echo 0) )) && state=activating',
      'if [[ "$1" == is-active ]]; then [[ "$state" == active ]] && exit 0; exit 3; fi',
      'echo "$state"; exit 0',
    ].join('\n'),
  )
  // rclone / gpg: same contract as the selfhost helper tests (objects are files under bucket/).
  stub(
    'rclone',
    [
      'args=()',
      'while (($#)); do case "$1" in',
      '  --config|--s3-chunk-size|--max-transfer|--cutoff-mode|-o) shift 2 ;;',
      '  -R|--files-only) shift ;;',
      '  *) args+=("$1"); shift ;;',
      'esac; done',
      'sub=${args[0]}; rest=${args[1]#*:}',
      'if [[ "$rest" == */* ]]; then key=${rest#*/}; else key=""; fi',
      'B="$STUB_DIR/bucket"',
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
      '  backend) case "${args[1]}" in',
      '    cleanup) ;;',
      `    list-multipart-uploads) echo '{"ocv5-commercial-backup": []}' ;;`,
      '    *) exit 2 ;;',
      '  esac ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'),
  )
  stub('gpg', 'printf "GPG:"; cat')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('v5-commercial-pg-backup.sh', () => {
  test('dumps locally, uploads the full copy and the file-level tarball, marker only during the run', () => {
    const r = run()
    assert.equal(r.status, 0, r.out)
    const full = local().filter((f) => /^full-\d{8}T\d{6}Z\.dump$/.test(f))
    assert.equal(full.length, 1)
    assert.ok(local().includes(`${full[0]}.sha256`))
    assert.deepEqual(objects('pg/full'), [`${full[0]}.gpg`])
    assert.deepEqual(objects('files/core'), ['core-20261022T200001Z.dump.gpg'])
    // no tarball left behind locally
    assert.equal(
      local().some((f) => f.startsWith('core-')),
      false,
    )
    assert.match(readFileSync(path.join(dir, 'marker_during_dump'), 'utf8'), /^pid=\d+ started=/)
    assert.equal(existsSync(path.join(dir, 'run/openclaude/pg-r2-backup.running')), false)
    const args = readFileSync(path.join(dir, 'pg_dump.args'), 'utf8').split('\n')
    assert.equal(args[args.indexOf('-Z') + 1], 'zstd:3')
    assert.equal(args[args.indexOf('-d') + 1], 'openclaude_commercial')
    assert.equal(status().result, 'ok')
  })

  test('an unqualified official lease stops the run before a marker or dump', () => {
    writeFileSync(path.join(dir, 'lease_invalid'), '')
    const r = run()
    assert.notEqual(r.status, 0, r.out)
    assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
    assert.equal(existsSync(path.join(dir, 'run/openclaude/pg-r2-backup.running')), false)
  })

  test('recovery and inflight markers and a non-stable deploy_state skip the run', () => {
    for (const m of ['.manual-recovery-required', '.mutation-lane-inflight']) {
      writeFileSync(path.join(dir, 'run/v5', m), '')
      assert.equal(run().status, 3, m)
      rmSync(path.join(dir, 'run/v5', m))
    }
    for (const st of ['deploying||', 'stable|A|rel-x', 'stable|A|']) {
      writeFileSync(path.join(dir, 'deploy_state'), st)
      const r = run()
      assert.equal(r.status, 3, r.out)
      assert.match(r.out, /deploy_state is/)
    }
    assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
  })

  test('lease loss during pg_dump kills the owned body and prevents all uploads', () => {
    writeFileSync(path.join(dir, 'dump_mode'), 'lose')
    const r = run()
    assert.notEqual(r.status, 0, r.out)
    const pid = Number(readFileSync(path.join(dir, 'dump.pid'), 'utf8'))
    assert.equal(alive(pid), false, `dump ${pid} survived lease loss`)
    assert.deepEqual(objects('pg/full'), [])
    assert.equal(existsSync(path.join(dir, 'run/openclaude/pg-r2-backup.running')), false)
  })

  test('a hanging qualification is bounded and cannot leave the dump running', () => {
    writeFileSync(path.join(dir, 'dump_mode'), 'hold')
    writeFileSync(path.join(dir, 'verify_hang'), '')
    const started = Date.now()
    const r = run()
    assert.notEqual(r.status, 0, r.out)
    assert.ok(Date.now() - started < 15_000, r.out)
    const pid = Number(readFileSync(path.join(dir, 'dump.pid'), 'utf8'))
    assert.equal(alive(pid), false, `dump ${pid} survived qualification timeout`)
    assert.deepEqual(objects('pg/full'), [])
  })

  for (const mode of ['parentdie', 'guarddie', 'waiterdie']) {
    test(`${mode}: the other execution supervisor kills the dump and prevents upload`, () => {
      writeFileSync(path.join(dir, 'dump_mode'), mode)
      const started = Date.now()
      const r = run()
      assert.notEqual(r.status, 0, r.out)
      assert.ok(Date.now() - started < 15_000, `orphan ran until its natural timeout: ${r.out}`)
      const pid = Number(readFileSync(path.join(dir, 'dump.pid'), 'utf8'))
      assert.equal(alive(pid), false, `dump ${pid} survived ${mode}`)
      assert.deepEqual(objects('pg/full'), [])
      assert.equal(existsSync(path.join(dir, 'run/openclaude/pg-r2-backup.running')), false)
    })
  }

  test('bodydie: clear orphaned dump descendants before releasing the backup lock', () => {
    const sentinel = spawn('sleep', ['60'], { stdio: 'ignore' })
    try {
      writeFileSync(path.join(dir, 'dump_mode'), 'bodydie')
      const started = Date.now()
      const r = run()
      assert.notEqual(r.status, 0, r.out)
      assert.ok(Date.now() - started < 15_000, `orphan ran until its natural timeout: ${r.out}`)
      for (const file of ['dump.pid', 'dump-child.pid']) {
        const pid = Number(readFileSync(path.join(dir, file), 'utf8'))
        assert.equal(alive(pid), false, `owned descendant ${pid} survived body death`)
      }
      assert.deepEqual(objects('pg/full'), [])
      assert.equal(existsSync(path.join(dir, 'run/openclaude/pg-r2-backup.running')), false)
      assert.equal(spawnSync('flock', ['-n', path.join(dir, 'run/backup.lock'), 'true']).status, 0)
      assert.ok(sentinel.pid && alive(sentinel.pid), 'unrelated sentinel was killed')
    } finally {
      sentinel.kill('SIGKILL')
    }
  })

  test('waits for the file-level backup unit, and skips when it stays active', () => {
    writeFileSync(path.join(dir, 'active_polls'), '2')
    assert.equal(run().status, 0)
    writeFileSync(path.join(dir, 'sc_calls'), '0')
    writeFileSync(path.join(dir, 'active_polls'), '100')
    const r = run(['run'], { V5CB_FILE_BACKUP_WAIT_SEC: '1' })
    assert.equal(r.status, 3, r.out)
    assert.equal(status().result, 'skipped_file_backup_busy')
  })

  test('keeps the newest two local dumps', () => {
    mkdirSync(path.join(dir, 'backups'))
    for (const d of ['20261020T203000Z', '20261021T203000Z']) {
      writeFileSync(path.join(dir, `backups/full-${d}.dump`), 'old')
      writeFileSync(path.join(dir, `backups/full-${d}.dump.sha256`), 'x')
    }
    assert.equal(run().status, 0)
    const full = local().filter((f) => f.endsWith('.dump'))
    assert.equal(full.length, 2)
    assert.equal(full[0], 'full-20261021T203000Z.dump')
    assert.equal(local().includes('full-20261020T203000Z.dump.sha256'), false)
  })

  test('an R2 cap skip keeps the local dump and exits 3', () => {
    writeFileSync(path.join(dir, 'dump_mode'), 'big')
    const r = run(['run'], { V5SB_R2_CAP_BYTES: '200000', V5SB_R2_WARN_BYTES: '190000' })
    assert.equal(r.status, 3, r.out)
    assert.equal(local().filter((f) => f.endsWith('.dump')).length, 1)
    assert.deepEqual(objects('pg/full'), [])
    assert.equal(status().r2Full, 3)
  })

  test('a failed pg_dump leaves no partial and fails', () => {
    writeFileSync(path.join(dir, 'dump_mode'), 'fail')
    const r = run()
    assert.equal(r.status, 1, r.out)
    assert.deepEqual(local(), [])
    assert.equal(status().result, 'dump_failed')
  })

  test('usage errors and the lock', () => {
    assert.equal(run(['nope']).status, 2)
    assert.equal(run(['run'], { V5CB_KEEP: '08' }).status, 2)
    assert.equal(run(['run'], { V5CB_R2: path.join(dir, 'missing') }).status, 2)
    const lock = path.join(dir, 'run/backup.lock')
    const r = spawnSync(
      'bash',
      [
        '-c',
        '( flock -x 9; sleep 2 ) 9>"$LOCKF" & sleep 0.5; bash "$0" run; rc=$?; wait; exit $rc',
        script,
      ],
      {
        env: {
          ...process.env,
          LOCKF: lock,
          V5CB_LOCK: lock,
          V5CB_R2: path.join(root, 'scripts/v5-selfhost-pg-backup-r2.sh'),
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    )
    assert.equal(r.status, 4, `${r.stdout}${r.stderr}`)
  })

  test('units: daily 04:30 Asia/Taipei, alert on failure, script from the installed copy', () => {
    const svc = readFileSync(
      path.join(root, 'deploy/v5-dev/openclaude-v5-pg-r2-backup.service'),
      'utf8',
    )
    assert.match(
      svc,
      /^ExecStart=\/opt\/openclaude\/pg-r2-backup\/current\/scripts\/v5-commercial-pg-backup-controller\.sh run$/m,
    )
    assert.match(svc, /^OnFailure=openclaude-v5-selfhost-watch-alert@%n\.service$/m)
    assert.match(svc, /^EnvironmentFile=-\/etc\/openclaude\/commercial-pg-backup-controller\.env$/m)
    const timer = readFileSync(
      path.join(root, 'deploy/v5-dev/openclaude-v5-pg-r2-backup.timer'),
      'utf8',
    )
    assert.match(timer, /^OnCalendar=\*-\*-\* 04:30:00 Asia\/Taipei$/m)
    assert.match(timer, /^Persistent=true$/m)
    assert.match(timer, /^Unit=openclaude-v5-pg-r2-backup\.service$/m)
  })
})


describe('commercial backup controller and official lease qualification', () => {
  test('a symlinked installed entrypoint refuses an invocation without a lease proof', () => {
    const link = path.join(dir, 'lease-entry.ts')
    symlinkSync(path.join(root, 'scripts/v5-commercial-pg-backup-lease.ts'), link)
    const r = spawnSync('npx', ['--no-install', 'tsx', link], {
      env: { PATH: process.env.PATH, OC_V5_MANUAL_LEASE_NONCE: '' },
      encoding: 'utf8', timeout: 20_000,
    })
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /official lease qualification failed/)
    assert.equal(r.stdout, '')
  })

  test('the official wrapper encloses the foreground dump and upload, including SSH failure', () => {
    stub('lease-wrapper', 'echo begin >> "$STUB_DIR/events"; export OC_V5_MANUAL_LEASE_NONCE=0123456789abcdef0123456789abcdef; "$@"; rc=$?; echo end >> "$STUB_DIR/events"; exit "$rc"')
    stub('ssh', '[[ "$1" == -tt ]] || exit 2; echo dump >> "$STUB_DIR/events"; echo upload >> "$STUB_DIR/events"; exit "${SSH_RC:-0}"')
    stub('queue', `echo '[{"status":"completed","task":"old active task"}]'`)
    writeFileSync(path.join(dir, 'loadavg'), '0.0 0.0 0.0 1/1 1\n')
    const controller = path.join(root, 'scripts/v5-commercial-pg-backup-controller.sh')
    const env = { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir, V5CB_CONTROLLER_QUEUE: path.join(dir, 'bin/queue'), V5CB_CONTROLLER_LOADAVG: path.join(dir, 'loadavg'), V5CB_CONTROLLER_LEASE: path.join(dir, 'bin/lease-wrapper'), V5CB_CONTROLLER_SSH: path.join(dir, 'bin/ssh') }
    let r = spawnSync('bash', [controller, 'run'], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(path.join(dir, 'events'), 'utf8'), 'begin\ndump\nupload\nend\n')
    r = spawnSync('bash', [controller, 'run'], { env: { ...env, SSH_RC: '7' }, encoding: 'utf8' })
    assert.equal(r.status, 7, r.stderr)
    const directEnv = { ...env, OC_V5_MANUAL_LEASE_NONCE: '' }
    r = spawnSync('bash', [controller, '__leased'], { env: directEnv, encoding: 'utf8' })
    assert.equal(r.status, 3, r.stderr)
    stub('queue', `echo '[{"status":"active"}]'`)
    r = spawnSync('bash', [controller, 'run'], { env, encoding: 'utf8' })
    assert.equal(r.status, 3, r.stderr)
  })

  test('actual flock, invocation, expiry and dump cluster are qualified through the existing verifier', async () => {
    const lock = path.join(dir, 'lease.lock')
    const holder = spawn('bash', ['-c', 'exec 9>"$1"; flock -x 9; echo ready; exec sleep 30', 'fixture', lock], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once('data', () => resolve())
        holder.once('error', reject)
      })
      const pid = holder.pid!
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const start = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]
      const ino = statSync(lock, { bigint: true })
      const nonce = '0123456789abcdef0123456789abcdef'
      const paths = { lock, commonNonce: path.join(dir, 'common'), manualNonce: path.join(dir, 'manual') }
      const identity = { clusterId: 'fixture', database: 'fixture', databaseOid: '1', serverAddress: '127.0.0.1', serverPort: 5432, postmasterEpoch: '1', inRecovery: false }
      const proof = { ...identity, schema: 1, nonce, holderPid: pid, holderStart: start, lockDevIno: `${ino.dev}:${ino.ino}`, expiresAt: Math.floor(Date.now() / 1000) + 30 }
      writeFileSync(paths.commonNonce, nonce, { mode: 0o600 })
      writeFileSync(paths.manualNonce, nonce, { mode: 0o600 })
      writeFileSync(`${paths.commonNonce}.db`, JSON.stringify(proof), { mode: 0o600 })
      const query = () => identity
      assert.equal((await qualifyBackupLease(nonce, {}, paths, query)).holderPid, pid)
      await assert.rejects(qualifyBackupLease('f'.repeat(32), {}, paths, query), /STALE_INVOCATION_NONCE/)
      await assert.rejects(qualifyBackupLease(nonce, {}, paths, (_sql, _env, local) => local ? { ...identity, clusterId: 'other' } : identity), /DUMP_PRIMARY_IDENTITY_MISMATCH/)
      writeFileSync(`${paths.commonNonce}.db`, JSON.stringify({ ...proof, expiresAt: 0 }))
      await assert.rejects(qualifyBackupLease(nonce, {}, paths, query), /LEASE_EXPIRED/)
    } finally {
      holder.kill('SIGKILL')
      await new Promise<void>((resolve) => holder.once('exit', () => resolve()))
    }
  })
})
