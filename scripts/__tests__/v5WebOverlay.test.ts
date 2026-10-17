// OCV5-489: P0-Web web overlay lib (scripts/v5-web-overlay-lib.sh) — seed, surface check,
// union staging, static gate, atomic flip, revert target, active-overlay commit, GC.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lib = path.join(root, 'scripts/v5-web-overlay-lib.sh')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function wo(fn: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `set -uo pipefail; source "${lib}"; ${fn} "$@"`, 'x', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  })
}

function writeDist(dir: string, build: string, assets: Record<string, string>, adminAsset = Object.keys(assets)[0]) {
  mkdirSync(path.join(dir, 'assets'), { recursive: true })
  const scripts = Object.keys(assets)
    .map((a) => `<script type="module" src="/assets/${a}"></script>`)
    .join('')
  writeFileSync(path.join(dir, 'index.html'), `<meta name="oc-build" content="${build}">${scripts}`)
  writeFileSync(path.join(dir, 'admin.html'), `<script src="/assets/${adminAsset}"></script>`)
  for (const [name, body] of Object.entries(assets)) writeFileSync(path.join(dir, 'assets', name), body)
}

function fixture() {
  const t = mkdtempSync(path.join(tmpdir(), 'ocv5-489-'))
  dirs.push(t)
  const rel = path.join(t, 'releases', 'rel-aaaaaaaaa-20261017-000000')
  const dist = path.join(rel, 'packages/web-react/dist')
  writeDist(dist, 'aaaaaaaa', { 'main-old.js': 'old', 'lazy-old.js': 'lazy' })
  const overlay = path.join(t, 'overlay')
  const bucket = path.join(overlay, 'rel-aaaaaaaaa-20261017-000000')
  return { t, rel, dist, overlay, bucket }
}

