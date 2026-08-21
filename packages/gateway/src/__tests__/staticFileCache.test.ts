/**
 * 静态文件内存缓存的 mtime 回验(regression lock)。
 * 事故背景:2026-08-16 selfhost「构建前端未重启 master」—— HTTP 层内存缓存把旧
 * index.html 钉死,WS 版本握手帧却已收敛到新 build id,客户端 reload 永远追不上
 * 目标版本 → update banner 死循环。本文件锁定:文件被覆盖(mtime 前进)后,
 * 下一个请求必须拿到新内容,无需重启进程。
 * Run: npx tsx --test packages/gateway/src/__tests__/staticFileCache.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { Gateway } from '../server.js'

type CacheEntry = { content: Buffer; mime: string; etag: string; mtimeMs: number }
type ServeStatic = (
  filePath: string,
  cacheHeader: string,
  req: IncomingMessage,
  res: ServerResponse,
  mime: string,
) => boolean

function makeServe(): ServeStatic {
  // 只借用原型方法,不构造完整 Gateway(构造依赖 config/PG);handler 只读写
  // _staticFileCache 与入参,手工注入缓存 Map 即可行为级直测。
  const gw = Object.create(Gateway.prototype)
  ;(gw as unknown as { _staticFileCache: Map<string, CacheEntry> })._staticFileCache = new Map()
  return (gw as unknown as { _serveStaticCached: ServeStatic })._serveStaticCached.bind(gw)
}

function fakeReq(ifNoneMatch?: string): IncomingMessage {
  return { headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {} } as unknown as IncomingMessage
}

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

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('static file cache revalidates against disk mtime', () => {
  it('serves overwritten content after mtime advances, without process restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-static-cache-'))
    tmpDirs.push(dir)
    const file = join(dir, 'index.html')
    writeFileSync(file, '<meta name="oc-build" content="aaaaaaaa">')
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)

    const serve = makeServe()
    const r1 = new ResRecorder()
    assert.equal(serve(file, 'no-cache', fakeReq(), r1 as unknown as ServerResponse, 'text/html'), true)
    assert.equal(r1.status, 200)
    assert.ok(r1.body.toString().includes('aaaaaaaa'))
    const etag1 = String(r1.headers['ETag'])
    assert.notEqual(etag1, 'undefined')

    // 部署:dist 被 rsync 覆盖,mtime 前进,进程不重启。
    // 回归断言:命中缓存的下一个请求必须拿到新内容(修复前这里返回旧 aaaaaaaa)。
    writeFileSync(file, '<meta name="oc-build" content="bbbbbbbb">')
    utimesSync(file, new Date(), new Date())

    const r2 = new ResRecorder()
    assert.equal(serve(file, 'no-cache', fakeReq(), r2 as unknown as ServerResponse, 'text/html'), true)
    assert.equal(r2.status, 200)
    assert.ok(r2.body.toString().includes('bbbbbbbb'), 'must serve overwritten content, not stale cache')
    assert.notEqual(String(r2.headers['ETag']), etag1)
  })

  it('keeps 304 semantics: fresh cache 304s on if-none-match; stale entry no longer 304s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-static-cache-'))
    tmpDirs.push(dir)
    const file = join(dir, 'index.html')
    writeFileSync(file, 'v1')
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)

    const serve = makeServe()
    const r1 = new ResRecorder()
    serve(file, 'no-cache', fakeReq(), r1 as unknown as ServerResponse, 'text/html')
    const etag1 = String(r1.headers['ETag'])

    const r304 = new ResRecorder()
    serve(file, 'no-cache', fakeReq(etag1), r304 as unknown as ServerResponse, 'text/html')
    assert.equal(r304.status, 304)

    // 文件覆盖后旧 etag 不得再 304:条目按 mtime 失效,重读出新 etag,回 200 新内容。
    writeFileSync(file, 'v2-longer-content')
    utimesSync(file, new Date(), new Date())
    const r3 = new ResRecorder()
    serve(file, 'no-cache', fakeReq(etag1), r3 as unknown as ServerResponse, 'text/html')
    assert.equal(r3.status, 200)
    assert.equal(r3.body.toString(), 'v2-longer-content')
  })

  it('returns false for missing files so the caller falls through to fallback/404', () => {
    const serve = makeServe()
    const r = new ResRecorder()
    const missing = join(tmpdir(), 'oc-static-cache-no-such-file.html')
    assert.equal(serve(missing, 'no-cache', fakeReq(), r as unknown as ServerResponse, 'text/html'), false)
    assert.equal(r.status, 0)
  })
})
