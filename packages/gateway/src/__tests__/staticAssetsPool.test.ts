/**
 * OCV5-632(X-P1-1 PR-a):/assets 未命中回落资产池 + spa 模式 .map 一律 404。
 * 背景:个人 master 的 /assets/* 只查当前 webRoot,发版后仍开着的旧标签懒加载上一版哈希 chunk
 * 直接 404(弹「已发布新版本」遮罩);且 master 直接返回 /assets/*.js.map(源码映射外泄)。
 * Run: npx tsx --test packages/gateway/src/__tests__/staticAssetsPool.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { serveWebStatic } from '../gatewayHttp.js'
import { staticFileCandidates } from '../httpUploadStatic.js'
import { Gateway } from '../server.js'
import { resolveV5WebAssetsPool } from '../webRootOverlay.js'

class ResRecorder {
  status = 0
  headers: Record<string, string> = {}
  body: Buffer = Buffer.alloc(0)
  writeHead(code: number, headers?: Record<string, string>): this {
    this.status = code
    if (headers) Object.assign(this.headers, headers)
    return this
  }
  end(chunk?: unknown): this {
    if (typeof chunk === 'string') this.body = Buffer.from(chunk)
    else if (Buffer.isBuffer(chunk)) this.body = chunk
    return this
  }
}

const req = { headers: {} } as unknown as IncomingMessage
const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** webRoot(当前版本)+ 资产池,各放若干文件。 */
function fixture(): { webRoot: string; pool: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), 'oc-assets-pool-'))
  tmpDirs.push(base)
  const webRoot = join(base, 'dist')
  const pool = join(base, 'pool')
  mkdirSync(join(webRoot, 'assets'), { recursive: true })
  mkdirSync(join(pool, 'assets'), { recursive: true })
  writeFileSync(join(webRoot, 'index.html'), '<html>current</html>')
  writeFileSync(join(webRoot, 'assets', 'main-new.js'), 'current main')
  writeFileSync(join(webRoot, 'assets', 'shared.js'), 'current shared')
  writeFileSync(join(webRoot, 'assets', 'main-new.js.map'), '{"sourcesContent":["SECRET"]}')
  writeFileSync(join(pool, 'assets', 'Settings-old.js'), 'previous release chunk')
  writeFileSync(join(pool, 'assets', 'shared.js'), 'pool shared (older copy)')
  writeFileSync(join(pool, 'assets', 'Settings-old.js.map'), '{"sourcesContent":["SECRET"]}')
  return { webRoot, pool, base }
}

/** 只借原型方法(同 staticFileCache.test.ts),手工注入 deps 与缓存 Map。 */
function host(deps: { webRoot?: string; staticMode?: 'vanilla' | 'spa'; webAssetsPool?: string }) {
  const gw = Object.create(Gateway.prototype) as Record<string, unknown>
  gw._staticFileCache = new Map()
  gw.deps = deps
  return gw as unknown as ThisParameterType<typeof serveWebStatic>
}

function get(h: ThisParameterType<typeof serveWebStatic>, path: string): { served: boolean; res: ResRecorder } {
  const res = new ResRecorder()
  const served = serveWebStatic.call(h, new URL(`http://x${path}`), req, res as unknown as ServerResponse)
  return { served, res }
}

