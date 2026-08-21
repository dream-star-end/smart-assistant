import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = await mkdtemp(join(tmpdir(), "oc-observability-retention-"));
process.env.OPENCLAUDE_HOME = home;

const {
  closeSessionsDb,
  getSessionsDb,
  insertEvent,
  insertUsageLog,
  pruneLocalObservability,
} = await import("../sessionsDb.js");

after(async () => { await closeSessionsDb(); });

test("prunes old raw events independently from longer-lived usage aggregates", async () => {
  await insertEvent({
    id: "old-event", type: "tool.called", timestamp: 10, agentId: "main",
    sessionKey: "s", schemaVersion: 1,
    payload: JSON.stringify({ inputPreview: "old secret", outputPreview: "old output", kept: 1 }),
  });
  await insertEvent({
    id: "new-event", type: "tool.called", timestamp: 100, agentId: "main",
    sessionKey: "s", schemaVersion: 1,
    payload: JSON.stringify({ inputPreview: "recent secret", outputPreview: "recent output", kept: 2 }),
  });
  await insertUsageLog({
    id: "old-usage", sessionId: "s", agentId: "main", turnIndex: 1, model: "m",
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, durationMs: 1, toolCalls: 0, timestamp: 10,
  });
  await insertUsageLog({
    id: "new-usage", sessionId: "s", agentId: "main", turnIndex: 2, model: "m",
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, durationMs: 1, toolCalls: 0, timestamp: 100,
  });
  assert.deepEqual(await pruneLocalObservability({ eventBeforeMs: 50, usageBeforeMs: 20 }), {
    previewsScrubbed: 2,
    eventsDeleted: 1,
    usageDeleted: 1,
  });
  const db = await getSessionsDb();
  assert.deepEqual(db.prepare("SELECT id,payload FROM event_log ORDER BY id").all(), [{
    id: "new-event",
    payload: JSON.stringify({ kept: 2 }),
  }]);
  assert.deepEqual(db.prepare("SELECT id FROM usage_log ORDER BY id").all(), [{ id: "new-usage" }]);
});
