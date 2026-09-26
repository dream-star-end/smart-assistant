import test from "node:test";
import assert from "node:assert/strict";
import { BoxToolFetch } from "./boxToolFetch.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { ProxyBody } from "./shared.js";
import type { BoxNativePointer } from "./boxNativePointer.js";

const tools = [{ name: "local_echo", description: "synthetic",
  input_schema: { type: "object", properties: {} } }];
const firstBody: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, tools, messages: [{ role: "user", content: "first" }] };
const nextBody: ProxyBody = { ...firstBody, messages: [
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_A",
    name: "local_echo", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A",
    content: "local result" }] },
  { role: "system", content: [{ type: "text",
    text: "<total_tokens>14999987 tokens left</total_tokens>",
    cache_control: { type: "ephemeral" } }] },
] };
const call = (canonicalBody: ProxyBody) => ({ uid: 3n, sessionId: "session",
  requestId: canonicalBody === firstBody ? "box-first" : "box-next",
  canonicalModel: canonicalBody.model, canonicalBody,
  upstreamModel: "claude-opus-5-5", url: BOX_INTERNAL_ENDPOINT,
  init: { method: "POST", body: JSON.stringify({ ...canonicalBody,
    model: "claude-opus-5-5" }) } });
const journal = () => ({ claimRemoteCleanup: async () => true,
  remoteCleanupStatus: async () => "pending",
  remoteCleanupDoneByRunIdentity: async () => false,
  prelaunchCleanupDoneByRunIdentity: async () => false,
  markRemoteCleaned: async () => {},
  listRemoteCleanupCandidates: async () => [] }) as never;

test("same internal model fetch streams first handoff then next final without tool execution", async () => {
  const calls: string[] = [];
  let disposed = false;
  const target = { accountId: 20n,
    exec: { run: async () => ({ stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const }) },
    dispose: async () => { disposed = true; } };
  const claim = { runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), accountId: 20n,
    spoolOffset: 1234, roundNo: 2 };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), journal: journal(),
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      calls.push("first"); input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "tool_handoff", plan: { runNonce: claim.runNonce,
        leaseEpoch: claim.leaseEpoch }, target };
    }) as never,
    publishResume: (async () => { calls.push("claim-and-publish");
      return { claim, target, access: {} }; }) as never,
    runContinuation: (async (input: { emit: (sse: string) => void }) => {
      calls.push("continued-final");
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", proof: { runNonce: claim.runNonce,
        leaseEpoch: claim.leaseEpoch, keeperPid: 101, cliPid: 102,
        reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const first = await service.fetch(call(firstBody));
  assert.match(await first.text(), /event: message_stop/);
  assert.equal(disposed, false, "remote CLI remains owned across HTTP boundary");
  const second = await service.fetch(call(nextBody));
  assert.match(await second.text(), /event: message_stop/);
  assert.deepEqual(calls, ["first", "claim-and-publish", "continued-final"]);
  assert.equal(disposed, true, "local target closes only after terminal proof");
  assert.equal(await service.retryFailedCleanup(), 0);
});

test("proven native final carries its exact pointer into preserving cleanup", async () => {
  const pointer: BoxNativePointer = { version: 1, accountId: "20",
    upstreamModel: "claude-opus-5-5", cliVersion: "2.1.280",
    nativeSessionId: "12345678-1234-4123-8123-123456789abc",
    cliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
    transcriptSha256: "f".repeat(64), contextHashBeforeFinal: "c".repeat(64),
    assistantContentHash: "d".repeat(64), catalogHash: "e".repeat(64),
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1000 };
  let claimed = false, cleaned = false;
  const target = { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
    assert.deepEqual(request.args.slice(-2), ["a".repeat(24), "1"]);
    return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const };
  } }, dispose: async () => {} };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { claimRemoteCleanup: async (candidate: {
      nativePointer?: BoxNativePointer }) => {
      assert.deepEqual(candidate.nativePointer, pointer); claimed = true; return true;
    }, markRemoteCleaned: async () => { cleaned = true; },
    remoteCleanupStatus: async () => "pending",
    remoteCleanupDoneByRunIdentity: async () => false,
    prelaunchCleanupDoneByRunIdentity: async () => false,
    listRemoteCleanupCandidates: async () => [] } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never, onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "a".repeat(24),
        leaseEpoch: "b".repeat(32) }, target,
        proof: { runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
          keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 },
        nativePointer: pointer };
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  assert.ok((await response.text()).includes("event: message_stop"));
  assert.equal(claimed, true);
  assert.equal(cleaned, true);
});