describe('staticFileCandidates', () => {
  it('spa /assets: webRoot first, then the pool when the pooled file really exists there', () => {
    const { webRoot, pool } = fixture()
    const opts = { webRoot, staticMode: 'spa' as const, assetsPool: pool }
    assert.deepEqual(staticFileCandidates('/assets/Settings-old.js', opts), [
      join(webRoot, 'assets', 'Settings-old.js'),
      join(pool, 'assets', 'Settings-old.js'),
    ])
    assert.deepEqual(staticFileCandidates('/assets/missing-1.js', opts), [join(webRoot, 'assets', 'missing-1.js')])
  })

  it('no pool configured, a non-/assets path, or vanilla mode: webRoot only (unchanged)', () => {
    const { webRoot, pool } = fixture()
    const opts = { webRoot, staticMode: 'spa' as const, assetsPool: pool }
    assert.deepEqual(staticFileCandidates('/assets/Settings-old.js', { ...opts, assetsPool: undefined }), [
      join(webRoot, 'assets', 'Settings-old.js'),
    ])
    assert.deepEqual(staticFileCandidates('/index.html', opts), [join(webRoot, 'index.html')])
    assert.deepEqual(staticFileCandidates('/assets/Settings-old.js', { ...opts, staticMode: 'vanilla' }), [
      join(webRoot, 'assets', 'Settings-old.js'),
    ])
  })

  it('spa: any .map is null, also after normalising (trailing slash, ..); vanilla keeps serving it', () => {
    const opts = { webRoot: '/srv/dist', staticMode: 'spa' as const }
    for (const path of ['/assets/a-1.js.map', '/assets/a-1.css.MAP', '/assets/a-1.js.map/', '/assets/x/../a-1.js.map', '/a.map']) {
      assert.equal(staticFileCandidates(path, opts), null, path)
    }
    assert.deepEqual(staticFileCandidates('/assets/a-1.js.map', { ...opts, staticMode: 'vanilla' }), [
      '/srv/dist/assets/a-1.js.map',
    ])
  })

  it('never escapes webRoot or the pool assets dir by path', () => {
    const { webRoot, pool } = fixture()
    const opts = { webRoot, staticMode: 'spa' as const, assetsPool: pool }
    assert.deepEqual(staticFileCandidates('/assets/../../../etc/passwd', opts), [])
    // 前缀相同的兄弟目录(<pool>/assets-evil)不算池内;webRoot 侧沿用原有包含语义。
    mkdirSync(join(pool, 'assets-evil'))
    writeFileSync(join(pool, 'assets-evil', 'x.js'), 'evil')
    assert.deepEqual(staticFileCandidates('/assets/../assets-evil/x.js', opts), [join(webRoot, 'assets-evil', 'x.js')])
  })

  it('never escapes the pool through a symlink (Codex r1 P1)', () => {
    const { webRoot, pool, base } = fixture()
    const opts = { webRoot, staticMode: 'spa' as const, assetsPool: pool }
    mkdirSync(join(pool, 'assets-evil'))
    writeFileSync(join(pool, 'assets-evil', 'private.txt'), 'PRIVATE')
    writeFileSync(join(base, 'secret.txt'), 'SECRET')
    symlinkSync(join(pool, 'assets-evil'), join(pool, 'assets', 'escape'))
    symlinkSync(join(base, 'secret.txt'), join(pool, 'assets', 'leak.js'))
    assert.deepEqual(staticFileCandidates('/assets/escape/private.txt', opts), [join(webRoot, 'assets', 'escape', 'private.txt')])
    assert.deepEqual(staticFileCandidates('/assets/leak.js', opts), [join(webRoot, 'assets', 'leak.js')])
    // 池内互指的符号链接照常可用。
    symlinkSync(join(pool, 'assets', 'Settings-old.js'), join(pool, 'assets', 'alias.js'))
    assert.deepEqual(staticFileCandidates('/assets/alias.js', opts), [
      join(webRoot, 'assets', 'alias.js'),
      join(pool, 'assets', 'alias.js'),
    ])
  })
})

