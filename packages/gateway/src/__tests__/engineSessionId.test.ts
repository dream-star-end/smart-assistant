/**
 * engineSessionId 口径测试(M0)。
 *
 * 锁死算法:'oceng-' + sha256(sessionKey).hex.slice(0, 48),共 54 字符。
 * 该 id 是 M2 codex turn 记账(usage_records.session_id)与 idle-timeout
 * 免单/退款窗口(internalTurnWaive SESSION_ID_RE)的唯一口径 —— 任何实现漂移
 * 都会让 settle 落库与 waive 上报对不上号,直接钱安全事故,故逐性质断言。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/engineSessionId.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ENGINE_SESSION_ID_PREFIX,
  engineSessionId,
} from "../engine/engineSessionId.js";

// internalTurnWaive.ts 的端点校验(不放宽),这里镜像锁一致性。
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

describe("engineSessionId", () => {
  test("算法钉死:'oceng-' + sha256 hex 前 48 位", () => {
    const key = "agent:main:webchat:dm:peer-1";
    const expected =
      "oceng-" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 48);
    assert.equal(engineSessionId(key), expected);
    assert.equal(ENGINE_SESSION_ID_PREFIX, "oceng-");
  });

  test("长度恒为 54 且满足 SESSION_ID_RE(waive 端点校验不放宽)", () => {
    for (const key of ["a", "agent:codex:webchat:dm:x", "中文键🔥", "x".repeat(500)]) {
      const id = engineSessionId(key);
      assert.equal(id.length, 54);
      assert.match(id, SESSION_ID_RE);
    }
  });

  test("确定性:同 key 恒等,不同 key 不同", () => {
    const a1 = engineSessionId("session-a");
    const a2 = engineSessionId("session-a");
    const b = engineSessionId("session-b");
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
  });
});
