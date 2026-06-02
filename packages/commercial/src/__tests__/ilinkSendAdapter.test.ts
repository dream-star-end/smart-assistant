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
  classifyIlinkBusinessAck,
  classifyIlinkError,
  makeIlinkSendAdapter,
  makeIlinkSendMediaAdapter,
} from "../wechat/ilinkSendAdapter.js"

describe("classifyIlinkBusinessAck", () => {
  it("treats missing business fields as success for backward compatibility", () => {
    assert.deepEqual(classifyIlinkBusinessAck(undefined), { ok: true })
    assert.deepEqual(classifyIlinkBusinessAck({ data: { id: "m-1" } }), { ok: true })
  })

  it("accepts explicit zero and success status values", () => {
    assert.deepEqual(classifyIlinkBusinessAck({ errno: 0 }), { ok: true })
    assert.deepEqual(classifyIlinkBusinessAck({ errcode: "0" }), { ok: true })
    assert.deepEqual(classifyIlinkBusinessAck({ error_code: 0, status: "success" }), { ok: true })
    assert.deepEqual(classifyIlinkBusinessAck({ result: "ok" }), { ok: true })
    assert.deepEqual(classifyIlinkBusinessAck({ state: "succeeded" }), { ok: true })
  })

  it("classifies strict non-zero business error fields as transient failure", () => {
    const r = classifyIlinkBusinessAck({ errno: 45009, errmsg: "rate limit" })
    assert.equal(r.ok, false)
    assert.equal(r.permanent, false)
    assert.equal(r.errMessage, "rate limit")
    assert.equal(r.reasonField, "errno")
    assert.equal(r.reasonValue, 45009)
  })

  it("classifies explicit failing status strings as transient failure", () => {
    const r = classifyIlinkBusinessAck({ status: "failed", message: "send rejected" })
    assert.equal(r.ok, false)
    assert.equal(r.permanent, false)
    assert.equal(r.errMessage, "send rejected")
    assert.equal(r.reasonField, "status")
  })

  it("classifies non-zero ret as transient failure", () => {
    const r = classifyIlinkBusinessAck({ ret: -2 })
    assert.equal(r.ok, false)
    assert.equal(r.permanent, false)
    assert.match(r.errMessage ?? "", /ret=-2/)
    assert.equal(r.reasonField, "ret")
    assert.equal(r.reasonValue, -2)
  })

  it("does not treat broad code values as failure unless paired with failing status", () => {
    assert.deepEqual(classifyIlinkBusinessAck({ code: 200, message: "OK" }), { ok: true })

    const r = classifyIlinkBusinessAck({ code: 123, status: "error", message: "business rejected" })
    assert.equal(r.ok, false)
    assert.equal(r.permanent, false)
    assert.equal(r.errMessage, "business rejected")
  })

  it("classifies broad code fields when paired with strong error message fields", () => {
    const r = classifyIlinkBusinessAck({ code: "2", errmsg: "send limit reached" })
    assert.equal(r.ok, false)
    assert.equal(r.permanent, false)
    assert.equal(r.errMessage, "send limit reached")
    assert.equal(r.reasonField, "code")
  })
})

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

  it("business error response returns transient failure for media", async () => {
    const adapter = makeIlinkSendMediaAdapter({
      sendIlinkMedia: async () => ({ errcode: "93000", errmsg: "media rejected" }),
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
    assert.equal(r.errMessage, "media rejected")
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

  it("business success response returns {ok:true} for text", async () => {
    const adapter = makeIlinkSendAdapter({
      sendIlinkText: async () => ({ errno: "0", status: "success" }),
    })
    const r = await adapter({ botToken: "x", toUserId: "y", contextToken: "z", text: "t" })
    assert.deepEqual(r, { ok: true })
  })

  it("business error response returns transient failure for text", async () => {
    const adapter = makeIlinkSendAdapter({
      sendIlinkText: async () => ({ error_code: 47001, message: "bad request" }),
    })
    const r = await adapter({ botToken: "x", toUserId: "y", contextToken: "z", text: "t" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.permanent, false)
    assert.equal(r.errMessage, "bad request")
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

  it("hung text send times out as transient failure", async () => {
    const adapter = makeIlinkSendAdapter({
      sendTimeoutMs: 5,
      sendIlinkText: async () => new Promise(() => {}),
    })
    const r = await adapter({ botToken: "x", toUserId: "y", contextToken: "z", text: "t" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.permanent, false)
    assert.match(r.errMessage ?? "", /timeout/)
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
