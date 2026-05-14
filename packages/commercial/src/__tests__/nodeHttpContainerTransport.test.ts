/**
 * Tests for `nodeHttpContainerTransport` — self-host ContainerTransport 实装。
 *
 * 关键不变量(slice 7b + Codex 7b plan PASS):
 *   1. happy 200:body / status / lower-cased headers 正确返回
 *   2. 202 retry-after 解析(dispatcher.parseRetryAfterSec 上层用)
 *   3. 5xx 是合法 response(不 throw,dispatcher 上层按 status code 分流)
 *   4. timeout → reject `TRANSPORT_TIMEOUT_ERROR`(req.destroy 后 settled 拦截二次回调)
 *   5. body cap 64 KB:截断、不 throw、destroy req,数据被 truncate 不溢出
 *   6. SSRF 默认 strict (172.30/16);test seam 注入 isHostAllowed 才允许 127.0.0.1
 *   7. tunnel endpoint → throw(防御性,dispatcher 上游已拦但留兜底)
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/nodeHttpContainerTransport.test.ts
 */
import * as assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  TRANSPORT_BODY_CAP_ERROR,
  TRANSPORT_HOST_BLOCKED_ERROR,
  TRANSPORT_TIMEOUT_ERROR,
  defaultIsHostAllowed,
  makeNodeHttpContainerTransport,
} from "../wechat/nodeHttpContainerTransport.js"

let server: Server | null = null
let port = 0

function startServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address()
      if (addr && typeof addr === "object") port = addr.port
      resolve()
    })
  })
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

describe("defaultIsHostAllowed", () => {
  it("only allows 172.30.0.0/16 IPv4 addresses", () => {
    assert.equal(defaultIsHostAllowed("172.30.0.1"), true)
    assert.equal(defaultIsHostAllowed("172.30.255.255"), true)
    assert.equal(defaultIsHostAllowed("172.31.0.1"), false)
    assert.equal(defaultIsHostAllowed("127.0.0.1"), false)
    assert.equal(defaultIsHostAllowed("10.0.0.1"), false)
    assert.equal(defaultIsHostAllowed("172.30.0.1.5"), false) // 非 IPv4
    assert.equal(defaultIsHostAllowed("localhost"), false) // hostname 不接受
    assert.equal(defaultIsHostAllowed(""), false)
  })
})