test("only model first/resume paths request wake; recovery resolver remains default no-wake", async () => {
  const seen: Array<boolean | undefined> = [];
  const target = { accountId: 20n, exec: { run: async () => {
    throw new Error("paid Exec forbidden in purpose test");
  } }, dispose: async () => {} };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), journal: journal(),
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async (args) => { seen.push(args.allowWakeIfHibernated);
      return target as never; }, onUnknown: async () => {},
    runFirst: (async (_input: unknown, deps: { resolveTarget: (args: {
      uid: bigint; sessionId: string | null; requestId: string;
      upstreamModel: string; signal: AbortSignal }) => Promise<typeof target> }) => {
      const held = await deps.resolveTarget({ uid: 3n, sessionId: "session",
        requestId: "first", upstreamModel: "claude-opus-5-5",
        signal: new AbortController().signal });
      await held.dispose();
      throw new Error("synthetic first stopped before paid work");
    }) as never,
    publishResume: (async (_input: unknown, deps: { resolveTarget: (args: {
      uid: bigint; sessionId: string | null; requestId: string;
      upstreamModel: string; signal: AbortSignal }) => Promise<typeof target> }) => {
      const held = await deps.resolveTarget({ uid: 3n, sessionId: "session",
        requestId: "resume", upstreamModel: "claude-opus-5-5",
        signal: new AbortController().signal });
      await held.dispose();
      throw new Error("synthetic resume stopped before paid work");
    }) as never,
  });
  await assert.rejects(() => service.fetch(call(firstBody)).then((r) => r.text()),
    /synthetic first stopped/);
  await assert.rejects(() => service.fetch(call(nextBody)).then((r) => r.text()),
    /synthetic resume stopped/);
  assert.deepEqual(seen, [true, true]);
});

test("failed local close retry is bounded and never starts concurrent dispose", async () => {
  let attempts = 0;
  const target = { accountId: 20n,
    exec: { run: async () => ({ stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const }) },
    dispose: () => {
    attempts++;
    if (attempts === 1) throw new Error("first close failed");
    return new Promise<void>(() => {});
  } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), journal: journal(),
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "a".repeat(24),
        leaseEpoch: "b".repeat(32) }, target,
        proof: { runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
          keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 1);
  const started = Date.now();
  assert.equal(await service.retryFailedCleanup(), 1);
  assert.ok(Date.now() - started < 800);
  assert.equal(attempts, 2);
  assert.equal(await service.retryFailedCleanup(), 1);
  assert.equal(attempts, 2, "unsettled close attempt is not duplicated");
});

test("fresh egress recovers only a no-launch prelaunch row without paid replay", async () => {
  const receipt = { version: 2 as const, runNonce: "a".repeat(24),
    leaseEpoch: "b".repeat(32), accountId: "20", controlId: "c".repeat(32),
    controlDev: "2049", controlIno: "9001", lockDev: "2049", lockIno: "9002",
    identityHash: "d".repeat(64) };
  const candidate = { requestId: "box-prelaunch", uid: 3n, accountId: 20n,
    runNonce: receipt.runNonce, leaseEpoch: receipt.leaseEpoch, receipt };
  let claimed = 0, settled = 0, cleaned = 0, disposed = false;
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { listPrelaunchRecoveryCandidates: async () => settled ? [] : [candidate],
      claimPrelaunchRecovery: async () => { claimed++; return true; },
      markGuardedPrestartStopped: async (value: { cleanedReceipt: string }) => {
        assert.equal(value.cleanedReceipt, `cleaned:${receipt.identityHash}`);
        settled++;
      } } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async (args) => {
      assert.equal(args.requiredAccountId, 20n);
      assert.equal(args.allowWakeIfHibernated, undefined,
        "restart cleanup must not wake a hibernated Box");
      return { accountId: 20n, exec: { run: async (request: { args: string[] }) => {
        assert.ok(request.args[2]?.includes("def clean_dir(parent_path,name,allowed):"));
        assert.ok(!request.args.some((arg) => arg.includes("/home/box/.local/bin/claude")));
        cleaned++;
        return { stdout: `cleaned:${receipt.identityHash}\n`, stderrBytes: 0,
          exitCode: 0 as const };
      } }, dispose: async () => { disposed = true; } } as never;
    }, onUnknown: async () => {},
  });
  assert.equal(await service.reconcilePrelaunchRecovery(), 1);
  assert.equal(claimed, 1);
  assert.equal(cleaned, 1);
  assert.equal(settled, 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(disposed, true);
  assert.equal(await service.reconcilePrelaunchRecovery(), 0);
});

