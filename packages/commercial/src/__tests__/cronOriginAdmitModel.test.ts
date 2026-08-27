/**
 * Origin-session cron must stamp the conversation model, not the process default.
 * Run: npx tsx --test packages/commercial/src/__tests__/cronOriginAdmitModel.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AdmitUserTurnInput, AdmitUserTurnResult } from "../db/pgSessionsBackend.js";
import {
  executeCronOriginInject,
  resolveCronOriginAdmitModel,
  type CronOriginExecutor,
} from "../ws/userChatBridge.js";

describe("resolveCronOriginAdmitModel", () => {
  test("keeps a grok-build origin session on grok-build", () => {
    assert.equal(resolveCronOriginAdmitModel("grok-build"), "grok-build");
  });

  test("trims whitespace", () => {
    assert.equal(resolveCronOriginAdmitModel("  glm-5.3-zai  "), "glm-5.3-zai");
  });

  test("falls back when the session has no model", () => {
    assert.equal(resolveCronOriginAdmitModel(null), null);
    assert.equal(resolveCronOriginAdmitModel(undefined), null);
    assert.equal(resolveCronOriginAdmitModel(""), null);
    assert.equal(resolveCronOriginAdmitModel("   "), null);
  });

  test("rejects values that cannot be a dispatch model", () => {
    assert.equal(resolveCronOriginAdmitModel("bad model"), null);
    assert.equal(resolveCronOriginAdmitModel("a".repeat(65)), null);
    assert.equal(resolveCronOriginAdmitModel("glm/5.3"), null);
  });
});

function fakeAdmitted(input: AdmitUserTurnInput): AdmitUserTurnResult {
  const now = new Date();
  return {
    kind: "admitted",
    workspaceMode: "legacy",
    takeover: false,
    dispatch: {
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

describe("injectCronOriginTurn stamps admit + inbound.model", () => {
  const uid = 3n;
  const input = {
    uid,
    sessionId: "webmtbs84bpm104yg",
    text: "⏰ 定时续跑\n核验",
    clientMessageId: "cron-origin-cron240ccc",
    agentId: "main",
  };

  function setup(opts: {
    lookupSessionModel?: (sessionId: string, sessionUserId: string) => Promise<string | null | undefined>;
  }) {
    const admits: AdmitUserTurnInput[] = [];
    const frames: Array<{ type?: string; model?: string }> = [];
    const executor: CronOriginExecutor = ({ encoded }) => {
      frames.push(JSON.parse(encoded.toString("utf8")) as { type?: string; model?: string });
    };
    const run = () => executeCronOriginInject({
      input,
      lookupSessionModel: opts.lookupSessionModel,
      admitUserTurn: async (admitInput) => {
        admits.push(admitInput);
        return fakeAdmitted(admitInput);
      },
      executor,
    });
    return { run, admits, frames };
  }

  test("grok-build session stamps admitUserTurn.model and inbound.message.model", async () => {
    const { run, admits, frames } = setup({
      lookupSessionModel: async (sessionId, sessionUserId) => {
        assert.equal(sessionId, input.sessionId);
        assert.equal(sessionUserId, "c:3");
        return "grok-build";
      },
    });
    const result = await run();
    assert.equal(result.kind, "injected");
    assert.equal(admits.length, 1);
    assert.equal(admits[0]!.model, "grok-build");
    assert.equal((admits[0]!.message as { _routing?: { model?: string } })._routing?.model, "grok-build");
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.type, "inbound.message");
    assert.equal(frames[0]!.model, "grok-build");
  });

  test("lookup failure falls back to model:null and still injects", async () => {
    const { run, admits, frames } = setup({
      lookupSessionModel: async () => {
        throw new Error("backend down");
      },
    });
    const result = await run();
    assert.equal(result.kind, "injected");
    assert.equal(admits.length, 1);
    assert.equal(admits[0]!.model, null);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.type, "inbound.message");
    assert.equal(frames[0]!.model, undefined);
  });
});