describe("makeNodeHttpContainerTransport", () => {
  it("happy 200: body / status / lower-cased headers 正确返回", async () => {
    let receivedBody = ""
    let receivedPath = ""
    let receivedHeaders: Record<string, string | string[] | undefined> = {}
    await startServer((req, res) => {
      receivedPath = req.url ?? ""
      receivedHeaders = req.headers
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf-8")
        res.writeHead(200, { "Content-Type": "application/json", "X-Foo": "bar" })
        res.end(JSON.stringify({ ok: true, echo: receivedBody }))
      })
    })
    const tr = makeNodeHttpContainerTransport({ isHostAllowed: () => true })
    const r = await tr.post(
      { host: "127.0.0.1", port },
      "/internal/v3/wechat-inbound",
      { "x-foo": "hi", "content-type": "application/json" },
      JSON.stringify({ hello: "world" }),
      5_000,
    )
    assert.equal(r.status, 200)
    assert.equal(receivedPath, "/internal/v3/wechat-inbound")
    assert.equal(receivedHeaders["x-foo"], "hi")
    assert.equal(receivedBody, '{"hello":"world"}')
    const parsed = JSON.parse(r.bodyText) as { ok: boolean; echo: string }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.echo, '{"hello":"world"}')
    // headers normalized to lower-case
    assert.ok(r.headers)
    assert.equal(r.headers!["content-type"], "application/json")
    assert.equal(r.headers!["x-foo"], "bar")
  })

  it("202 cold-start: status + body retryAfterSec round-trips", async () => {
    await startServer((_req, res) => {
      res.writeHead(202, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ coldStart: true, retryAfterSec: 7 }))
    })
    const tr = makeNodeHttpContainerTransport({ isHostAllowed: () => true })
    const r = await tr.post({ host: "127.0.0.1", port }, "/p", {}, "{}", 5_000)
    assert.equal(r.status, 202)
    const parsed = JSON.parse(r.bodyText) as { retryAfterSec: number }
    assert.equal(parsed.retryAfterSec, 7)
  })

  it("5xx is a legitimate response (not thrown) — caller categorizes by status", async () => {
    await startServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end('{"error":"unavailable"}')
    })
    const tr = makeNodeHttpContainerTransport({ isHostAllowed: () => true })
    const r = await tr.post({ host: "127.0.0.1", port }, "/p", {}, "{}", 5_000)
    assert.equal(r.status, 503)
    assert.equal(r.bodyText, '{"error":"unavailable"}')
  })

  it("timeout: server delays end past timeoutMs → reject TRANSPORT_TIMEOUT_ERROR", async () => {
    await startServer((req, res) => {
      // 服务端故意永远不 end,等 transport 把 socket 超时掉
      req.on("data", () => undefined)
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.write('{"slow":')
        // never end
      })
    })
    const tr = makeNodeHttpContainerTransport({ isHostAllowed: () => true })
    await assert.rejects(
      tr.post({ host: "127.0.0.1", port }, "/p", {}, "{}", 100),
      (err: Error) => {
        assert.match(err.message, new RegExp(TRANSPORT_TIMEOUT_ERROR))
        return true
      },
    )
  })

  it("timeout: slowloris drip (1 byte / 50 ms below cap) → absolute timer fires", async () => {
    // Codex 7b r1 must-fix:`req.setTimeout` 是 socket idle timeout,server 每 50 ms
    // drip 1 byte 会持续 reset 而永不触发 timeout。绝对 deadline 必须独立触发。
    // 这条单测把 timeoutMs=200 ms 下让 server 滴 10 个 byte(超 200 ms),验证 transport
    // 在 deadline 处 reject TIMEOUT,而不是等到 server 自然 end 后才解锁。
    await startServer((req, res) => {
      req.on("data", () => undefined)
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" })
        let i = 0
        const tick = setInterval(() => {
          if (i >= 20 || res.writableEnded || res.destroyed) {
            clearInterval(tick)
            try { res.end() } catch { /* socket already destroyed by transport */ }
            return
          }
          try { res.write("x") } catch { clearInterval(tick) }
          i++
        }, 50)
      })
    })
    const tr = makeNodeHttpContainerTransport({ isHostAllowed: () => true })
    const t0 = Date.now()
    await assert.rejects(
      tr.post({ host: "127.0.0.1", port }, "/p", {}, "{}", 200),
      (err: Error) => {
        assert.match(err.message, new RegExp(TRANSPORT_TIMEOUT_ERROR))
        return true
      },
    )
    const elapsed = Date.now() - t0
    // 绝对 deadline 200 ms 后必须触发;给 200-450 ms 容差(CI 抖动)。1 s 是 server
    // 自然 end 的下限(20 ticks × 50 ms = 1000 ms),触发若发生在 1 s+ 等于 idle reset
    // 漏防,bug 仍在。
    assert.ok(elapsed >= 180, `elapsed=${elapsed}ms must be ≥ ~timeoutMs`)
    assert.ok(elapsed < 800, `elapsed=${elapsed}ms must be < server natural end (1 s) — absolute timer not reset by drip`)
  })

  it("body cap 64 KB: large response truncated, no throw, no buffer overflow", async () => {
    // 服务端发 80 KB body,transport 应只接受 64 KB 并 settle
    const BIG = "a".repeat(80 * 1024)
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(BIG.length) })
      res.end(BIG)
    })
    const tr = makeNodeHttpContainerTransport({ isHostAllowed: () => true })
    const r = await tr.post({ host: "127.0.0.1", port }, "/p", {}, "{}", 5_000)
    assert.equal(r.status, 200)
    assert.equal(r.bodyText.length, 64 * 1024, "body truncated to 64 KB exactly")
    assert.ok(r.bodyText.startsWith("a"), "first byte preserved")
    // 确认不是 throw — 测试本身完成即说明 no exception
    void TRANSPORT_BODY_CAP_ERROR // 引用一次保模块导出存在
  })

  it("SSRF: default policy rejects non-bridge host with TRANSPORT_HOST_BLOCKED_ERROR", async () => {
    const tr = makeNodeHttpContainerTransport() // 不注入 isHostAllowed → strict 172.30/16
    await assert.rejects(
      tr.post({ host: "127.0.0.1", port: 1 }, "/p", {}, "{}", 5_000),
      (err: Error) => {
        assert.equal(err.message, TRANSPORT_HOST_BLOCKED_ERROR)
        return true
      },
    )
  })

  it("SSRF: non-IPv4 host (hostname / IPv6) blocked even via injected isHostAllowed default", async () => {
    const tr = makeNodeHttpContainerTransport() // strict
    await assert.rejects(
      tr.post({ host: "container.local", port: 80 }, "/p", {}, "{}", 5_000),
      (err: Error) => {
        assert.equal(err.message, TRANSPORT_HOST_BLOCKED_ERROR)
        return true
      },
    )
  })

  it("tunnel endpoint always rejected (supportsTunnel:false defense)", async () => {
    const tr = makeNodeHttpContainerTransport({ isHostAllowed: () => true })
    await assert.rejects(
      tr.post(
        { host: "127.0.0.1", port: 1, tunnel: { foo: "bar" } },
        "/p",
        {},
        "{}",
        5_000,
      ),
      /does not support tunnel/,
    )
  })

  it("supportsTunnel === false", () => {
    const tr = makeNodeHttpContainerTransport()
    assert.equal(tr.supportsTunnel, false)
  })
})