test("original egress reaps held target after peer's exact prelaunch cleanup proof", async () => {
  const nonce = "e".repeat(24), epoch = "f".repeat(32);
  let disposed = false, done = false;
  const target = { accountId: 20n, exec: { run: async () => {
    throw new Error("paid or cleanup Exec must not be dispatched by the reaper");
  } }, dispose: async () => { disposed = true; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { listRemoteCleanupCandidates: async () => [],
      remoteCleanupDoneByRunIdentity: async () => false,
      prelaunchCleanupDoneByRunIdentity: async (identity: { runNonce: string;
        leaseEpoch: string; accountId: bigint }) => {
        assert.equal(identity.runNonce, nonce);
        assert.equal(identity.leaseEpoch, epoch);
        assert.equal(identity.accountId, 20n);
        return done;
      } } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never, onUnknown: async () => {},
    runFirst: (async (_input: unknown, deps: { retainUnknownTarget: (handle: {
      target: typeof target; plan: { runNonce: string; leaseEpoch: string } }) => void }) => {
      deps.retainUnknownTarget({ target, plan: { runNonce: nonce, leaseEpoch: epoch } });
      throw new Error("synthetic prelaunch unknown");
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  await assert.rejects(() => response.text(), /synthetic prelaunch unknown/);
  assert.equal(disposed, false);
  done = true;
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  assert.equal(disposed, true);
});

test("terminal cleanup failure retains the pinned Box target for idempotent retry", async () => {
  let attempts = 0, disposed = false;
  const target = { accountId: 20n, exec: { run: async () => {
    attempts++;
    if (attempts === 1) throw new Error("synthetic cleanup transport failure");
    return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const };
  } }, dispose: async () => { disposed = true; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), journal: journal(),
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "b".repeat(24),
        leaseEpoch: "c".repeat(32) }, target,
        proof: { runNonce: "b".repeat(24), leaseEpoch: "c".repeat(32),
          keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  assert.match(await response.text(), /message_stop/);
  assert.equal(disposed, false);
  assert.equal(await service.retryTerminalCleanup(), 0);
  assert.equal(attempts, 2);
  assert.equal(disposed, true);
});

test("fresh egress instance recovers proven remote cleanup from durable journal", async () => {
  const candidate = { requestId: "box-proven", uid: 3n, accountId: 20n,
    runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
    proof: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
      keeperPid: 101, cliPid: 102, reason: "worker_complete" as const,
      revision: 1 as const } };
  let marked = false, disposed = false, cleans = 0;
  const target = { accountId: 20n, exec: { run: async () => {
    cleans++;
    return { stdout: "clean\n", stderrBytes: 0, exitCode: 0 as const };
  } }, dispose: async () => { disposed = true; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { listRemoteCleanupCandidates: async () => marked ? [] : [candidate],
      claimRemoteCleanup: async () => true,
      remoteCleanupStatus: async () => marked ? "done" : "pending",
      markRemoteCleaned: async (value: typeof candidate) => {
        assert.deepEqual(value, candidate); marked = true;
      } } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async (args) => {
      assert.equal(args.requiredAccountId, 20n);
      return target as never;
    },
    onUnknown: async () => {},
  });
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  assert.equal(cleans, 1);
  assert.equal(marked, true);
  assert.equal(disposed, true);
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  assert.equal(cleans, 1, "already-cleaned remote run is not touched again");
});

test("stalled restart cleanup resolver is bounded and frees local single-flight", async () => {
  const candidate = { requestId: "box-stalled", uid: 3n, accountId: 20n,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
    proof: { runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
      keeperPid: 101, cliPid: 102, reason: "worker_complete" as const,
      revision: 1 as const } };
  let resolves = 0, aborts = 0;
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), cleanupResolveTimeoutMs: 20,
    journal: { listRemoteCleanupCandidates: async () => [candidate],
      claimRemoteCleanup: async () => true } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async ({ signal }) => {
      resolves++;
      signal.addEventListener("abort", () => { aborts++; }, { once: true });
      return new Promise<never>(() => {});
    }, onUnknown: async () => {} });
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  assert.equal(aborts, 1);
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  assert.equal(resolves, 2, "the timeout must release this run's local in-flight marker");
});

