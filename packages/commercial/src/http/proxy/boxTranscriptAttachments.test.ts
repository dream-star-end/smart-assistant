import assert from "node:assert/strict";
import test from "node:test";
import { BOX_STAGED_ATTACHMENT_TYPES, makeBoxTranscriptAttachmentsRead,
  parseBoxTranscriptAttachments } from "./boxTranscriptAttachments.js";

const source = { cliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
  nativeSessionId: "12345678-1234-4123-8123-123456789abc" };

test("OCV5-384: the read is pinned to one native transcript and the allowed record types", () => {
  const req = makeBoxTranscriptAttachmentsRead(source);
  assert.equal(req.command, "/usr/bin/python3");
  assert.deepEqual(req.args.slice(3), [source.cliCwd, source.nativeSessionId,
    BOX_STAGED_ATTACHMENT_TYPES.join(",")]);
  assert.equal(BOX_STAGED_ATTACHMENT_TYPES.includes("prompt_snapshot"), false);
  assert.throws(() => makeBoxTranscriptAttachmentsRead({ ...source, cliCwd: "/tmp/elsewhere" }));
  assert.throws(() => makeBoxTranscriptAttachmentsRead({ ...source, nativeSessionId: "x" }));
});

test("OCV5-384: only well-formed context records are accepted", () => {
  const ok = { type: "attachment", attachment: { type: "date", date: "2026-10-12" } };
  assert.deepEqual(parseBoxTranscriptAttachments(JSON.stringify({ records: [ok] })), [ok]);
  assert.deepEqual(parseBoxTranscriptAttachments('{"records":[]}'), []);
  assert.equal(parseBoxTranscriptAttachments("not json"), null);
  assert.equal(parseBoxTranscriptAttachments(JSON.stringify({ records: [ok], extra: 1 })), null);
  assert.equal(parseBoxTranscriptAttachments(JSON.stringify({ records: [
    { type: "attachment", attachment: { type: "prompt_snapshot" } }] })), null);
  assert.equal(parseBoxTranscriptAttachments(JSON.stringify({ records: [{ type: "user" }] })), null);
  assert.equal(parseBoxTranscriptAttachments(JSON.stringify({ records: Array(17).fill(ok) })), null);
});
