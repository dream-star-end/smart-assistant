// OCV5-444: watch.sh host hygiene checks (root disk free space, PG backup freshness).
// Sources scripts/v5-selfhost-watch.sh in a private temp dir with a stub alert
// binary; never touches the installed watch, /run, or real alert channels.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const watch = path.join(root, 'scripts/v5-selfhost-watch.sh')
const GIB = 1024 ** 3
const NOW = 1_800_000_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ocv5-444-watch-host-'))
  mkdirSync(path.join(dir, 'run'))
  const alert = path.join(dir, 'alert')
  writeFileSync(
    alert,
    '#!/usr/bin/env bash\n[[ "$1" == --flush ]] && exit 0\nprintf "%s|%s|%s\\n" "$2" "$4" "$6" >> "$(dirname "$0")/alerts"\n',
  )
  chmodSync(alert, 0o755)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function check(env: Record<string, string>) {
  const r = spawnSync('bash', ['-c', `source "${watch}"; host_checks; echo "rc=$?"`], {
    env: {
      PATH: process.env.PATH ?? '',
      WATCH_RUN_DIR: path.join(dir, 'run'),
      WATCH_LOG: path.join(dir, 'watch.log'),
      WATCH_ALERT_BIN: path.join(dir, 'alert'),
      WATCH_FAIL_COUNT: path.join(dir, 'run/health-fail-count'),
      WATCH_DISARM: path.join(dir, 'disarm'),
      WATCH_MANUAL_RECOVERY: path.join(dir, 'manual'),
      WATCH_PG_BACKUP_STATUS: path.join(dir, 'pg-backup-status.json'),
      WATCH_NOW_OVERRIDE: String(NOW),
      WATCH_STUB_DISK_AVAIL_BYTES: String(50 * GIB),
      ...env,
    },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /rc=0/)
}

function alerts(): string[] {
  const f = path.join(dir, 'alerts')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []
}

function backupStatus(lastOkAt: string | null) {
  writeFileSync(
    path.join(dir, 'pg-backup-status.json'),
    JSON.stringify({
      schemaVersion: 1,
      core: lastOkAt ? { result: 'ok', lastOkAt } : { result: 'dump_failed' },
    }),
  )
}

const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('watch host_checks: root disk', () => {
  test('plenty of space: no alert, state recorded as ok', () => {
    check({})
    assert.deepEqual(alerts(), [])
    assert.match(readFileSync(path.join(dir, 'run/watch-host-disk'), 'utf8'), /^level=ok$/m)
  })

  test('below warn -> one warning; repeated tick inside cooldown stays quiet; after cooldown repeats', () => {
    check({ WATCH_STUB_DISK_AVAIL_BYTES: String(12 * GIB) })
    check({ WATCH_STUB_DISK_AVAIL_BYTES: String(12 * GIB), WATCH_NOW_OVERRIDE: String(NOW + 60) })
    let a = alerts()
    assert.equal(a.length, 1, a.join('\n'))
    assert.match(a[0], /^disk_low\|warning\|.*剩余 12 GiB/)
    check({
      WATCH_STUB_DISK_AVAIL_BYTES: String(12 * GIB),
      WATCH_NOW_OVERRIDE: String(NOW + 21_600),
    })
    a = alerts()
    assert.equal(a.length, 2, a.join('\n'))
  })

  test('warning -> critical alerts at once; recovery sends info', () => {
    check({ WATCH_STUB_DISK_AVAIL_BYTES: String(12 * GIB) })
    check({ WATCH_STUB_DISK_AVAIL_BYTES: String(8 * GIB), WATCH_NOW_OVERRIDE: String(NOW + 30) })
    check({ WATCH_STUB_DISK_AVAIL_BYTES: String(40 * GIB), WATCH_NOW_OVERRIDE: String(NOW + 60) })
    check({ WATCH_STUB_DISK_AVAIL_BYTES: String(40 * GIB), WATCH_NOW_OVERRIDE: String(NOW + 90) })
    const a = alerts()
    assert.equal(a.length, 3, a.join('\n'))
    assert.match(a[1], /^disk_low\|critical\|/)
    assert.match(a[2], /^disk_low_recovered\|info\|/)
  })

  test('unreadable df: no alert and no state written', () => {
    check({ WATCH_STUB_DISK_AVAIL_BYTES: 'n/a' })
    assert.deepEqual(alerts(), [])
    assert.equal(existsSync(path.join(dir, 'run/watch-host-disk')), false)
  })

  test('never touches the health fail counter or recovery markers', () => {
    check({ WATCH_STUB_DISK_AVAIL_BYTES: String(1 * GIB) })
    assert.equal(existsSync(path.join(dir, 'run/health-fail-count')), false)
    assert.equal(existsSync(path.join(dir, 'disarm')), false)
    assert.equal(existsSync(path.join(dir, 'manual')), false)
  })
})

describe('watch host_checks: PG backup freshness', () => {
  test('no status file (backup not installed): no backup alert', () => {
    check({})
    assert.deepEqual(alerts(), [])
    assert.equal(existsSync(path.join(dir, 'run/watch-host-pg_backup')), false)
  })

  test('fresh backup: quiet; older than 36h: warning; never succeeded: warning', () => {
    backupStatus(iso(NOW - 3600))
    check({})
    assert.deepEqual(alerts(), [])
    backupStatus(iso(NOW - 40 * 3600))
    check({})
    let a = alerts()
    assert.equal(a.length, 1, a.join('\n'))
    assert.match(a[0], /^pg_backup_stale\|warning\|.*40 小时前/)
    rmSync(path.join(dir, 'run/watch-host-pg_backup'))
    rmSync(path.join(dir, 'alerts'))
    backupStatus(null)
    check({})
    a = alerts()
    assert.equal(a.length, 1, a.join('\n'))
    assert.match(a[0], /从未成功/)
  })
})

describe('watch main wiring', () => {
  test('--once runs host_checks before watch_once and cannot fail the tick', () => {
    const src = readFileSync(watch, 'utf8')
    assert.match(src, /--once\|""\) trap '[^']+' EXIT; host_checks \|\| true; watch_once ;;/)
  })
})
