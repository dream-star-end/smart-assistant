import test from "node:test";
import assert from "node:assert/strict";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { acceptBoxToolProgress, classifyBoxToolProgress } from "./boxToolProgress.js";

const catalog = compileBoxToolCatalog([{ name: "Bash", description: "synthetic",
  input_schema: { type: "object", properties: {} } }]);
const parent = "toolu_synthetic_owner";
const boxName = "mcp__ocbridge__t0";
const session = "11111111-1111-4111-8111-111111111111";
const outer = "a95915c9-b92f-4980-8c7a-d339e54e5767";
const heartbeat = (elapsed: number, patch: Record<string, unknown> = {}) => ({
  type: "tool_progress", tool_use_id: `${parent}-heartbeat-0`, tool_name: boxName,
  parent_tool_use_id: parent, elapsed_time_seconds: elapsed, heartbeat: true,
  session_id: session, uuid: "22222222-2222-4222-8222-222222222222", ...patch });
const binding = { toolUses: [{ id: parent, boxName, clientName: "Bash" }],
  nativeSessionId: session, catalog };

test("strict heartbeat shape accepts 30 60 540 and rejects malformed progress", () => {
  for (const elapsed of [30, 60, 540, 0, 1.5]) {
    const classified = classifyBoxToolProgress(heartbeat(elapsed));
    assert.equal(classified.kind, "heartbeat");
    assert.equal(acceptBoxToolProgress(classified.kind === "heartbeat"
      ? classified.heartbeat : heartbeat(0) as never, binding), true);
  }
  assert.equal(classifyBoxToolProgress({ type: "rate_limit_event" }).kind, "not_progress");
  assert.equal(classifyBoxToolProgress({ type: "tool_result" }).kind, "not_progress");
  for (const bad of [
    heartbeat(30, { message: {} }),
    heartbeat(30, { event: {} }),
    heartbeat(30, { usage: {} }),
    heartbeat(30, { result: {} }),
    heartbeat(30, { heartbeat: false }),
    heartbeat(-1),
    heartbeat(Number.POSITIVE_INFINITY),
    heartbeat(30, { tool_use_id: `${parent}-heartbeat-01` }),
    heartbeat(30, { tool_use_id: parent }),
    heartbeat(30, { tool_use_id: `${parent}-heartbeat-` }),
    heartbeat(30, { session_id: "not-a-uuid" }),
    heartbeat(30, { parent_tool_use_id: "bash_1" }),
    heartbeat(30, { tool_name: "Bash" }),
    { ...heartbeat(30), heartbeat: "true" },
  ]) {
    assert.equal(classifyBoxToolProgress(bad).kind, "malformed", JSON.stringify(bad));
  }
  const ok = classifyBoxToolProgress(heartbeat(30));
  assert.equal(ok.kind, "heartbeat");
  if (ok.kind !== "heartbeat") return;
  assert.equal(acceptBoxToolProgress(ok.heartbeat, undefined), false);
  assert.equal(acceptBoxToolProgress(ok.heartbeat, { ...binding, nativeSessionId: outer }), false);
  assert.equal(acceptBoxToolProgress({ ...ok.heartbeat, sessionId: outer }, binding), false);
  assert.equal(acceptBoxToolProgress({ ...ok.heartbeat, parentToolUseId: "toolu_other" }, binding), false);
  assert.equal(acceptBoxToolProgress({ ...ok.heartbeat, toolName: "mcp__ocbridge__t1" }, binding), false);
  assert.equal(acceptBoxToolProgress(ok.heartbeat, { ...binding,
    toolUses: [{ id: parent, boxName, clientName: "Read" }] }), false);
});