test("late cleanup resolver target closes locally and failed dispose is retried", async () => {
  const candidate = { requestId: "box-late", uid: 3n, accountId: 20n,
    runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
    proof: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
      keeperPid: 101, cliPid: 102, reason: "worker_complete" as const,
      revision: 1 as const } };
  let finish!: (target: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { finish = resolve; });
  let remoteCalls = 0, disposals = 0;
  const target = { accountId: 20n,
    exec: { run: async () => { remoteCalls++; throw new Error("no remote cleanup after timeout"); } },
    dispose: async () => { disposals++; if (disposals === 1) throw new Error("transient"); } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"), cleanupResolveTimeoutMs: 20,
    journal: { listRemoteCleanupCandidates: async () => [candidate],
      claimRemoteCleanup: async () => true } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => pending as never,
    onUnknown: async () => {} });
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  finish(target);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(disposals, 1);
  assert.equal(remoteCalls, 0);
  assert.equal(await service.retryFailedCleanup(), 0);
  assert.equal(disposals, 2);
});

test("mismatched pinned cleanup account closes its unused local target", async () => {
  const candidate = { requestId: "box-wrong-account", uid: 3n, accountId: 20n,
    runNonce: "e".repeat(24), leaseEpoch: "f".repeat(32),
    proof: { runNonce: "e".repeat(24), leaseEpoch: "f".repeat(32),
      keeperPid: 101, cliPid: 102, reason: "worker_complete" as const,
      revision: 1 as const } };
  let closed = 0, remoteCalls = 0;
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { listRemoteCleanupCandidates: async () => [candidate],
      claimRemoteCleanup: async () => true } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => ({ accountId: 21n,
      exec: { run: async () => { remoteCalls++; throw new Error("no cross-account Exec"); } },
      dispose: async () => { closed++; } }) as never,
    onUnknown: async () => {} });
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, 1);
  assert.equal(remoteCalls, 0);
});

test("worker that lost cleanup claim releases local target once peer marked exact proof done", async () => {
  let disposed = false, remoteCalls = 0;
  const target = { accountId: 20n,
    exec: { run: async () => { remoteCalls++; throw new Error("must not clean twice"); } },
    dispose: async () => { disposed = true; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { claimRemoteCleanup: async () => false,
      remoteCleanupStatus: async () => "done" } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "e".repeat(24),
        leaseEpoch: "f".repeat(32) }, target,
        proof: { runNonce: "e".repeat(24), leaseEpoch: "f".repeat(32),
          keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  assert.match(await response.text(), /message_stop/);
  assert.equal(remoteCalls, 0);
  assert.equal(disposed, true);
});

test("shared worker done after handoff reaps original egress target without another remote Exec", async () => {
  let done = false, disposed = 0, remoteCalls = 0;
  const nonce = "7".repeat(24), epoch = "8".repeat(32);
  const target = { accountId: 20n,
    exec: { run: async () => { remoteCalls++; throw new Error("no remote replay"); } },
    dispose: async () => { disposed++; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { remoteCleanupDoneByRunIdentity: async (identity: {
      uid: bigint; accountId: bigint; runNonce: string; leaseEpoch: string }) => {
      assert.deepEqual(identity, { uid: 3n, accountId: 20n,
        runNonce: nonce, leaseEpoch: epoch });
      return done;
    }, prelaunchCleanupDoneByRunIdentity: async () => false,
    listRemoteCleanupCandidates: async () => [] } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "tool_handoff", plan: { runNonce: nonce,
        leaseEpoch: epoch }, target };
    }) as never,
  });
  assert.match(await (await service.fetch(call(firstBody))).text(), /message_stop/);
  assert.equal(await service.retryTerminalCleanup(), 0);
  assert.equal(disposed, 0);
  done = true;
  assert.equal(await service.reconcileRemoteCleanup(), 0);
  assert.equal(disposed, 1);
  assert.equal(remoteCalls, 0);
});

test("cleanup status query failure never poisons an already-final SSE response", async () => {
  let disposed = false, statusFails = true;
  const target = { accountId: 20n,
    exec: { run: async () => { throw new Error("must not touch remote"); } },
    dispose: async () => { disposed = true; } };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),
    keeperAsset: Buffer.from("k"), virtualMcpAsset: Buffer.from("m"),
    detachedRunnerAsset: Buffer.from("d"),
    journal: { claimRemoteCleanup: async () => false,
      remoteCleanupStatus: async () => {
        if (statusFails) throw new Error("synthetic PG failure");
        return "done";
      } } as never,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => {},
    runFirst: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "e".repeat(24),
        leaseEpoch: "f".repeat(32) }, target,
        proof: { runNonce: "e".repeat(24), leaseEpoch: "f".repeat(32),
          keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const response = await service.fetch(call(firstBody));
  assert.match(await response.text(), /message_stop/);
  assert.equal(disposed, false);
  statusFails = false;
  assert.equal(await service.retryTerminalCleanup(), 0);
  assert.equal(disposed, true);
});
