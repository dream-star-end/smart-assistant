/**
 * SessionManager pending-persistence tracking unit tests.
 *
 * Validates the durability hooks added for the v3 commercial container→
 * master sink (Codex R2 BLOCK-1 fix):
 *
 *   - `_trackPersistence` adds a Promise to the pending set
 *   - The Promise auto-removes from the set on settle
 *   - `awaitPendingPersistence` resolves only after every tracked
 *     Promise has settled (success or rejection — uses allSettled)
 *   - `awaitPendingPersistence` is a fast no-op when nothing is pending
 *
 * These are the contract gates that `server.ts` _doShutdown relies on:
 * stage 4 calls sessions.shutdownAll() which internally awaits the
 * pending set, and only then is the v3 sink singleton cleared. If this
 * tracking is broken, late handleExit-flush writes during shutdown
 * fall through to the legacy local SQLite path that's empty in v3.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionManagerPersistence.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { SessionManager, type AgentSession } from "../sessionManager.js";
import type { SessionStreamEvent } from "../ccbMessageParser.js";
import type { OpenClaudeConfig } from "@openclaude/storage";

// ─── Fixtures ────────────────────────────────────────────────────────────

/** Minimal OpenClaudeConfig stub. SessionManager constructor only calls
 *  `_loadResumeMap` (filesystem read with existsSync guard), so the rest
 *  of the config is unread for these tests. Cast through unknown to
 *  bypass the full structural type. */
function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
    auth: { mode: "subscription", claudeCodePath: "" },
    sessions: { dbPath: "" },
  } as unknown as OpenClaudeConfig;
}

