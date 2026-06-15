/**
 * v3 commercial wechat proactiveReceiver — HTTP handler 单测。
 *
 * 覆盖:
 *   - method gate(405 non-POST)
 *   - identity gate(401 bad auth)
 *   - body schema(缺 text / 缺 outboundId / 带 senderId 被 strict 拒 → 400)
 *   - 决策链 outcome(全部 HTTP 200):
 *       pref_off(偏好关) → 不解析收件人
 *       no_binding(无 active 绑定)
 *       no_context_token(绑定但 contextTokens 缺 senderId)
 *       no_session(无 wsess 指针)
 *       empty_render(文本渲染空)
 *       queued(全满足 → enqueue)
 *   - trust boundary:senderId 取自 resolveRecipient(master 权威),body 不可指定
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wechatProactiveReceiver.test.ts
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { Readable } from "node:stream"
import { ServerResponse, IncomingMessage } from "node:http"
import { createHash } from "node:crypto"
import type { Pool } from "pg"

import {
  makeProactiveReceiverHandler,
  WECHAT_PROACTIVE_PATH,
  type ProactiveReceiverDeps,
} from "../wechat/proactiveReceiver.js"
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js"

// ─── fixtures ──────────────────────────────────────────────────────────────

const VALID_SECRET = "a".repeat(64)
const VALID_TOKEN = `oc-v3.7.${VALID_SECRET}`
const VALID_HOST = "host-uuid-1"
const VALID_IP = "172.30.0.5"
const VALID_USER_ID = 42
const VALID_SESSION_ID = "wsess-0123456789abcdef"
const LOGIN_USER_ID = "wx-login-1"
const CTX = { hostUuid: VALID_HOST, boundIp: VALID_IP }

function makeRepo(): ContainerIdentityRepo {
  const secretHash = createHash("sha256").update(Buffer.from(VALID_SECRET, "hex")).digest()
  return {
    async findActiveByHostAndBoundIp(h, ip) {
      if (h !== VALID_HOST || ip !== VALID_IP) return null
      return { id: 7, user_id: VALID_USER_ID, bound_ip: VALID_IP, host_uuid: VALID_HOST, secret_hash: secretHash }
    },
  }
}

function makeReq(opts: { method?: string; body?: string; auth?: string }): IncomingMessage {
  const buf = Buffer.from(opts.body ?? "", "utf8")
  const req = Readable.from(buf.length > 0 ? [buf] : []) as unknown as IncomingMessage
  req.method = opts.method ?? "POST"
  req.url = WECHAT_PROACTIVE_PATH
  req.headers = {}
  if (opts.auth) req.headers.authorization = opts.auth
  return req
}

interface Rec {
  status?: number
  body: string
  ended: boolean
}

function makeRes(): { res: ServerResponse; rec: Rec } {
  const rec: Rec = { body: "", ended: false }
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    end(chunk?: string) {
      if (chunk !== undefined) rec.body += String(chunk)
      rec.status = (res as unknown as { statusCode: number }).statusCode
      rec.ended = true
    },
  } as unknown as ServerResponse
  return { res, rec }
}

/** Minimal fake Pool — 仅支撑 enqueue 的 BEGIN/INSERT(queued)/COMMIT。 */
function makeFakePool(): { pool: Pool; inserts: Array<Record<string, unknown>> } {
  const inserts: Array<Record<string, unknown>> = []
  const respond = (sql: string, params: ReadonlyArray<unknown> = []) => {
    const t = sql.trim().toUpperCase()
    if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") return { rows: [], rowCount: 0 }
    if (/INSERT INTO wechat_outbox/.test(sql)) {
      inserts.push({
        outboundId: params[0],
        bindingUserId: params[1],
        senderId: params[2],
        sessionId: params[3],
        payload: typeof params[4] === "string" ? JSON.parse(params[4] as string) : params[4],
      })
      return { rows: [{ id: 99 }], rowCount: 1 } // queued
    }
    throw new Error(`fakePool: unhandled SQL ${sql.slice(0, 60)}`)
  }
  const client = { query: async (s: string, p?: ReadonlyArray<unknown>) => respond(s, p), release: () => {} }
  const pool = {
    query: async (s: string, p?: ReadonlyArray<unknown>) => respond(s, p),
    connect: async () => client,
  } as unknown as Pool
  return { pool, inserts }
}

