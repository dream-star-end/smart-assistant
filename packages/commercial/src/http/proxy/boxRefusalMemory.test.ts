import test from "node:test";
import assert from "node:assert/strict";
import { _resetBoxRefusalMemoryForTest, recentBoxRefusal, rememberBoxRefusal } from "./boxRefusalMemory.js";

const key = { uid: 247n, sessionId: "s1", turnKey: "t1", model: "box-api-claude-sonnet-5-5" };

test("a refused Box call is remembered for its own logical turn only, for ten minutes", () => {
  _resetBoxRefusalMemoryForTest();
  assert.equal(recentBoxRefusal(key, 0), null);
  rememberBoxRefusal(key, "BOX_CLI_UPSTREAM_RATE_LIMITED", 1_000);
  assert.equal(recentBoxRefusal(key, 2_000), "BOX_CLI_UPSTREAM_RATE_LIMITED");
  assert.equal(recentBoxRefusal({ ...key, turnKey: "t2" }, 2_000), null);
  assert.equal(recentBoxRefusal({ ...key, uid: 248n }, 2_000), null);
  assert.equal(recentBoxRefusal({ ...key, model: "box-api-claude-opus-5-5" }, 2_000), null);
  assert.equal(recentBoxRefusal(key, 1_000 + 10 * 60_000 + 1), null, "expired");
  assert.equal(recentBoxRefusal(key, 1_000 + 10 * 60_000 + 2), null, "and stays gone");
});

test("the memory is bounded and keeps the newest entries", () => {
  _resetBoxRefusalMemoryForTest();
  for (let i = 0; i < 600; i++) rememberBoxRefusal({ ...key, turnKey: `t${i}` }, "BOX_CLI_UPSTREAM_REFUSED", i);
  assert.equal(recentBoxRefusal({ ...key, turnKey: "t0" }, 700), null);
  assert.equal(recentBoxRefusal({ ...key, turnKey: "t599" }, 700), "BOX_CLI_UPSTREAM_REFUSED");
});