describe('v5-web-overlay-lib', () => {
  test('seed points a new release bucket at its own dist and never overwrites an existing pointer', () => {
    const f = fixture()
    let r = wo('wo_seed_pointer', [f.overlay, f.rel, 'a'.repeat(40)])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readlinkSync(path.join(f.bucket, 'current')), f.dist)
    assert.match(readFileSync(path.join(f.bucket, 'history'), 'utf8'), /aaaaaaaa a{40}\n$/)

    const other = path.join(f.t, 'elsewhere')
    writeDist(other, 'cccccccc', { 'x.js': 'x' })
    r = wo('wo_point', [f.bucket, other])
    assert.equal(r.status, 0, r.stderr)
    r = wo('wo_seed_pointer', [f.overlay, f.rel, 'a'.repeat(40)])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readlinkSync(path.join(f.bucket, 'current')), other, 'existing pointer kept')
  })

  test('surface check admits only pure frontend static paths', () => {
    const f = fixture()
    const repo = path.join(f.t, 'repo')
    mkdirSync(repo)
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout.trim()
    }
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    const put = (p: string, s: string) => {
      mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
      writeFileSync(path.join(repo, p), s)
    }
    put('packages/web-react/src/App.tsx', '1')
    put('packages/web-react/package.json', '{"version":"1"}')
    put('packages/gateway/src/server.ts', '1')
    git('add', '-A')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    put('packages/web-react/src/App.tsx', '2')
    put('e2e/session-display/incidents.json', '[]')
    git('add', '-A')
    git('commit', '-qm', 'web')
    const web = git('rev-parse', 'HEAD')
    let r = wo('wo_check_surface', [repo, base, web])
    assert.equal(r.status, 0, r.stdout + r.stderr)

    put('packages/web-react/package.json', '{"version":"2"}')
    put('packages/gateway/src/server.ts', '2')
    git('add', '-A')
    git('commit', '-qm', 'mixed')
    r = wo('wo_check_surface', [repo, base, git('rev-parse', 'HEAD')])
    assert.equal(r.status, 1)
    assert.deepEqual(r.stdout.trim().split('\n').sort(), [
      'packages/gateway/src/server.ts',
      'packages/web-react/package.json',
    ])
  })

  test('staged webroot keeps old lazy chunks, replaces root files, and passes the static gate', () => {
    const f = fixture()
    assert.equal(wo('wo_seed_pointer', [f.overlay, f.rel, 'a'.repeat(40)]).status, 0)
    const fresh = path.join(f.t, 'build/dist')
    writeDist(fresh, 'bbbbbbbb', { 'main-new.js': 'new' })
    const r = wo('wo_stage_webroot', [f.bucket, fresh, 'b'.repeat(40), f.rel])
    assert.equal(r.status, 0, r.stderr)
    const webroot = r.stdout.trim()
    assert.equal(webroot, path.join(f.bucket, 'webroots/bbbbbbbb'))
    assert.ok(existsSync(path.join(webroot, 'assets/lazy-old.js')), 'old chunk kept for open tabs')
    assert.ok(existsSync(path.join(webroot, 'assets/main-new.js')))
    assert.match(readFileSync(path.join(webroot, 'index.html'), 'utf8'), /bbbbbbbb/)
    assert.equal(readFileSync(path.join(f.dist, 'index.html'), 'utf8').includes('aaaaaaaa'), true, 'release dist untouched')
    const meta = JSON.parse(readFileSync(path.join(f.bucket, 'webroots/bbbbbbbb.json'), 'utf8'))
    assert.equal(meta.sourceCommit, 'b'.repeat(40))
    assert.equal(meta.previous, f.dist)
    assert.equal(existsSync(path.join(webroot, 'bbbbbbbb.json')), false, 'metadata is not served')

    assert.equal(wo('wo_static_gate', [webroot, 'bbbbbbbb']).status, 0)
    assert.equal(wo('wo_static_gate', [webroot, 'cccccccc']).status, 1)
    rmSync(path.join(webroot, 'assets/main-new.js'))
    const g = wo('wo_static_gate', [webroot, 'bbbbbbbb'])
    assert.equal(g.status, 1)
    assert.match(g.stderr, /main-new\.js/)
  })

  test('unchanged chunks stay hardlinked to the previous webroot (no full copy per flip)', () => {
    const f = fixture()
    assert.equal(wo('wo_seed_pointer', [f.overlay, f.rel, 'a'.repeat(40)]).status, 0)
    const fresh = path.join(f.t, 'build/dist')
    writeDist(fresh, 'bbbbbbbb', { 'lazy-old.js': 'lazy', 'main-new.js': 'new' })
    const releaseChunk = path.join(f.dist, 'assets/lazy-old.js')
    const old = new Date(Date.now() - 3_600_000)
    spawnSync('touch', ['-d', old.toISOString(), releaseChunk])
    const before = statSync(releaseChunk)
    const webroot = wo('wo_stage_webroot', [f.bucket, fresh, 'b'.repeat(40), f.rel]).stdout.trim()
    const after = statSync(releaseChunk)
    assert.equal(statSync(path.join(webroot, 'assets/lazy-old.js')).ino, after.ino)
    assert.equal(after.mtimeMs, before.mtimeMs, 'shared inode of the immutable release must not be touched')
    assert.equal(after.mode, before.mode)
  })

  test('flip, previous target, active overlay commit and revert', () => {
    const f = fixture()
    assert.equal(wo('wo_seed_pointer', [f.overlay, f.rel, 'a'.repeat(40)]).status, 0)
    let r = wo('wo_active_overlay_commit', [f.overlay, f.rel])
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '', 'release dist is not an overlay')

    const fresh = path.join(f.t, 'build/dist')
    writeDist(fresh, 'bbbbbbbb', { 'main-new.js': 'new' })
    const webroot = wo('wo_stage_webroot', [f.bucket, fresh, 'b'.repeat(40), f.rel]).stdout.trim()
    assert.equal(wo('wo_point', [f.bucket, webroot]).status, 0)
    assert.equal(wo('wo_append_history', [f.bucket, webroot, 'bbbbbbbb', 'b'.repeat(40)]).status, 0)
    assert.equal(readlinkSync(path.join(f.bucket, 'current')), webroot)

    r = wo('wo_active_overlay_commit', [f.overlay, f.rel])
    assert.equal(r.stdout.trim(), 'b'.repeat(40))
    r = wo('wo_previous_target', [f.bucket])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), f.dist)
    assert.equal(wo('wo_point', [f.bucket, f.dist]).status, 0)
    assert.equal(readlinkSync(path.join(f.bucket, 'current')), f.dist)
  })

  test('pointing at a directory without index.html is refused and leaves the pointer alone', () => {
    const f = fixture()
    assert.equal(wo('wo_seed_pointer', [f.overlay, f.rel, 'a'.repeat(40)]).status, 0)
    const empty = path.join(f.t, 'empty')
    mkdirSync(empty)
    assert.equal(wo('wo_point', [f.bucket, empty]).status, 1)
    assert.equal(readlinkSync(path.join(f.bucket, 'current')), f.dist)
  })

  test('bucket refuses non-release directories', () => {
    const f = fixture()
    assert.equal(wo('wo_bucket', [f.overlay, path.join(f.t, 'ocv5-489-p0web')]).status, 1)
  })

  test('bucket GC drops buckets whose release is gone and keeps live ones', () => {
    const f = fixture()
    assert.equal(wo('wo_seed_pointer', [f.overlay, f.rel, 'a'.repeat(40)]).status, 0)
    const gone = path.join(f.overlay, 'rel-gone-20261001-000000')
    mkdirSync(path.join(gone, 'webroots'), { recursive: true })
    const r = wo('wo_gc_buckets', [f.overlay, path.join(f.t, 'releases')])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(gone), false)
    assert.equal(existsSync(f.bucket), true)
  })

  test('GC keeps the current target and the most recent history entries', () => {
    const f = fixture()
    assert.equal(wo('wo_seed_pointer', [f.overlay, f.rel, 'a'.repeat(40)]).status, 0)
    const ids = ['b1b1b1b1', 'b2b2b2b2', 'b3b3b3b3']
    const roots: string[] = []
    for (const id of ids) {
      const fresh = path.join(f.t, `build-${id}`)
      writeDist(fresh, id, { [`m-${id}.js`]: id })
      const w = wo('wo_stage_webroot', [f.bucket, fresh, 'b'.repeat(40), f.rel]).stdout.trim()
      roots.push(w)
      assert.equal(wo('wo_point', [f.bucket, w]).status, 0)
      assert.equal(wo('wo_append_history', [f.bucket, w, id, 'b'.repeat(40)]).status, 0)
    }
    const r = wo('wo_gc_webroots', [f.bucket], { WO_KEEP_WEBROOTS: '2' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(roots[0]), false, 'oldest overlay removed')
    assert.equal(existsSync(`${roots[0]}.json`), false)
    assert.equal(existsSync(roots[1]), true)
    assert.equal(existsSync(roots[2]), true, 'current kept')
    assert.equal(existsSync(f.dist), true, 'release dist is never touched by GC')
  })
})
