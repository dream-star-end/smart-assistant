import test from "node:test";
import assert from "node:assert/strict";
import { parseBoxStoredToolHandoff } from "./boxStoredToolHandoff.js";

const evidence = () => ({ version: 1, roundNo: 1, messageId: "msg_tool", spoolOffset: 1234,
  assistantContentHash: "d".repeat(64),
  detachedRunnerHash: "f".repeat(64),
  catalogHash: "e".repeat(64),
  toolUses: [
    { id: "toolu_A", boxName: "mcp__ocbridge__t0",
      clientName: "local_echo", inputHash: "a".repeat(64) },
    { id: "toolu_B", boxName: "mcp__ocbridge__t0",
      clientName: "local_echo", inputHash: "a".repeat(64) },
  ], verifiedPendingToolUseIds: ["toolu_A"],
  usage: { inputTokens: 2, outputTokens: 3,
    cacheReadTokens: 0, cacheWriteTokens: 0 } });

test("valid handoff stores only unique model IDs and argument hashes", () => {
  assert.deepEqual(parseBoxStoredToolHandoff(evidence()), evidence());
  const later = evidence(); later.roundNo = 2;
  assert.deepEqual(parseBoxStoredToolHandoff(later), later);
});

test("duplicate IDs, duplicate pending, raw args and sparse arrays fail closed", () => {
  const duplicate = evidence(); duplicate.toolUses[1]!.id = "toolu_A";
  assert.equal(parseBoxStoredToolHandoff(duplicate), null);
  const pending = evidence(); pending.verifiedPendingToolUseIds = ["toolu_A", "toolu_A"];
  assert.equal(parseBoxStoredToolHandoff(pending), null);
  const raw = evidence() as unknown as { toolUses: Array<Record<string, unknown>> };
  raw.toolUses[0]!.input = { secret: "must-not-enter-PG" };
  assert.equal(parseBoxStoredToolHandoff(raw), null);
  const sparse = evidence(); delete (sparse.toolUses as unknown[])[0];
  assert.equal(parseBoxStoredToolHandoff(sparse), null);
  const wrongUsage = evidence(); wrongUsage.usage.outputTokens = -1;
  assert.equal(parseBoxStoredToolHandoff(wrongUsage), null);
  const wrongOffset = evidence(); wrongOffset.spoolOffset = 0;
  assert.equal(parseBoxStoredToolHandoff(wrongOffset), null);
  const wrongRunner = evidence(); wrongRunner.detachedRunnerHash = "x".repeat(64);
  assert.equal(parseBoxStoredToolHandoff(wrongRunner), null);
  const wrongCatalog = evidence(); wrongCatalog.catalogHash = "x".repeat(64);
  assert.equal(parseBoxStoredToolHandoff(wrongCatalog), null);
  const wrongAssistant = evidence(); wrongAssistant.assistantContentHash = "x".repeat(64);
  assert.equal(parseBoxStoredToolHandoff(wrongAssistant), null);
  const beyondCap = evidence(); beyondCap.roundNo = 33;
  assert.equal(parseBoxStoredToolHandoff(beyondCap), null);
});
