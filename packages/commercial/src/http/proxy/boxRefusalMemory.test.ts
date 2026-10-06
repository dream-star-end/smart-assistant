import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { _resetBoxRefusalMemoryForTest, forgetBoxRefusal, recentBoxRefusal, rememberBoxRefusal } from "./boxRefusalMemory.js";
import { sendBoxUpstreamRefusal } from "./core.js";

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

test("a new launch of the turn supersedes its earlier refusal", () => {
  _resetBoxRefusalMemoryForTest();
  rememberBoxRefusal(key, "BOX_CLI_UPSTREAM_RATE_LIMITED", 1);
  forgetBoxRefusal(key);
  assert.equal(recentBoxRefusal(key, 2), null);
});

test("the client sees a 503 with Retry-After for a usage-limit refusal and for any other refusal", async () => {
  let code = "BOX_CLI_UPSTREAM_RATE_LIMITED";
  const server = createServer((_req, res) => sendBoxUpstreamRefusal(res, code, "req-1"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    for (const [value, status, name, after] of [
      ["BOX_CLI_UPSTREAM_RATE_LIMITED", 503, "BOX_UPSTREAM_RATE_LIMITED", "300"],
      ["BOX_CLI_UPSTREAM_REFUSED", 503, "BOX_UPSTREAM_REFUSED", "30"],
    ] as const) {
      code = value;
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const body = await response.json() as { error: { code: string; message: string } };
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), after);
      assert.equal(body.error.code, name);
      assert.match(body.error.message, /nothing was charged/);
    }
  } finally { server.close(); }
});
