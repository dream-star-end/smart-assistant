/**
 * delegate 子会话计费归因 — 提取/剥离纯函数 + settle 落库参数测试。
 *
 * 跑法: npx tsx --test packages/commercial/src/__tests__/usageAttribution.test.ts
 *
 * 覆盖:
 *   - extractUsageAttribution:oc_* 键提取(gateway CLAUDE_CODE_EXTRA_METADATA
 *     → CCB metadata.user_id JSON 链路的 master 侧终点)
 *   - 非 delegate / 伪造零散键 → 'chat' + null/null(普通聊天零影响硬约束)
 *   - extractSessionId 与 extractUsageAttribution.sessionId 同源同值
 *   - stripUsageAttributionKeys:oc_ 键剥离,普通串零改写(fail-open 口径)
 *   - settleUsageAndLedger:INSERT 参数落 mode/parent_session_id/delegate_agent_id;
 *     缺省路径与 0104 之前行为一致(mode='chat',两列 NULL)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  extractSessionId,
  extractUsageAttribution,
  stripUsageAttributionKeys,
} from "../http/anthropicProxy.js";
import { settleUsageAndLedger } from "../billing/proxyBilling.js";

/** CCB getAPIMetadata 形状:extra(env)spread 在前,原生三键殿后。 */
function ccbUserId(extra: Record<string, string> = {}): string {
  return JSON.stringify({
    ...extra,
    device_id: "d".repeat(64),
    account_uuid: "11111111-2222-3333-4444-555555555555",
    session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
}

describe("extractUsageAttribution — delegate 打标提取", () => {
  test("完整 delegate 定位键 → session/parent/agent/turn 全提取", () => {
    const got = extractUsageAttribution({
      user_id: ccbUserId({
        oc_mode: "delegate",
        oc_parent_session_id: "web-mo7ho2z4-0fojstsu",
        oc_delegate_agent_id: "hidden-reviewer",
        oc_turn_key: "a".repeat(64),
        oc_parent_turn_key: "b".repeat(64),
      }),
    });
    assert.deepEqual(got, {
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      mode: "delegate",
      parentSessionId: "web-mo7ho2z4-0fojstsu",
      delegateAgentId: "hidden-reviewer",
      turnKey: "a".repeat(64),
      parentTurnKey: "b".repeat(64),
    });
  });

  test("delegate 但无 parent(父会话不可得)→ parentSessionId null,其余照常", () => {
    const got = extractUsageAttribution({
      user_id: ccbUserId({
        oc_mode: "delegate",
        oc_delegate_agent_id: "coding-assistant",
      }),
    });
    assert.equal(got.mode, "delegate");
    assert.equal(got.parentSessionId, null);
    assert.equal(got.delegateAgentId, "coding-assistant");
  });

  test("无 oc_ 键(普通 CCB chat)→ 'chat' + null/null,sessionId 语义不变", () => {
    const got = extractUsageAttribution({ user_id: ccbUserId() });
    assert.deepEqual(got, {
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      mode: "chat",
      parentSessionId: null,
      delegateAgentId: null,
      turnKey: null,
      parentTurnKey: null,
    });
  });

  test("oc_mode 非 'delegate'(伪造未知值)→ 一律 'chat',归因键忽略", () => {
    const got = extractUsageAttribution({
      user_id: ccbUserId({
        oc_mode: "team",
        oc_parent_session_id: "web-x",
        oc_delegate_agent_id: "y",
      }),
    });
    assert.deepEqual(
      { mode: got.mode, parent: got.parentSessionId, agent: got.delegateAgentId },
      { mode: "chat", parent: null, agent: null },
    );
  });

  test("零散伪造(只有 oc_parent_session_id、无 oc_mode)→ 'chat' 行不挂 delegate 归因", () => {
    const got = extractUsageAttribution({
      user_id: ccbUserId({ oc_parent_session_id: "web-forged" }),
    });
    assert.equal(got.mode, "chat");
    assert.equal(got.parentSessionId, null);
  });

  test("user_id 非 JSON / undefined metadata → 'chat' + 全 null(不 throw)", () => {
    assert.deepEqual(extractUsageAttribution({ user_id: "plain-string" }), {
      sessionId: null,
      mode: "chat",
      parentSessionId: null,
      delegateAgentId: null,
      turnKey: null,
      parentTurnKey: null,
    });
    assert.equal(extractUsageAttribution(undefined).mode, "chat");
  });

  test("归因值 trim + 截断 256(与 sessionId 同一防御口径)", () => {
    const got = extractUsageAttribution({
      user_id: ccbUserId({
        oc_mode: "delegate",
        oc_parent_session_id: `  ${"p".repeat(300)}  `,
        oc_delegate_agent_id: "   ",
      }),
    });
    assert.equal(got.parentSessionId, "p".repeat(256));
    // 空白 agent id → null(不落空串)
    assert.equal(got.delegateAgentId, null);
  });

  test("extractSessionId 与 extractUsageAttribution.sessionId 同源同值(顶层优先 + JSON fallback)", () => {
    const cases = [
      { session_id: "explicit-top", user_id: ccbUserId() },
      { user_id: ccbUserId() },
      { user_id: "not-json" },
      undefined,
    ];
    for (const md of cases) {
      assert.equal(
        extractSessionId(md),
        extractUsageAttribution(md).sessionId,
        `mismatch for ${JSON.stringify(md)}`,
      );
    }
  });
});

describe("stripUsageAttributionKeys — 上游转发前剥内部键", () => {
  test("带 oc_ 键 → 剥除,CCB 原生键保留", () => {
    const stripped = stripUsageAttributionKeys(
      ccbUserId({
        oc_mode: "delegate",
        oc_parent_session_id: "web-p",
        oc_delegate_agent_id: "a",
      }),
    );
    const parsed = JSON.parse(stripped!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), [
      "account_uuid",
      "device_id",
      "session_id",
    ]);
    assert.equal(parsed.device_id, "d".repeat(64));
  });

  test("无 oc_ 键(普通 chat)→ 原串**同一引用**返回(零改写,字节不变)", () => {
    const original = ccbUserId();
    assert.equal(stripUsageAttributionKeys(original), original);
  });

  test("非 JSON / 非 object / undefined → 原值原样(fail-open,与 rewriteMetadataDeviceId 口径对齐)", () => {
    assert.equal(stripUsageAttributionKeys("plain"), "plain");
    assert.equal(stripUsageAttributionKeys('["oc_mode"]'), '["oc_mode"]');
    assert.equal(stripUsageAttributionKeys(undefined), undefined);
  });
});

// ─── settleUsageAndLedger 落库参数(stub pool,沿用 anthropicProxy.test.ts 先例)──

function makeSettleStubs() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const stubClient = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO usage_records")) {
        inserts.push({ sql, params: params ?? [] });
        return { rows: [{ id: "9001" }], rowCount: 1 } as never;
      }
      if (sql.includes("FROM users WHERE id")) {
        return { rows: [{ credits: "1000000" }], rowCount: 1 } as never;
      }
      if (sql.includes("FROM user_subscriptions")) {
        return { rows: [], rowCount: 0 } as never;
      }
      if (sql.includes("INSERT INTO credit_ledger")) {
        return { rows: [{ id: "7001", balance_after: "999000" }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
    release: () => {},
  };
  const stubPool = { connect: async () => stubClient } as unknown as Pool;
  return { inserts, stubPool };
}

const settleBase = {
  userId: 1n,
  accountId: null,
  model: "glm-5.2",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  },
  snapshotJson: "{}",
  costCredits: 0n, // cost=0 → 不走 ledger 分支,聚焦 INSERT 参数断言
  status: "success" as const,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

describe("settleUsageAndLedger — delegate 归因落库", () => {
  test("mode='delegate' + parent + agent → INSERT 参数按列落位", async () => {
    const { inserts, stubPool } = makeSettleStubs();
    await settleUsageAndLedger(stubPool, {
      ...settleBase,
      requestId: "req-delegate-1",
      mode: "delegate",
      parentSessionId: "web-mo7ho2z4-0fojstsu",
      delegateAgentId: "hidden-reviewer",
    });
    assert.equal(inserts.length, 1);
    const { sql, params } = inserts[0]!;
    // 列序与参数位一致性:mode=$2,session_id=$11,parent_session_id=$12,
    // delegate_agent_id=$13(列清单变更时本断言强制同步)。
    assert.match(sql, /parent_session_id/);
    assert.match(sql, /delegate_agent_id/);
    assert.equal(params[1], "delegate");
    assert.equal(params[10], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.equal(params[11], "web-mo7ho2z4-0fojstsu");
    assert.equal(params[12], "hidden-reviewer");
  });

  test("缺省(未打标路径:普通 chat / codexFinalizer / 旧容器)→ mode='chat',两列 NULL", async () => {
    const { inserts, stubPool } = makeSettleStubs();
    await settleUsageAndLedger(stubPool, {
      ...settleBase,
      requestId: "req-chat-1",
    });
    const { params } = inserts[0]!;
    assert.equal(params[1], "chat");
    assert.equal(params[11], null);
    assert.equal(params[12], null);
  });
});
