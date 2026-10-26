// OCV5-633 (X-P1-1 PR-b): personal /assets pool lib (scripts/v5-web-assets-pool-lib.sh) — which assets
// live is serving, additive sync without maps or symlinks, protected-set GC, and the fallback probe.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lib = path.join(root, 'scripts/v5-web-assets-pool-lib.sh')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function wap(fn: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `set -uo pipefail; source "${lib}"; ${fn} "$@"`, 'x', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  })
}

function tmp(): string {
  const t = mkdtempSync(path.join(tmpdir(), 'ocv5-633-'))
  dirs.push(t)
  return t
}

function files(dir: string, map: Record<string, string>) {
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(map)) writeFileSync(path.join(dir, name), body)
}

function ageDays(file: string, days: number) {
  const t = new Date(Date.now() - days * 86_400_000)
  utimesSync(file, t, t)
}

const present = (p: string) => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

describe('v5-web-assets-pool-lib', () => {
  test('live assets dir: the P0-Web pointer webroot when valid, otherwise the release dist', () => {
    const t = tmp()
    const live = path.join(t, 'releases', 'rel-aaaaaaaaa-20261027-000000')
    const dist = path.join(live, 'packages/web-react/dist/assets')
    mkdirSync(dist, { recursive: true })
    const overlay = path.join(t, 'overlay')
    assert.equal(wap('wap_live_assets_dir', [overlay, live]).stdout.trim(), dist)
    assert.equal(wap('wap_live_assets_dir', ['', live]).stdout.trim(), dist)

    const webroot = path.join(t, 'webroots', 'bbbbbbbb')
    files(path.join(webroot, 'assets'), { 'a.js': 'a' })
    writeFileSync(path.join(webroot, 'index.html'), '<html>')
    const bucket = path.join(overlay, path.basename(live))
    mkdirSync(bucket, { recursive: true })
    symlinkSync(webroot, path.join(bucket, 'current'))
    assert.equal(wap('wap_live_assets_dir', [overlay, live]).stdout.trim(), path.join(bucket, 'current', 'assets'))

    // Same rule as webRootOverlay.ts: a pointer without index.html is not what master serves.
    rmSync(path.join(webroot, 'index.html'))
    assert.equal(wap('wap_live_assets_dir', [overlay, live]).stdout.trim(), dist)

    const missing = wap('wap_live_assets_dir', [overlay, path.join(t, 'releases', 'rel-gone')])
    assert.notEqual(missing.status, 0)
  })

  test('sync is additive, skips source maps and symlinks, and skips missing sources', () => {
    const t = tmp()
    const pool = path.join(t, 'pool')
    const a = path.join(t, 'a')
    const b = path.join(t, 'b')
    files(a, { 'old-1.js': 'old', 'old-1.js.map': '{"sourcesContent":["SECRET"]}' })
    files(b, { 'new-2.js': 'new' })
    writeFileSync(path.join(t, 'secret.txt'), 'SECRET')
    symlinkSync(path.join(t, 'secret.txt'), path.join(b, 'link-3.js'))

    let r = wap('wap_sync', [pool, a])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /synced=1/)
    r = wap('wap_sync', [pool, b, path.join(t, 'missing')])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /synced=1/)

    assert.equal(readFileSync(path.join(pool, 'assets', 'old-1.js'), 'utf8'), 'old', 'earlier sync kept')
    assert.equal(readFileSync(path.join(pool, 'assets', 'new-2.js'), 'utf8'), 'new')
    assert.equal(present(path.join(pool, 'assets', 'old-1.js.map')), false, 'maps never enter the pool')
    assert.equal(present(path.join(pool, 'assets', 'link-3.js')), false, 'symlinks never enter the pool')
  })

  test('sync stamps pooled files with the sync time, so GC age means "not live for N days"', () => {
    const t = tmp()
    const pool = path.join(t, 'pool')
    const src = path.join(t, 'src')
    files(src, { 'chunk-1.js': 'x' })
    ageDays(path.join(src, 'chunk-1.js'), 30)
    assert.equal(wap('wap_sync', [pool, src]).status, 0)
    assert.ok(statSync(path.join(pool, 'assets', 'chunk-1.js')).mtimeMs > Date.now() - 600_000)
    ageDays(path.join(pool, 'assets', 'chunk-1.js'), 30)
    assert.equal(wap('wap_sync', [pool, src]).status, 0)
    assert.ok(statSync(path.join(pool, 'assets', 'chunk-1.js')).mtimeMs > Date.now() - 600_000, 're-seeding refreshes it')
  })

  test('sync refuses a relative or empty pool root', () => {
    const t = tmp()
    files(path.join(t, 'src'), { 'a.js': 'a' })
    assert.notEqual(wap('wap_sync', ['relative/pool', path.join(t, 'src')]).status, 0)
    assert.notEqual(wap('wap_sync', ['', path.join(t, 'src')]).status, 0)
  })

  test('gc deletes only entries that are unprotected and older than the window', () => {
    const t = tmp()
    const pool = path.join(t, 'pool')
    files(path.join(pool, 'assets'), { 'keep-1.js': 'k', 'stale-2.js': 's', 'fresh-3.js': 'f' })
    symlinkSync(path.join(t, 'nowhere'), path.join(pool, 'assets', 'dangling-4.js'))
    ageDays(path.join(pool, 'assets', 'keep-1.js'), 30)
    ageDays(path.join(pool, 'assets', 'stale-2.js'), 30)
    ageDays(path.join(pool, 'assets', 'fresh-3.js'), 1)
    spawnSync('touch', ['-h', '-d', '30 days ago', path.join(pool, 'assets', 'dangling-4.js')])
    const live = path.join(t, 'live-assets')
    files(live, { 'keep-1.js': 'k' })

    const r = wap('wap_gc', [pool, '14', live, path.join(t, 'missing')])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /protected=1 deleted=2/)
    assert.equal(present(path.join(pool, 'assets', 'keep-1.js')), true, 'protected even though old')
    assert.equal(present(path.join(pool, 'assets', 'fresh-3.js')), true, 'unprotected but recent')
    assert.equal(present(path.join(pool, 'assets', 'stale-2.js')), false)
    assert.equal(present(path.join(pool, 'assets', 'dangling-4.js')), false)
  })

  test('gc is fail-closed without any protected dir, rejects a bad window, and no-ops on a missing pool', () => {
    const t = tmp()
    const pool = path.join(t, 'pool')
    files(path.join(pool, 'assets'), { 'stale-1.js': 's' })
    ageDays(path.join(pool, 'assets', 'stale-1.js'), 30)

    const r = wap('wap_gc', [pool, '14', path.join(t, 'missing')])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /fail-closed/)
    assert.equal(existsSync(path.join(pool, 'assets', 'stale-1.js')), true)

    files(path.join(t, 'p'), { 'x.js': 'x' })
    for (const bad of ['0', 'abc', '', '-3']) assert.notEqual(wap('wap_gc', [pool, bad, path.join(t, 'p')]).status, 0, bad)
    assert.equal(wap('wap_gc', [path.join(t, 'no-pool'), '14', path.join(t, 'p')]).status, 0)
  })

  test('fallback probe: skips without a pool-only chunk, passes on 200 from master, fails otherwise', () => {
    const t = tmp()
    const bin = path.join(t, 'bin')
    mkdirSync(bin)
    const curlLog = path.join(t, 'curl.log')
    writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\necho "$@" >>"$CURL_LOG"\nprintf "%s" "$CURL_CODE"\n')
    chmodSync(path.join(bin, 'curl'), 0o755)
    const env = (code: string) => ({ PATH: `${bin}:${process.env.PATH ?? ''}`, CURL_LOG: curlLog, CURL_CODE: code })
    const pool = path.join(t, 'pool')
    const web = path.join(t, 'web-assets')
    files(web, { 'main-new.js': 'n', 'shared.js': 's' })

    let r = wap('wap_fallback_probe', ['http://127.0.0.1:1', pool, web], env('200'))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /跳过/)

    files(path.join(pool, 'assets'), { 'shared.js': 's', 'style-x.css': 'c' })
    r = wap('wap_fallback_probe', ['http://127.0.0.1:1', pool, web], env('200'))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /跳过/, 'only .js chunks that live no longer has are probed')
    assert.equal(existsSync(curlLog), false, 'nothing to probe → no request')

    files(path.join(pool, 'assets'), { 'Settings-old.js': 'o' })
    r = wap('wap_fallback_probe', ['http://127.0.0.1:1', pool, web], env('200'))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /\/assets\/Settings-old\.js 200/)
    assert.match(readFileSync(curlLog, 'utf8'), /http:\/\/127\.0\.0\.1:1\/assets\/Settings-old\.js/)

    r = wap('wap_fallback_probe', ['http://127.0.0.1:1', pool, web], env('404'))
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /HTTP 404/)
  })
})