/** Resolvable, controllable promise — useful for asserting that the
 *  awaiter blocks until we say so. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type FakeExitInfo = { code: number | null; signal: string | null; crashed: boolean };

class FakeTurnRunner extends EventEmitter {
  lastActivityAt = Date.now();

  constructor(
    private readonly onSubmit: (runner: FakeTurnRunner, requestId?: string) => void,
  ) {
    super();
  }

  interrupt(): boolean {
    return false;
  }

  async submit(
    _textOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    requestId?: string,
  ): Promise<void> {
    this.onSubmit(this, requestId);
  }

  emitExit(info: FakeExitInfo): void {
    this.emit("exit", info);
  }

  emitAssistantText(text: string): void {
    this.emit("message", {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    });
  }

  emitResult(requestId?: string): void {
    this.emit("message", {
      type: "result",
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...(requestId ? { requestId } : {}),
    });
  }
}

function makeTurnSession(runner: FakeTurnRunner): AgentSession {
  return {
    sessionKey: "agent:codex:webchat:dm:unit-peer",
    agentId: "codex",
    channel: "unit",
    peerId: "unit-peer",
    title: "Codex Unit",
    startedAt: Date.now(),
    runner,
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: "local" },
    providerTag: "codex-native",
    agentProvider: "codex-native",
    _currentMessageListener: null,
  } as unknown as AgentSession;
}

async function runPrivateOneTurn(
  sm: SessionManager,
  session: AgentSession,
  events: SessionStreamEvent[],
): Promise<void> {
  await (sm as unknown as {
    _runOneTurn: (
      session: AgentSession,
      input: string,
      onEvent: (e: SessionStreamEvent) => void,
      requestId?: string,
    ) => Promise<void>;
  })._runOneTurn(session, "hello", (e) => events.push(e), "req-unit");
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("SessionManager pending-persistence tracking", () => {
  test("awaitPendingPersistence is a no-op when set is empty", async () => {
    const sm = new SessionManager(makeConfigStub());
    const t0 = Date.now();
    await sm.awaitPendingPersistence();
    // Should resolve essentially immediately. 50ms is loose for CI noise.
    assert.ok(Date.now() - t0 < 50, "should resolve fast on empty set");
  });

  test("_trackPersistence registers and auto-removes on settle", async () => {
    const sm = new SessionManager(makeConfigStub());
    const trackPersistence = (sm as unknown as {
      _trackPersistence: (p: Promise<void>) => void;
      _pendingPersistence: Set<Promise<void>>;
    });

    const d = deferred<void>();
    trackPersistence._trackPersistence(d.promise);
    assert.equal(trackPersistence._pendingPersistence.size, 1);

    d.resolve();
    // .finally microtask + Set.delete — flush the microtask queue.
    await d.promise;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(trackPersistence._pendingPersistence.size, 0);
  });

  test("_trackPersistence absorbs rejections (set still drains)", async () => {
    const sm = new SessionManager(makeConfigStub());
    const trackPersistence = (sm as unknown as {
      _trackPersistence: (p: Promise<void>) => void;
      _pendingPersistence: Set<Promise<void>>;
    });

    // Pre-rejected promise is fine — `.finally(() => set.delete(p))`
    // still fires, and unhandled-rejection isn't triggered because
    // awaitPendingPersistence uses Promise.allSettled.
    const rejected = Promise.reject(new Error("simulated sink throw"));
    // Swallow the rejection at the source so node:test doesn't see an
    // uncaught rejection from a pre-rejected promise hanging around
    // beyond the test scope. The real `persistServerAuthoredTurn` never
    // rejects; this is just defensive.
    rejected.catch(() => {});

    trackPersistence._trackPersistence(rejected);
    await sm.awaitPendingPersistence();
    assert.equal(trackPersistence._pendingPersistence.size, 0);
  });

  test("awaitPendingPersistence blocks until every tracked promise settles", async () => {
    const sm = new SessionManager(makeConfigStub());
    const trackPersistence = (sm as unknown as {
      _trackPersistence: (p: Promise<void>) => void;
    });

    const a = deferred<void>();
    const b = deferred<void>();
    const c = deferred<void>();
    trackPersistence._trackPersistence(a.promise);
    trackPersistence._trackPersistence(b.promise);
    trackPersistence._trackPersistence(c.promise);

    let resolvedAt = 0;
    const awaiter = sm.awaitPendingPersistence().then(() => {
      resolvedAt = Date.now();
    });

    // Let the event loop spin — awaiter must NOT resolve while any
    // tracked promise is still pending.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolvedAt, 0, "awaiter resolved early");

    a.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(resolvedAt, 0, "awaiter resolved with 1/3 pending");

    b.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(resolvedAt, 0, "awaiter resolved with 2/3 pending");

    c.resolve();
    await awaiter;
    assert.ok(resolvedAt > 0, "awaiter never resolved");
  });

  test("late-added promise (after first await call) is NOT awaited", async () => {
    // This documents the deliberate snapshot semantics: awaitPendingPersistence
    // takes a snapshot of the set at call time. Promises added AFTER the call
    // are not waited on. This matches the shutdownAll contract — by the time
    // shutdownAll calls awaitPendingPersistence, runner.shutdown() has already
    // resolved (which means handleExit has already fired and registered its
    // flushP synchronously). So no new persist promises can appear after the
    // await snapshot in normal flow.
    const sm = new SessionManager(makeConfigStub());
    const trackPersistence = (sm as unknown as {
      _trackPersistence: (p: Promise<void>) => void;
    });

    const a = deferred<void>();
    trackPersistence._trackPersistence(a.promise);
    a.resolve();
    await sm.awaitPendingPersistence();

    // Now register a NEW pending one and confirm a fresh await waits for it.
    const b = deferred<void>();
    trackPersistence._trackPersistence(b.promise);
    let bResolved = false;
    const second = sm.awaitPendingPersistence().then(() => {
      bResolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(bResolved, false);
    b.resolve();
    await second;
    assert.equal(bResolved, true);
  });
});

describe("SessionManager turn-scoped runner exits", () => {
  test("clean lifecycle exit during Codex app-server respawn does not finalize the turn", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const runner = new FakeTurnRunner((r, requestId) => {
      setImmediate(() => {
        r.emitExit({ code: 0, signal: null, crashed: false });
        setImmediate(() => {
          r.emitAssistantText("answer after route respawn");
          r.emitResult(requestId);
        });
      });
    });
    const session = makeTurnSession(runner);

    await runPrivateOneTurn(sm, session, events);

    assert.equal(
      events.some((e) => e.kind === "error"),
      false,
      "code=0/no-signal lifecycle exit must not produce a visible error",
    );
    assert.ok(
      events.some(
        (e) =>
          e.kind === "block" &&
          e.block.kind === "text" &&
          typeof e.block.text === "string" &&
          e.block.text.includes("answer after route respawn"),
      ),
      "assistant text after the respawn should still be parsed",
    );
    assert.ok(events.some((e) => e.kind === "final"), "final event should still arrive");
  });

  test("unexpected signal exit still surfaces the existing child-exit error", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const runner = new FakeTurnRunner((r) => {
      setImmediate(() => {
        r.emitExit({ code: null, signal: "SIGKILL", crashed: false });
      });
    });
    const session = makeTurnSession(runner);

    await runPrivateOneTurn(sm, session, events);

    assert.ok(
      events.some((e) => e.kind === "error" && e.error.includes("SIGKILL")),
      "signal exits must keep the old visible error path",
    );
  });
});
