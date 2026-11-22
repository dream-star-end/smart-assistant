// OCV5-823: Standalone unit tests for watch.sh PG backup health probe
// (core freshness, full freshness, skipped_over_cap / aborted_over_cap, coreOffsite, safety switches).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ocv5-823-watch-backup-probe-'))
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

function runProbe(env: Record<string, string> = {}) {
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
      WATCH_AUTOSAVE_STATUS: path.join(dir, 'no-autosave.json'),
      WATCH_NOW_OVERRIDE: String(NOW),
      WATCH_STUB_DISK_AVAIL_BYTES: String(80 * GIB),
      ...env,
    },
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /rc=0/)
}

function writeStatus(doc: unknown) {
  writeFileSync(path.join(dir, 'pg-backup-status.json'), JSON.stringify(doc, null, 2))
}

function alerts(): string[] {
  const f = path.join(dir, 'alerts')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []
}

describe('OCV5-823 watch PG backup health probe', () => {
  test('healthy core + full + coreOffsite emits no alerts and records ok states', () => {
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', at: iso(NOW - 3600), lastOkAt: iso(NOW - 3600) },
      coreOffsite: { result: 'ok', at: iso(NOW - 3500), lastOkAt: iso(NOW - 3500) },
      full: { result: 'ok', at: iso(NOW - 2 * 86400), lastOkAt: iso(NOW - 2 * 86400) },
    })
    runProbe()
    assert.deepEqual(alerts(), [])
    assert.match(readFileSync(path.join(dir, 'run/watch-host-pg_backup'), 'utf8'), /^level=ok$/m)
    assert.match(readFileSync(path.join(dir, 'run/watch-host-pg_backup_full'), 'utf8'), /^level=ok$/m)
    assert.match(readFileSync(path.join(dir, 'run/watch-host-pg_backup_offsite'), 'utf8'), /^level=ok$/m)
  })

  test('unconfigured full backup stays silent while core is healthy', () => {
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 3600) },
      full: { result: 'unconfigured', at: iso(NOW - 3600) },
    })
    runProbe()
    assert.deepEqual(alerts(), [])
    assert.equal(existsSync(path.join(dir, 'run/watch-host-pg_backup_full')), false)
  })

  test('full skipped_over_cap with fresh lastOkAt alerts warning; stale + skipped_over_cap escalates to critical and recovers on ok', () => {
    // Fresh full lastOkAt (5d ago < 10d cap), but latest attempt skipped_over_cap -> warning
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 3600) },
      full: {
        result: 'skipped_over_cap',
        at: iso(NOW - 3600),
        lastOkAt: iso(NOW - 5 * 86400),
        compress: 'zstd:3',
      },
    })
    runProbe()
    let a = alerts()
    assert.equal(a.length, 1, a.join('\n'))
    assert.match(a[0], /^pg_backup_full_over_cap\|warning\|.*skipped_over_cap.*compress=zstd:3/)

    // Escalate: full lastOkAt is now 14 days old + skipped_over_cap (real host incident shape) -> critical immediately
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 3600) },
      full: {
        result: 'skipped_over_cap',
        at: iso(NOW - 3600),
        lastOkAt: iso(NOW - 14 * 86400),
        compress: 'zstd:3',
      },
    })
    runProbe({ WATCH_NOW_OVERRIDE: String(NOW + 60) })
    a = alerts()
    assert.equal(a.length, 2, a.join('\n'))
    assert.match(a[1], /^pg_backup_full_over_cap\|critical\|.*skipped_over_cap.*14 天前/)

    // Recovery after full succeeds again -> info recovery alert
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 1800) },
      full: {
        result: 'ok',
        at: iso(NOW + 60),
        lastOkAt: iso(NOW + 60),
        compress: 'zstd:9',
      },
    })
    runProbe({ WATCH_NOW_OVERRIDE: String(NOW + 120) })
    a = alerts()
    assert.equal(a.length, 3, a.join('\n'))
    assert.match(a[2], /^pg_backup_full_recovered\|info\|/)
  })

  test('full aborted_over_cap and stale full backup alert appropriately', () => {
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 1800) },
      full: {
        result: 'aborted_over_cap',
        at: iso(NOW - 600),
        lastOkAt: iso(NOW - 3 * 86400),
      },
    })
    runProbe()
    assert.equal(alerts().length, 1)
    assert.match(alerts()[0], /^pg_backup_full_over_cap\|warning\|.*aborted_over_cap/)

    // Reset state and test pure stale full backup (> 10 days default)
    rmSync(path.join(dir, 'run/watch-host-pg_backup_full'))
    rmSync(path.join(dir, 'alerts'))
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 1800) },
      full: {
        result: 'ok',
        at: iso(NOW - 12 * 86400),
        lastOkAt: iso(NOW - 12 * 86400),
      },
    })
    runProbe()
    assert.equal(alerts().length, 1)
    assert.match(alerts()[0], /^pg_backup_full_stale\|warning\|.*12 天前/)
  })

  test('coreOffsite skipped_over_cap alerts warning and recovers on ok', () => {
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 1800) },
      coreOffsite: { result: 'skipped_over_cap', at: iso(NOW - 1800), lastOkAt: iso(NOW - 86400) },
    })
    runProbe()
    let a = alerts()
    assert.equal(a.length, 1, a.join('\n'))
    assert.match(a[0], /^pg_backup_offsite_over_cap\|warning\|.*skipped_over_cap/)

    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 1800) },
      coreOffsite: { result: 'ok', at: iso(NOW), lastOkAt: iso(NOW) },
    })
    runProbe({ WATCH_NOW_OVERRIDE: String(NOW + 60) })
    a = alerts()
    assert.equal(a.length, 2, a.join('\n'))
    assert.match(a[1], /^pg_backup_offsite_recovered\|info\|/)
  })

  test('safety switches: WATCH_PG_BACKUP_PROBE_ENABLED=0 disables probe; WATCH_PG_BACKUP_ALERT_OVER_CAP=0 mutes over_cap only', () => {
    writeStatus({
      schemaVersion: 1,
      core: { result: 'dump_failed' },
      full: { result: 'skipped_over_cap', lastOkAt: iso(NOW - 20 * 86400) },
      coreOffsite: { result: 'skipped_over_cap' },
    })
    runProbe({ WATCH_PG_BACKUP_PROBE_ENABLED: '0' })
    assert.deepEqual(alerts(), [])
    assert.equal(existsSync(path.join(dir, 'run/watch-host-pg_backup')), false)
    assert.equal(existsSync(path.join(dir, 'run/watch-host-pg_backup_full')), false)

    // With ALERT_OVER_CAP=0, fresh skipped_over_cap does not alert, while stale full still alerts as stale
    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 1800) },
      full: { result: 'skipped_over_cap', lastOkAt: iso(NOW - 2 * 86400) },
      coreOffsite: { result: 'skipped_over_cap', lastOkAt: iso(NOW - 1800) },
    })
    runProbe({ WATCH_PG_BACKUP_ALERT_OVER_CAP: '0' })
    assert.deepEqual(alerts(), [])

    writeStatus({
      schemaVersion: 1,
      core: { result: 'ok', lastOkAt: iso(NOW - 1800) },
      full: { result: 'skipped_over_cap', lastOkAt: iso(NOW - 15 * 86400) },
    })
    runProbe({ WATCH_PG_BACKUP_ALERT_OVER_CAP: '0', WATCH_NOW_OVERRIDE: String(NOW + 60) })
    const a = alerts()
    assert.equal(a.length, 1, a.join('\n'))
    assert.match(a[0], /^pg_backup_full_stale\|warning\|.*15 天前/)
  })

  test('malformed JSON warns without failing tick; symlink status file is ignored; recovery markers untouched', () => {
    writeFileSync(path.join(dir, 'pg-backup-status.json'), '{not-valid-json')
    runProbe()
    const a = alerts()
    assert.equal(a.length, 1)
    assert.match(a[0], /^pg_backup_stale\|warning\|.*不可解析/)
    assert.equal(existsSync(path.join(dir, 'run/health-fail-count')), false)
    assert.equal(existsSync(path.join(dir, 'disarm')), false)
    assert.equal(existsSync(path.join(dir, 'manual')), false)

    rmSync(path.join(dir, 'pg-backup-status.json'))
    rmSync(path.join(dir, 'alerts'))
    writeFileSync(path.join(dir, 'target.json'), '{"schemaVersion":1,"core":{"result":"dump_failed"}}')
    symlinkSync(path.join(dir, 'target.json'), path.join(dir, 'pg-backup-status.json'))
    runProbe()
    assert.deepEqual(alerts(), [])
  })
})
