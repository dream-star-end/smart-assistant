import test from "node:test";
import assert from "node:assert/strict";
import { boxNativeTranscriptPath, parseBoxNativePointer } from "./boxNativePointer.js";

const now = 1_800_000_000_000;
const valid = {
  version: 1, accountId: "20", upstreamModel: "claude-opus-5-5",
  cliVersion: "2.1.280", nativeSessionId: "12345678-1234-4123-8123-123456789abc",
  cliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
  transcriptSha256: "b".repeat(64), contextHashBeforeFinal: "c".repeat(64),
  assistantContentHash: "d".repeat(64), catalogHash: "e".repeat(64),
  expiresAtMs: now + 7 * 24 * 60 * 60 * 1000,
};

test("native pointer derives one owner-scoped Claude transcript path", () => {
  const parsed = parseBoxNativePointer(valid, now);
  assert.ok(parsed);
  assert.equal(boxNativeTranscriptPath(parsed),
    `/home/box/.claude/projects/-tmp-ocv5-289-run-${"a".repeat(24)}/${valid.nativeSessionId}.jsonl`);
});

test("malformed, expired and path-swapped native pointers are cache misses", () => {
  for (const altered of [
    { ...valid, accountId: "0" },
    { ...valid, cliCwd: "/tmp/../home/box/.claude" },
    { ...valid, nativeSessionId: "not-a-uuid" },
    { ...valid, transcriptSha256: "0".repeat(63) },
    { ...valid, contextHashBeforeFinal: "prompt plaintext" },
    { ...valid, catalogHash: "wrong" },
    { ...valid, cliVersion: "2.1.281" },
    { ...valid, expiresAtMs: now - 1 },
    { ...valid, expiresAtMs: now + 31 * 24 * 60 * 60 * 1000 },
    { ...valid, token: "must-not-be-stored" },
  ]) assert.equal(parseBoxNativePointer(altered, now), null);
  assert.equal(parseBoxNativePointer(null, now), null);
  assert.equal(parseBoxNativePointer(valid, Number.NaN), null);
  assert.equal(parseBoxNativePointer({ ...valid, upstreamModel: "claude-." }, now), null);
});
