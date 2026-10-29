import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { renderPrometheus, resetMetricsForTest } from "../admin/metrics.js";
import type { AdmitUserTurnInput, AdmitUserTurnResult } from "../db/pgSessionsBackend.js";
import {
  executeCronOriginInject,
  type CronOriginExecutor,
  type CronOriginExecutorClaimResult,
  type CronOriginInjectInput,
} from "../ws/originTurnInjection.js";

function admitted(input: AdmitUserTurnInput): Extract<AdmitUserTurnResult, { kind: "admitted" }> {
  const now = new Date();
  return {
    kind: "admitted",
    workspaceMode: "legacy",
    takeover: false,
    dispatch: {
      traceId: input.traceId ?? null,
      dispatchId: input.dispatchId,
      userId: input.uid,
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      agentId: input.agentId,
      model: input.model,
      requestHash: input.requestHash,
      billingRequestId: input.billingRequestId,
      attemptNo: 1,
      status: "admitted",
      outcome: null,
      failureCode: null,
      conflictReason: null,
      resolution: null,
      resolvedAt: null,
      clientNotified: false,
      ownerId: input.ownerId,
      leaseEpoch: 1,
      leaseUntil: new Date(now.getTime() + 90_000),
      anchorSeq: 5n,
      admittedAt: now,
      acceptedAt: null,
      terminalAt: null,
      lastAttemptAt: now,
    },
  };
}

function input(clientMessageId = "cron-origin-test"): CronOriginInjectInput {
  return { uid: 3n, sessionId: "origin-session", text: "continue", clientMessageId, agentId: "main" };
}

async function injectionSamples(): Promise<string[]> {
  const text = await renderPrometheus({ override: { agentContainersRunning: 0 } });
  return text.split("\n").filter((line) => line.startsWith("container_link_origin_injected_total{"));
}

describe("origin injection metrics", () => {
  beforeEach(() => resetMetricsForTest());

  for (const [clientMessageId, kind] of [
    ["cron-origin-test", "cron"],
    ["dlgcb-delegation-test", "dlgcb"],
    ["lsc-lease-test", "lsc"],
  ] as const) {
    test(`${kind}: accepted and terminal retries keep one successful claim`, async () => {
      let admissionCount = 0;
      let deliveries = 0;
      let original: ReturnType<typeof admitted> | undefined;
      const run = () => executeCronOriginInject({
        input: input(clientMessageId),
        admitUserTurn: async (request) => {
          admissionCount += 1;
          if (!original) {
            original = admitted(request);
            return original;
          }
          if (admissionCount === 2) {
            return {
              kind: "in_flight",
              workspaceMode: "legacy",
              dispatch: { ...original.dispatch, status: "accepted", acceptedAt: new Date() },
            };
          }
          return {
            kind: "deduplicated",
            workspaceMode: "legacy",
            dispatch: { ...original.dispatch, status: "terminal", outcome: "completed", terminalAt: new Date() },
          };
        },
        executor: () => {
          deliveries += 1;
          return { kind: "claimed" };
        },
      });
      assert.deepEqual(await run(), { kind: "injected" });
      assert.deepEqual(await run(), { kind: "injected" });
      assert.deepEqual(await run(), { kind: "injected" });
      assert.equal(deliveries, 1);
      assert.deepEqual(await injectionSamples(), [`container_link_origin_injected_total{kind="${kind}"} 1`]);
    });
  }

  test("a candidate that does not claim may fall through; only the successful claim counts", async () => {
    const calls: string[] = [];
    const result = await executeCronOriginInject({
      input: input(),
      admitUserTurn: async (request) => admitted(request),
      getExecutors: () => [
        () => { calls.push("unavailable"); return { kind: "not_claimed" }; },
        () => { calls.push("ready"); return { kind: "claimed" }; },
      ],
    });
    assert.deepEqual(result, { kind: "injected" });
    assert.deepEqual(calls, ["unavailable", "ready"]);
    assert.deepEqual(await injectionSamples(), ['container_link_origin_injected_total{kind="cron"} 1']);
  });

  for (const claim of ["rejected", "delivery_unknown", "throw"] as const) {
    test(`${claim} does not increment or try a second transport`, async () => {
      let secondCalls = 0;
      const first: CronOriginExecutor = () => {
        if (claim === "throw") throw new Error("transport lost");
        return { kind: claim } satisfies CronOriginExecutorClaimResult;
      };
      const result = await executeCronOriginInject({
        input: input(),
        admitUserTurn: async (request) => admitted(request),
        getExecutors: () => [first, () => { secondCalls += 1; return { kind: "claimed" }; }],
      });
      assert.deepEqual(result, {
        kind: "failed",
        reason: claim === "rejected" ? "dispatch_rejected" : "delivery_unknown",
      });
      assert.equal(secondCalls, 0);
      assert.deepEqual(await injectionSamples(), []);
    });
  }

  test("admission refusal and unavailable transport never count as injected", async () => {
    for (const result of [
      { kind: "session_busy" },
      { kind: "session_deleted" },
      { kind: "append_error", reason: "fixture" },
    ] as const) {
      await executeCronOriginInject({
        input: input(),
        admitUserTurn: async () => result,
        executor: () => { assert.fail("refused admission must not deliver"); },
      });
    }
    assert.deepEqual(await executeCronOriginInject({
      input: input(),
      admitUserTurn: async (request) => admitted(request),
      executor: () => ({ kind: "not_claimed" }),
    }), { kind: "no_transport" });
    assert.deepEqual(await injectionSamples(), []);
  });
});
