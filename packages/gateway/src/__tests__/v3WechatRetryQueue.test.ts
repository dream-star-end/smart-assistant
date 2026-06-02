/**
 * V3 wechat outbound durable retry queue unit tests.
 *
 * Mirrors v3MasterRetryQueue test scope, with wechat-specific payload schema:
 *   - enqueueDurable writes one .json file (atomic rename)
 *   - drainOnce: 2xx success → unlinks; transient → bumps attempts + rewrites;
 *     fatal V3WechatSinkError → unlinks except final message payloads, which
 *     get bounded retry so master can clear running-session state; TTL drops; ENOENT-tolerant;
 *     malformed JSON / schema mismatch drops.
 *   - kick is single-flight (concurrent kicks coalesce to one drain pass)
 *   - pendingCount reflects on-disk state including after rewrites
 *   - skips .tmp-* and non-.json files
 *   - isV3WechatRetryEntry guard catches non-wsess sessionId, bad outboundId
 *     charset, missing peer.meta.senderId, empty blocks
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/v3WechatRetryQueue.test.ts
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { before, after, beforeEach, describe, test } from "node:test"

import {
  ENTRY_TTL_MS,
  FINAL_FATAL_MAX_ATTEMPTS,
  makeV3WechatRetryQueue,
  V3WechatSinkError,
  type V3WechatCodexBillingWirePayload,
  type V3WechatRetryEntry,
  type V3WechatSinkWirePayload,
} from "../v3WechatRetryQueue.js"

let dir: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "v3-wechat-retry-test-"))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  try {
    const names = await readdir(dir)
    await Promise.all(names.map((n) => rm(join(dir, n), { force: true })))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  await mkdir(dir, { recursive: true })
})

const SESSION_ID = "wsess-0123456789abcdef"
const SENDER_ID = "wx-sender-abc"

function basePayload(over: Partial<V3WechatSinkWirePayload> = {}): V3WechatSinkWirePayload {
  return {
    sessionId: SESSION_ID,
    channel: "wechat",
    agentId: "main",
    outboundId: "out12345",
    peer: { kind: "dm", meta: { senderId: SENDER_ID } },
    blocks: [{ kind: "text", text: "hi" }],
    createdAt: Date.now(),
    ...over,
  }
}

function entry(payload: V3WechatRetryEntry["payload"] = basePayload()): V3WechatRetryEntry {
  return {
    schemaVersion: 1,
    payload,
    firstSeenAt: Date.now(),
    attempts: 1,
  }
}

function billingPayload(over: Partial<V3WechatCodexBillingWirePayload> = {}): V3WechatCodexBillingWirePayload {
  return {
    type: "outbound.codex_billing",
    requestId: "0123456789abcdef0123456789abcdef",
    status: "success",
    durationMs: 123,
    usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
  }
}

/** Hangs forever — so enqueueDurable's auto-kick doesn't consume the entry. */
function neverResolves(): () => Promise<void> {
  return () => new Promise<void>(() => {})
}

describe("enqueueDurable + pendingCount", () => {
  test("writes a single .json file; pendingCount = 1", async () => {
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    await q.enqueueDurable(entry())
    const names = await readdir(dir)
    const jsons = names.filter((n) => n.endsWith(".json") && !n.includes(".tmp-"))
    assert.equal(jsons.length, 1)
    assert.equal(await q.pendingCount(), 1)
  })

  test("multiple enqueues are independent files", async () => {
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    await q.enqueueDurable(entry())
    await q.enqueueDurable(entry(basePayload({ outboundId: "out67890" })))
    assert.equal(await q.pendingCount(), 2)
  })

  test("accepts codex billing sideband payloads", async () => {
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    await q.enqueueDurable(entry(billingPayload()))
    assert.equal(await q.pendingCount(), 1)
  })

  test("pendingCount skips .tmp-* and non-.json", async () => {
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    await writeFile(join(dir, "stale.tmp-1234"), "junk")
    await writeFile(join(dir, "readme.txt"), "not a queue entry")
    await q.enqueueDurable(entry())
    assert.equal(await q.pendingCount(), 1)
  })
})