describe('serveWebStatic with an assets pool (spa)', () => {
  it('the current webRoot wins over an older pooled copy of the same file', () => {
    const { webRoot, pool } = fixture()
    const { served, res } = get(host({ webRoot, staticMode: 'spa', webAssetsPool: pool }), '/assets/shared.js')
    assert.equal(served, true)
    assert.equal(res.body.toString(), 'current shared')
  })

  it('a chunk only in the pool is served 200 with the immutable header', () => {
    const { webRoot, pool } = fixture()
    const { served, res } = get(host({ webRoot, staticMode: 'spa', webAssetsPool: pool }), '/assets/Settings-old.js')
    assert.equal(served, true)
    assert.equal(res.status, 200)
    assert.equal(res.body.toString(), 'previous release chunk')
    assert.equal(res.headers['Cache-Control'], 'public, max-age=31536000, immutable')
  })

  it('a chunk in neither place is not served (caller 404s), never index.html', () => {
    const { webRoot, pool } = fixture()
    const { served, res } = get(host({ webRoot, staticMode: 'spa', webAssetsPool: pool }), '/assets/gone-123.js')
    assert.equal(served, false)
    assert.equal(res.status, 0)
  })

  it('source maps are not served from webRoot or the pool even though the files exist', () => {
    const { webRoot, pool } = fixture()
    const h = host({ webRoot, staticMode: 'spa', webAssetsPool: pool })
    assert.equal(get(h, '/assets/main-new.js.map').served, false)
    assert.equal(get(h, '/assets/Settings-old.js.map').served, false)
    // Codex r1 P1:尾斜杠曾绕过拦截(resolve 会去掉它再读盘)。
    assert.equal(get(h, '/assets/main-new.js.map/').served, false)
    assert.equal(get(host({ webRoot, staticMode: 'spa' }), '/assets/main-new.js.map/').served, false)
  })

  it('a symlink inside the pool cannot serve a file from outside it', () => {
    const { webRoot, pool, base } = fixture()
    writeFileSync(join(base, 'secret.txt'), 'SECRET')
    symlinkSync(join(base, 'secret.txt'), join(pool, 'assets', 'leak.js'))
    const { served, res } = get(host({ webRoot, staticMode: 'spa', webAssetsPool: pool }), '/assets/leak.js')
    assert.equal(served, false)
    assert.equal(res.body.toString().includes('SECRET'), false)
  })

  it('without a pool: unchanged — current files and SPA navigation still served, old chunk not', () => {
    const { webRoot } = fixture()
    const h = host({ webRoot, staticMode: 'spa' })
    assert.equal(get(h, '/assets/main-new.js').res.body.toString(), 'current main')
    assert.equal(get(h, '/assets/Settings-old.js').served, false)
    const nav = get(h, '/chat/abc')
    assert.equal(nav.served, true)
    assert.equal(nav.res.body.toString(), '<html>current</html>')
    assert.equal(nav.res.headers['Cache-Control'], 'no-cache')
  })

  it('vanilla mode ignores the pool', () => {
    const { webRoot, pool } = fixture()
    assert.equal(get(host({ webRoot, staticMode: 'vanilla', webAssetsPool: pool }), '/assets/Settings-old.js').served, false)
  })

  it('/admin still redirects to /admin.html in spa mode', () => {
    const { webRoot, pool } = fixture()
    const { served, res } = get(host({ webRoot, staticMode: 'spa', webAssetsPool: pool }), '/admin')
    assert.equal(served, true)
    assert.equal(res.status, 302)
    assert.equal(res.headers.Location, '/admin.html')
  })

  it('no webRoot: nothing served', () => {
    assert.equal(get(host({}), '/index.html').served, false)
  })
})

describe('resolveV5WebAssetsPool', () => {
  it('accepts an absolute path only; anything else reads as unset', () => {
    assert.equal(resolveV5WebAssetsPool('/opt/openclaude/openclaude-v5-selfhost-assets'), '/opt/openclaude/openclaude-v5-selfhost-assets')
    assert.equal(resolveV5WebAssetsPool('  /opt/pool  '), '/opt/pool')
    assert.equal(resolveV5WebAssetsPool('relative/pool'), undefined)
    assert.equal(resolveV5WebAssetsPool('   '), undefined)
    assert.equal(resolveV5WebAssetsPool(undefined), undefined)
  })
})
