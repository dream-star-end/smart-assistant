// OCV5-600: scripts/v5-commercial-pg-backup.sh (commercial PG backup, local + encrypted copy on R2)
// against stub tools. No database, bucket, key or unit is touched: pg_dump / pg_restore / psql /
// fuser / systemctl / df / rclone / gpg are PATH stubs in a private temp dir; the real shared R2
// helper (scripts/v5-selfhost-pg-backup-r2.sh) runs against the stub rclone.
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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'scripts/v5-commercial-pg-backup.sh')
const GIB = 1024 ** 3

let dir: string

function stub(name: string, body: string) {
  const p = path.join(dir, 'bin', name)
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(p, 0o755)
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
    V5CB_DIR: path.join(dir, 'backups'),
    V5CB_LOCK: path.join(dir, 'run/backup.lock'),
    V5CB_MARKER: path.join(dir, 'run/openclaude/pg-r2-backup.running'),
    V5CB_MUTATION_LOCK: path.join(dir, 'run/v5/production-mutation.lock'),
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
  writeFileSync(path.join(dir, 'rclone.conf'), '[r2]\ntype = local\n')
  writeFileSync(path.join(dir, 'avail'), String(50 * GIB))
  writeFileSync(path.join(dir, 'deploy_state'), 'stable|')
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
      'case "$mode" in',
      '  fail) echo partial; exit 1 ;;',
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
  // fuser: "busy" when $STUB_DIR/fuser_busy exists; fuser_busy_after=N turns busy from call N on.
  stub(
    'fuser',
    [
      'n=$(( $(cat "$STUB_DIR/fuser_calls" 2>/dev/null || echo 0) + 1 )); echo $n > "$STUB_DIR/fuser_calls"',
      '[[ -f "$STUB_DIR/fuser_busy" ]] && exit 0',
      'after=$(cat "$STUB_DIR/fuser_busy_after" 2>/dev/null || echo 0)',
      '(( after > 0 && n >= after )) && exit 0',
      'exit 1',
    ].join('\n'),
  )
  // systemctl is-active: active for the first $STUB_DIR/active_polls calls.
  stub(
    'systemctl',
    [
      'n=$(( $(cat "$STUB_DIR/sc_calls" 2>/dev/null || echo 0) + 1 )); echo $n > "$STUB_DIR/sc_calls"',
      '(( n <= $(cat "$STUB_DIR/active_polls" 2>/dev/null || echo 0) )) && exit 0',
      'exit 3',
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

  test('an open production mutation lock skips the run before the marker or a dump', () => {
    writeFileSync(path.join(dir, 'fuser_busy'), '')
    const r = run()
    assert.equal(r.status, 3, r.out)
    assert.match(r.out, /SKIP release busy: production mutation lock is open/)
    assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
    assert.equal(existsSync(path.join(dir, 'run/openclaude/pg-r2-backup.running')), false)
    assert.equal(status().result, 'skipped_release_busy')
  })

  test('recovery and inflight markers and a non-stable deploy_state skip the run', () => {
    for (const m of ['.manual-recovery-required', '.mutation-lane-inflight']) {
      writeFileSync(path.join(dir, 'run/v5', m), '')
      assert.equal(run().status, 3, m)
      rmSync(path.join(dir, 'run/v5', m))
    }
    for (const st of ['deploying|', 'stable|rel-x']) {
      writeFileSync(path.join(dir, 'deploy_state'), st)
      const r = run()
      assert.equal(r.status, 3, r.out)
      assert.match(r.out, /deploy_state is/)
    }
    assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
  })

  test('a release that starts just as the marker is written still makes the run skip', () => {
    writeFileSync(path.join(dir, 'fuser_busy_after'), '2') // free on the first check, busy on the second
    const r = run()
    assert.equal(r.status, 3, r.out)
    assert.match(r.out, /SKIP release busy after marker/)
    assert.equal(existsSync(path.join(dir, 'pg_dump.args')), false)
    assert.equal(existsSync(path.join(dir, 'run/openclaude/pg-r2-backup.running')), false)
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
      path.join(root, 'deploy/v5/openclaude-v5-pg-r2-backup.service'),
      'utf8',
    )
    assert.match(
      svc,
      /^ExecStart=\/opt\/openclaude\/pg-r2-backup\/current\/v5-commercial-pg-backup\.sh run$/m,
    )
    assert.match(svc, /^OnFailure=openclaude-v5-alert-fail@%n\.service$/m)
    assert.match(svc, /^EnvironmentFile=-\/etc\/openclaude\/pg-r2-backup\.env$/m)
    const timer = readFileSync(
      path.join(root, 'deploy/v5/openclaude-v5-pg-r2-backup.timer'),
      'utf8',
    )
    assert.match(timer, /^OnCalendar=\*-\*-\* 04:30:00 Asia\/Taipei$/m)
    assert.match(timer, /^Persistent=true$/m)
    assert.match(timer, /^Unit=openclaude-v5-pg-r2-backup\.service$/m)
  })
})