describe("drainOnce", () => {
  test("success → unlink entry", async () => {
    let attempts = 0
    const q = makeV3WechatRetryQueue({
      dir,
      attemptSend: async () => {
        attempts++
      },
    })
    await q.enqueueDurable(entry())
    // wait for auto-kick to drain
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await q.pendingCount(), 0)
    assert.ok(attempts >= 1)
  })

  test("billing sideband drains through the same durable retry queue", async () => {
    const sent: unknown[] = []
    const q = makeV3WechatRetryQueue({
      dir,
      attemptSend: async (payload) => {
        sent.push(payload)
      },
    })
    await q.enqueueDurable(entry(billingPayload()))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await q.pendingCount(), 0)
    assert.deepEqual(sent[0], billingPayload())
  })

  test("transient → bump attempts + rewrite", async () => {
    const q = makeV3WechatRetryQueue({
      dir,
      attemptSend: neverResolves(), // prevent auto-kick consumption
    })
    await q.enqueueDurable(entry())
    // Drain with a transient-throwing sender directly
    const q2 = makeV3WechatRetryQueue({
      dir,
      attemptSend: async () => {
        throw new V3WechatSinkError("master 503", "transient", 503)
      },
    })
    const stats = await q2.drainOnce()
    assert.equal(stats.considered, 1)
    assert.equal(stats.retried, 1)
    assert.equal(stats.pending, 1)
    assert.equal(stats.drained, 0)
    assert.equal(stats.fatalDropped, 0)
    assert.equal(await q.pendingCount(), 1, "entry stays on disk")
    // Verify attempts bumped
    const names = await readdir(dir)
    const fname = names.find((n) => n.endsWith(".json"))!
    const raw = JSON.parse(await readFile(join(dir, fname), "utf8")) as V3WechatRetryEntry
    assert.equal(raw.attempts, 2, "attempts bumped from 1 → 2")
    assert.equal(raw.lastErrorClass, "transient")
    assert.match(raw.lastErrorMessage ?? "", /master 503/)
  })

  test("fatal → unlink entry (terminal)", async () => {
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    await q.enqueueDurable(entry())
    const q2 = makeV3WechatRetryQueue({
      dir,
      attemptSend: async () => {
        throw new V3WechatSinkError("master 404", "fatal", 404)
      },
    })
    const stats = await q2.drainOnce()
    assert.equal(stats.fatalDropped, 1)
    assert.equal(await q.pendingCount(), 0, "fatal entry must be unlinked")
  })

  test("fatal final message → bounded retry so final can clear running state", async () => {
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    await q.enqueueDurable(entry(basePayload({ isFinal: true })))
    const q2 = makeV3WechatRetryQueue({
      dir,
      attemptSend: async () => {
        throw new V3WechatSinkError("master final 401", "fatal", 401)
      },
    })
    const stats = await q2.drainOnce()
    assert.equal(stats.fatalDropped, 0)
    assert.equal(stats.retried, 1)
    assert.equal(stats.pending, 1)
    assert.equal(await q.pendingCount(), 1, "final entry stays on disk")
    const names = await readdir(dir)
    const fname = names.find((n) => n.endsWith(".json"))!
    const raw = JSON.parse(await readFile(join(dir, fname), "utf8")) as V3WechatRetryEntry
    assert.equal(raw.attempts, 2)
    assert.equal(raw.lastErrorClass, "fatal")
    assert.equal((raw.payload as V3WechatSinkWirePayload).isFinal, true)
  })

  test("fatal final message at max attempts → unlink", async () => {
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    const maxed = entry(basePayload({ isFinal: true }))
    maxed.attempts = FINAL_FATAL_MAX_ATTEMPTS
    await q.enqueueDurable(maxed)
    const q2 = makeV3WechatRetryQueue({
      dir,
      attemptSend: async () => {
        throw new V3WechatSinkError("master final 401", "fatal", 401)
      },
    })
    const stats = await q2.drainOnce()
    assert.equal(stats.fatalDropped, 1)
    assert.equal(stats.retried, 0)
    assert.equal(stats.pending, 0)
    assert.equal(await q.pendingCount(), 0, "permanent fatal final is bounded")
  })

  test("TTL exceeded → drop + warn", async () => {
    const old = entry()
    old.firstSeenAt = Date.now() - (ENTRY_TTL_MS + 1_000) // 1s past TTL
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    await q.enqueueDurable(old)
    const q2 = makeV3WechatRetryQueue({
      dir,
      attemptSend: async () => {
        assert.fail("attemptSend must not be called for TTL-exceeded entry")
      },
    })
    const stats = await q2.drainOnce()
    assert.equal(stats.ttlDropped, 1)
    assert.equal(await q.pendingCount(), 0)
  })

  test("malformed JSON → unlink", async () => {
    await writeFile(join(dir, "1700000000000-deadbeef.json"), "{not json")
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    const stats = await q.drainOnce()
    assert.equal(stats.fatalDropped, 1)
    assert.equal(await q.pendingCount(), 0)
  })

  test("schema mismatch (non-wsess sessionId) → unlink", async () => {
    // 防止旧 schema / 注入 entry 反复 POST 注定 400 fatal
    const bad = entry(basePayload({ sessionId: "personal-sess-xyz" as any }))
    await writeFile(join(dir, "1700000000000-cafecafe.json"), JSON.stringify(bad))
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    const stats = await q.drainOnce()
    assert.equal(stats.fatalDropped, 1)
  })

  test("schema mismatch (bad outboundId charset) → unlink", async () => {
    const bad = entry(basePayload({ outboundId: "has spaces" }))
    await writeFile(join(dir, "1700000000000-cafecafe.json"), JSON.stringify(bad))
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    const stats = await q.drainOnce()
    assert.equal(stats.fatalDropped, 1)
  })

  test("schema mismatch (missing peer.meta.senderId) → unlink", async () => {
    const bad = {
      ...entry(),
      payload: {
        ...basePayload(),
        peer: { kind: "dm" }, // no meta
      },
    }
    await writeFile(join(dir, "1700000000000-cafecafe.json"), JSON.stringify(bad))
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    const stats = await q.drainOnce()
    assert.equal(stats.fatalDropped, 1)
  })

  test("schema mismatch (empty blocks) → unlink", async () => {
    const bad = entry(basePayload({ blocks: [] }))
    await writeFile(join(dir, "1700000000000-cafecafe.json"), JSON.stringify(bad))
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    const stats = await q.drainOnce()
    assert.equal(stats.fatalDropped, 1)
  })

  test("schema mismatch (bad billing requestId) → unlink", async () => {
    const bad = entry(billingPayload({ requestId: "BAD" }))
    await writeFile(join(dir, "1700000000000-cafecafe.json"), JSON.stringify(bad))
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    const stats = await q.drainOnce()
    assert.equal(stats.fatalDropped, 1)
  })

  test("ENOENT-tolerant when dir doesn't exist", async () => {
    const q = makeV3WechatRetryQueue({
      dir: join(tmpdir(), `v3-wechat-no-such-${Date.now()}`),
      attemptSend: neverResolves(),
    })
    const stats = await q.drainOnce()
    assert.equal(stats.considered, 0)
  })

  test("skips .tmp-* files during drain", async () => {
    await writeFile(join(dir, "1700000000000-cafecafe.json.tmp-9999-abcd"), "junk")
    const q = makeV3WechatRetryQueue({ dir, attemptSend: neverResolves() })
    const stats = await q.drainOnce()
    assert.equal(stats.considered, 0)
  })
})

describe("kick + single-flight", () => {
  test("concurrent kicks coalesce", async () => {
    let active = 0
    let maxActive = 0
    const q = makeV3WechatRetryQueue({
      dir,
      attemptSend: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
      },
    })
    await q.enqueueDurable(entry())
    q.kick()
    q.kick()
    q.kick()
    // Wait long enough for both passes to settle
    await new Promise((r) => setTimeout(r, 100))
    // No concurrent attempt — single-flight invariant
    assert.equal(maxActive, 1)
  })
})
