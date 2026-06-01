/**
 * Tests for `ilinkSendAdapter` — outbox SendTextFn 实装(iLink HTTP wrapper)。
 *
 * 关键不变量(slice 7b + Codex 7b plan PASS):
 *   1. 成功 → `{ok:true}`
 *   2. `iLink HTTP 401|403|404|410` 前缀 → permanent:true (broker forceFail 不复活)
 *   3. `iLink HTTP 5xx` 前缀 → permanent:false (transient,outbox 按 attempts cap 重试)
 *   4. `iLink returned non-JSON: ...` → permanent:false
 *   5. 网络层 throw(无 iLink HTTP 前缀)→ permanent:false
 *   6. 调用入参 (botToken/toUserId/contextToken/text) 透传正确
 *   7. 永远不向上抛(outboxWorker.drainOne 期望 SendTextFn 永远 return SendResult)
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/ilinkSendAdapter.test.ts
 */
import * as assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  classifyIlinkError,
  makeIlinkSendAdapter,
  makeIlinkSendMediaAdapter,
} from "../wechat/ilinkSendAdapter.js"

describe("classifyIlinkError", () => {
  it("classifies permanent statuses (401/403/404/410)", () => {
    for (const status of [401, 403, 404, 410]) {
      const r = classifyIlinkError(new Error(`iLink HTTP ${status}: forbidden`))
      assert.equal(r.permanent, true, `${status} must be permanent`)
      assert.match(r.errMessage, new RegExp(`HTTP ${status}`))
    }
  })

  it("classifies 5xx as transient (not permanent)", () => {
    for (const status of [500, 502, 503, 504]) {
      const r = classifyIlinkError(new Error(`iLink HTTP ${status}: unavailable`))
      assert.equal(r.permanent, false, `${status} must be transient`)
    }
  })

  it("classifies other 4xx as transient (429 / 400 fall through to outbox attempts cap)", () => {
    for (const status of [400, 408, 413, 429]) {
      const r = classifyIlinkError(new Error(`iLink HTTP ${status}: rate-limited`))
      assert.equal(r.permanent, false, `${status} stays transient (attempts cap eventually terminates)`)
    }
  })

  it("classifies non-JSON parse error as transient", () => {
    const r = classifyIlinkError(new Error("iLink returned non-JSON: <html>..."))
    assert.equal(r.permanent, false)
  })

  it("classifies generic network error as transient", () => {
    const r = classifyIlinkError(new Error("connect ECONNREFUSED 1.2.3.4:443"))
    assert.equal(r.permanent, false)
  })

  it("non-Error throw (string / undefined) → transient with stringified message", () => {
    const r = classifyIlinkError("plain string thrown" as unknown)
    assert.equal(r.permanent, false)
    assert.equal(r.errMessage, "plain string thrown")
  })
})

describe("makeIlinkSendMediaAdapter", () => {
  it("happy path: returns {ok:true} and forwards resolved media bytes", async () => {
    const calls: Array<{
      token: string
      toUserId: string
      kind: string
      filename: string
      contextToken: string
      bytes: number
    }> = []
    const adapter = makeIlinkSendMediaAdapter({
      sendIlinkMedia: async (token, toUserId, input) => {
        calls.push({
          token,
          toUserId,
          kind: input.kind,
          filename: input.filename,
          contextToken: input.contextToken,
          bytes: input.content.length,
        })
        return { ok: 1 }
      },
    })
    const r = await adapter({
      botToken: "tok-1",
      toUserId: "wxid_alice",
      contextToken: "ctx-1",
      media: {
        kind: "image",
        filename: "result.png",
        mimeType: "image/png",
        content: Buffer.from("png"),
      },
    })
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(calls, [
      {
        token: "tok-1",
        toUserId: "wxid_alice",
        kind: "image",
        filename: "result.png",
        contextToken: "ctx-1",
        bytes: 3,
      },
    ])
  })

  it("classifies media send errors and never throws upward", async () => {
    const adapter = makeIlinkSendMediaAdapter({
      sendIlinkMedia: async () => {
        throw new Error("iLink HTTP 503: maintenance")
      },
    })
    const r = await adapter({
      botToken: "x",
      toUserId: "y",
      contextToken: "z",
      media: {
        kind: "file",
        filename: "report.pdf",
        content: Buffer.from("%PDF"),
      },
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.permanent, false)
    assert.match(r.errMessage ?? "", /HTTP 503/)
  })
})

describe("makeIlinkSendAdapter", () => {
  it("happy path: returns {ok:true} on successful send + forwards args correctly", async () => {
    const calls: Array<{ token: string; toUserId: string; contextToken: string; text: string }> = []
    const adapter = makeIlinkSendAdapter({
      sendIlinkText: async (token, toUserId, contextToken, text) => {
        calls.push({ token, toUserId, contextToken, text })
        return { ok: 1 }
      },
    })
    const r = await adapter({
      botToken: "tok-1",
      toUserId: "wxid_alice",
      contextToken: "ctx-1",
      text: "hello",
    })
    assert.deepEqual(r, { ok: true })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
      token: "tok-1",
      toUserId: "wxid_alice",
      contextToken: "ctx-1",
      text: "hello",
    })
  })

  it("permanent error: iLink HTTP 401 → {ok:false, permanent:true}", async () => {
    const adapter = makeIlinkSendAdapter({
      sendIlinkText: async () => {
        throw new Error("iLink HTTP 401: invalid token")
      },
    })
    const r = await adapter({ botToken: "x", toUserId: "y", contextToken: "z", text: "t" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.permanent, true)
    assert.match(r.errMessage ?? "", /HTTP 401/)
  })

  it("transient error: iLink HTTP 503 → {ok:false, permanent:false}", async () => {
    const adapter = makeIlinkSendAdapter({
      sendIlinkText: async () => {
        throw new Error("iLink HTTP 503: maintenance")
      },
    })
    const r = await adapter({ botToken: "x", toUserId: "y", contextToken: "z", text: "t" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.permanent, false)
  })

  it("network error throw → {ok:false, permanent:false}", async () => {
    const adapter = makeIlinkSendAdapter({
      sendIlinkText: async () => {
        throw new Error("connect ECONNREFUSED 1.2.3.4:443")
      },
    })
    const r = await adapter({ botToken: "x", toUserId: "y", contextToken: "z", text: "t" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.permanent, false)
  })

  it("non-JSON response throw → {ok:false, permanent:false}", async () => {
    const adapter = makeIlinkSendAdapter({
      sendIlinkText: async () => {
        throw new Error("iLink returned non-JSON: <html>...")
      },
    })
    const r = await adapter({ botToken: "x", toUserId: "y", contextToken: "z", text: "t" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.permanent, false)
  })

  it("never throws upward (outboxWorker.drainOne contract)", async () => {
    const adapter = makeIlinkSendAdapter({
      sendIlinkText: async () => {
        // Throw something pathological
        throw "raw string thrown" as unknown as Error
      },
    })
    // Must resolve to SendResult, not reject
    const r = await adapter({ botToken: "x", toUserId: "y", contextToken: "z", text: "t" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.permanent, false)
    assert.equal(r.errMessage, "raw string thrown")
  })
})