function makeDeps(overrides: Partial<ProactiveReceiverDeps> = {}): ProactiveReceiverDeps {
  return {
    identityRepo: makeRepo(),
    pool: makeFakePool().pool,
    resolveRecipient: async () => ({ senderId: LOGIN_USER_ID, contextTokens: { [LOGIN_USER_ID]: "ctx-tok" } }),
    isProactiveEnabled: async () => true,
    getSessionId: async () => VALID_SESSION_ID,
    now: () => 1_700_000_000_000,
    ...overrides,
  }
}

const validBodyStr = JSON.stringify({ text: "提醒:该喝水了", outboundId: "ob-12345678" })

async function run(deps: ProactiveReceiverDeps, reqOpts: Parameters<typeof makeReq>[0]) {
  const handler = makeProactiveReceiverHandler(deps)
  const { res, rec } = makeRes()
  await handler(makeReq(reqOpts), res, CTX)
  return rec
}

function outcomeOf(rec: Rec): string {
  return (JSON.parse(rec.body) as { outcome: string }).outcome
}

// ─── tests ───────────────────────────────────────────────────────────────

describe("proactiveReceiver", () => {
  test("405 on non-POST", async () => {
    const rec = await run(makeDeps(), { method: "GET", auth: `Bearer ${VALID_TOKEN}` })
    assert.equal(rec.status, 405)
  })

  test("401 on bad identity", async () => {
    const rec = await run(makeDeps(), { body: validBodyStr, auth: "Bearer oc-v3.7.deadbeef" })
    assert.equal(rec.status, 401)
  })

  test("400 on missing text", async () => {
    const rec = await run(makeDeps(), { body: JSON.stringify({ outboundId: "ob-12345678" }), auth: `Bearer ${VALID_TOKEN}` })
    assert.equal(rec.status, 400)
  })

  test("400 on body trying to specify senderId (strict)", async () => {
    const rec = await run(makeDeps(), {
      body: JSON.stringify({ text: "x", outboundId: "ob-12345678", senderId: "attacker" }),
      auth: `Bearer ${VALID_TOKEN}`,
    })
    assert.equal(rec.status, 400)
  })

  test("pref_off → 200, recipient NOT resolved", async () => {
    let resolveCalled = false
    const deps = makeDeps({
      isProactiveEnabled: async () => false,
      resolveRecipient: async () => {
        resolveCalled = true
        return { senderId: LOGIN_USER_ID, contextTokens: { [LOGIN_USER_ID]: "t" } }
      },
    })
    const rec = await run(deps, { body: validBodyStr, auth: `Bearer ${VALID_TOKEN}` })
    assert.equal(rec.status, 200)
    assert.equal(outcomeOf(rec), "pref_off")
    assert.equal(resolveCalled, false)
  })

  test("no_binding when resolveRecipient returns null", async () => {
    const rec = await run(makeDeps({ resolveRecipient: async () => null }), {
      body: validBodyStr,
      auth: `Bearer ${VALID_TOKEN}`,
    })
    assert.equal(outcomeOf(rec), "no_binding")
  })

  test("no_context_token when contextTokens lacks senderId", async () => {
    const rec = await run(makeDeps({ resolveRecipient: async () => ({ senderId: LOGIN_USER_ID, contextTokens: {} }) }), {
      body: validBodyStr,
      auth: `Bearer ${VALID_TOKEN}`,
    })
    assert.equal(outcomeOf(rec), "no_context_token")
  })

  test("no_session when getSessionId returns null", async () => {
    const rec = await run(makeDeps({ getSessionId: async () => null }), {
      body: validBodyStr,
      auth: `Bearer ${VALID_TOKEN}`,
    })
    assert.equal(outcomeOf(rec), "no_session")
  })

  test("empty_render when text renders to nothing", async () => {
    const rec = await run(makeDeps(), {
      body: JSON.stringify({ text: "   ", outboundId: "ob-12345678" }),
      auth: `Bearer ${VALID_TOKEN}`,
    })
    assert.equal(outcomeOf(rec), "empty_render")
  })

  test("queued → enqueue uses master-resolved senderId, not body", async () => {
    const { pool, inserts } = makeFakePool()
    const rec = await run(makeDeps({ pool }), { body: validBodyStr, auth: `Bearer ${VALID_TOKEN}` })
    assert.equal(rec.status, 200)
    assert.equal(outcomeOf(rec), "queued")
    assert.equal(inserts.length, 1)
    assert.equal(inserts[0]!.senderId, LOGIN_USER_ID)
    assert.equal(inserts[0]!.bindingUserId, String(VALID_USER_ID))
    assert.equal(inserts[0]!.sessionId, VALID_SESSION_ID)
  })
})
