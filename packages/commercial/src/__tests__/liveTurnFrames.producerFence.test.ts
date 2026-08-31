/**
 * OCV5-57 audit r1 B3: in-process producer fence + persist drop (no Postgres).
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/liveTurnFrames.producerFence.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { Pool } from "pg";
import {
  isProducerFenced,
  persistGatewayLiveFrame,
  PRODUCER_FENCE_CAP,
  producerFenceDropCountForTests,
  producerFenceSizeForTests,
  registerProducerFence,
  resetProducerFenceForTests,
  shouldForwardLiveFrameToBrowser,
} from "../db/liveTurnFrames.js";

afterEach(() => {
  resetProducerFenceForTests();
});

describe("producer fence registry", () => {
  test("register then drop persist and forward for same clientMessageId", async () => {
    registerProducerFence({
      dispatchId: "11111111-1111-4111-8111-111111111111",
      sessionId: "sess-a",
      clientMessageId: "cm-1",
    });
    assert.equal(isProducerFenced({
      dispatchId: "11111111-1111-4111-8111-111111111111",
    }), true);
    assert.equal(isProducerFenced({
      sessionId: "sess-a",
      clientMessageId: "cm-1",
    }), true);
    assert.equal(shouldForwardLiveFrameToBrowser({
      sessionId: "sess-a",
      clientMessageId: "cm-1",
    }), false);

    let connects = 0;
    const pool = {
      async connect() {
        connects += 1;
        throw new Error("should not open a tx for a memory-fenced frame");
      },
    } as unknown as Pool;
    await persistGatewayLiveFrame(pool, {
      uid: 3n,
      sessionId: "sess-a",
      clientMessageId: "cm-1",
      agentContainerId: 141,
      sessionKey: "agent:main:webchat:dm:sess-a",
      frameSeq: 9,
      payload: '{"type":"outbound.message","frameSeq":9}',
    });
    assert.equal(connects, 0);
    assert.ok(producerFenceDropCountForTests() >= 1);
  });

  test("TTL expiry unfences", () => {
    const nowMs = 1_000_000;
    registerProducerFence({
      dispatchId: "11111111-1111-4111-8111-111111111111",
      sessionId: "sess-a",
      clientMessageId: "cm-1",
      nowMs,
    });
    assert.equal(isProducerFenced({
      sessionId: "sess-a",
      clientMessageId: "cm-1",
      nowMs: nowMs + 6 * 60 * 60_000 - 1,
    }), true);
    assert.equal(isProducerFenced({
      sessionId: "sess-a",
      clientMessageId: "cm-1",
      nowMs: nowMs + 6 * 60 * 60_000 + 1,
    }), false);
  });

  test("cap evicts oldest keys", () => {
    for (let i = 0; i < PRODUCER_FENCE_CAP + 10; i += 1) {
      registerProducerFence({
        dispatchId: `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
        sessionId: "sess-a",
        clientMessageId: `cm-${i}`,
      });
    }
    assert.ok(producerFenceSizeForTests() <= PRODUCER_FENCE_CAP);
    assert.equal(isProducerFenced({
      sessionId: "sess-a",
      clientMessageId: "cm-0",
    }), false);
  });

  test("PG terminal+fenced dispatch is not inserted", async () => {
    const sqls: string[] = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string) {
            const s = sql.replace(/\s+/g, " ").trim();
            sqls.push(s);
            if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") {
              return { rows: [], rowCount: 0 };
            }
            if (s.includes("FROM turn_dispatches") && s.includes("FOR UPDATE")) {
              return {
                rows: [{
                  dispatch_id: "11111111-1111-4111-8111-111111111111",
                  attempt_no: 1,
                  status: "terminal",
                  producer_fenced_at: new Date(),
                }],
                rowCount: 1,
              };
            }
            throw new Error(`unexpected sql ${s}`);
          },
          release() {},
        };
      },
    } as unknown as Pool;
    await persistGatewayLiveFrame(pool, {
      uid: 3n,
      sessionId: "sess-a",
      clientMessageId: "cm-late",
      agentContainerId: 141,
      sessionKey: "agent:main:webchat:dm:sess-a",
      frameSeq: 12,
      payload: '{"type":"outbound.message","frameSeq":12}',
    });
    assert.ok(sqls.some((s) => s.includes("producer_fenced_at")));
    assert.equal(sqls.some((s) => s.includes("INSERT INTO client_session_live_frames")), false);
    assert.equal(shouldForwardLiveFrameToBrowser({
      sessionId: "sess-a",
      clientMessageId: "cm-late",
    }), false);
  });
});
