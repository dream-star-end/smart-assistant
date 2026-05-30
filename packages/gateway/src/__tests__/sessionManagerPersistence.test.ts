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

import { SessionManager, type AgentSession } from "../sessionManager.js";
import { buildCodexProviderConfigArgs, type CodexProviderConfigOverride } from "../codexRunner.js";
import { _buildSafeCodexRouteOverride } from "../server.js";
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

describe("SessionManager Codex route turn scoping", () => {
  test("codexRoute is applied under the per-session submit lock", async () => {
    const sm = new SessionManager(makeConfigStub());
    let currentRoute: string | null = null;
    const appliedRoutes: Array<string | null> = [];
    const seenByTurns: Array<string | null> = [];
    const runner = {
      model: "gpt-5.5" as string | undefined,
      effortLevel: undefined as string | undefined,
      lastActivityAt: Date.now(),
      setConversationMode(_mode: "default" | "plan") {},
      setCodexRoute(route: { modelProvider?: string } | null) {
        currentRoute = route?.modelProvider ?? null;
        appliedRoutes.push(currentRoute);
      },
      setModel(model: string | undefined) { this.model = model; },
      setEffortLevel(level: string | undefined) { this.effortLevel = level; },
      setTraceId(_traceId: string) {},
      async shutdown() {},
      interrupt() {},
    };
    const session = {
      sessionKey: "agent:codex:webchat:peer",
      agentId: "codex",
      channel: "webchat",
      peerId: "peer",
      title: "Codex",
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
      turns: 1,
      _lastCcbCumulativeCost: 0,
      toolUseIdToName: new Map(),
      executionTarget: { kind: "local" },
      providerTag: "codex-native",
      agentProvider: "codex-native",
    } as unknown as AgentSession;

    (sm as unknown as {
      runOneTurnWithRetry: (...args: unknown[]) => Promise<void>;
    }).runOneTurnWithRetry = async () => {
      seenByTurns.push(currentRoute);
      if (seenByTurns.length === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    };

    const p1 = sm.submit(
      session,
      "one",
      () => {},
      undefined,
      "gpt-5.5",
      undefined,
      undefined,
      undefined,
      { codexRoute: { modelProvider: "route_a", baseUrl: "http://127.0.0.1/a" } },
    );
    const p2 = sm.submit(
      session,
      "two",
      () => {},
      undefined,
      "gpt-5.5",
      undefined,
      undefined,
      undefined,
      { codexRoute: { modelProvider: "route_b", baseUrl: "http://127.0.0.1/b" } },
    );

    await Promise.all([p1, p2]);

    assert.deepEqual(seenByTurns, ["route_a", "route_b"]);
    assert.deepEqual(appliedRoutes, ["route_a", "route_b"]);
  });

  test("official OAuth marker applies an empty route override that suppresses env relay defaults", async () => {
    const route = _buildSafeCodexRouteOverride({
      agentProvider: "codex-native",
      model: "gpt-5.5",
      rawRoute: { kind: "official_oauth" },
    });
    assert.deepEqual(route, {});
    assert.equal(
      _buildSafeCodexRouteOverride({
        agentProvider: "codex-native",
        model: "gpt-5.5",
        rawRoute: {
          kind: "official_oauth",
          baseUrl: "http://127.0.0.1:18789/internal/v3/codex-relay/route/not-a-marker",
        },
      }),
      null,
      "official_oauth marker must be exact-shape, not a malformed relay route",
    );
    assert.equal(
      _buildSafeCodexRouteOverride({
        agentProvider: "claude-code",
        model: "gpt-5.5",
        rawRoute: { kind: "official_oauth" },
      }),
      null,
      "marker is ignored outside codex-native agents",
    );

    const sm = new SessionManager(makeConfigStub());
    let appliedRoute: CodexProviderConfigOverride | null | "unset" = "unset";
    const seenByTurn: Array<CodexProviderConfigOverride | null | "unset"> = [];
    const runner = {
      model: "gpt-5.5" as string | undefined,
      effortLevel: undefined as string | undefined,
      lastActivityAt: Date.now(),
      setConversationMode(_mode: "default" | "plan") {},
      setCodexRoute(nextRoute: CodexProviderConfigOverride | null) {
        appliedRoute = nextRoute;
      },
      setModel(model: string | undefined) { this.model = model; },
      setEffortLevel(level: string | undefined) { this.effortLevel = level; },
      setTraceId(_traceId: string) {},
      async shutdown() {},
      interrupt() {},
    };
    const session = {
      sessionKey: "agent:codex:webchat:peer-official",
      agentId: "codex",
      channel: "webchat",
      peerId: "peer-official",
      title: "Codex",
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
      turns: 1,
      _lastCcbCumulativeCost: 0,
      toolUseIdToName: new Map(),
      executionTarget: { kind: "local" },
      providerTag: "codex-native",
      agentProvider: "codex-native",
    } as unknown as AgentSession;

    (sm as unknown as {
      runOneTurnWithRetry: (...args: unknown[]) => Promise<void>;
    }).runOneTurnWithRetry = async () => {
      seenByTurn.push(appliedRoute);
    };

    await sm.submit(
      session,
      "official oauth",
      () => {},
      undefined,
      "gpt-5.5",
      undefined,
      undefined,
      undefined,
      { codexRoute: route },
    );

    assert.deepEqual(seenByTurn, [{}]);
    assert.deepEqual(
      buildCodexProviderConfigArgs(
        {
          OC_CODEX_MODEL_PROVIDER: "api111",
          OC_CODEX_BASE_URL: "https://yunwu.ai/v1",
          OC_CODEX_PROVIDER_NAME: "Yunwu",
          OC_CODEX_WIRE_API: "responses",
          OC_CODEX_PREFERRED_AUTH_METHOD: "apikey",
          OC_CODEX_DISABLE_RESPONSE_STORAGE: "1",
        },
        seenByTurn[0] as CodexProviderConfigOverride,
      ),
      [],
      "empty override must suppress OC_CODEX_* relay argv",
    );
  });
});
