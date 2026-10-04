import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { assembleIdleArtifact } from "../../boxIdleCompact.js";
import { assertRecoveredContent } from "./idleCrashFixture.js";

test("recovery oracle is pinned to prepared tools and images, not recovered metadata", () => {
  const tail = [
    { uuid: "a", parentUuid: null, message: { uuid: "a", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "a" } }] } } },
    { uuid: "u", parentUuid: "a", message: { uuid: "u", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "body" }, { type: "image", source: { type: "base64", data: "test-image" } }] } } },
  ];
  const frozen = { opId: "same-op", sessionId: "same-session", revision: "same-revision", summaryText: "summary", modelCalls: 1, frozenTail: tail, attachments: [] };
  const native = { ...structuredClone(frozen), applied: true, artifact: assembleIdleArtifact({ opId: frozen.opId, summaryText: frozen.summaryText, tail, attachments: [] }) };
  const prefix = [{ uuid: "boundary", type: "system", subtype: "compact_boundary", compactMetadata: { idleOpId: frozen.opId } }, { uuid: "summary", type: "user", isCompactSummary: true, message: { content: frozen.summaryText } }];
  const loaded = [...prefix, ...tail.map(row => row.message)];
  assert.doesNotThrow(() => assertRecoveredContent(loaded, native, frozen));
  const dropped = structuredClone(native); dropped.frozenTail = [];
  assert.throws(() => assertRecoveredContent(prefix, dropped, frozen), /immutable prepared frozenTail/);
  const changed = structuredClone(native); changed.frozenTail[1]!.message.message.content = [];
  assert.throws(() => assertRecoveredContent(prefix, changed, frozen), /immutable prepared frozenTail/);
  assert.throws(() => assertRecoveredContent([...prefix, ...tail.map(row => row.message).reverse()], native, frozen), /preserved UUIDs/);
  const missing = structuredClone(loaded); missing.pop();
  assert.throws(() => assertRecoveredContent(missing, native, frozen), /preserved UUIDs/);
});


test("checkpoint hash describes saved bytes when the live source changes at the write boundary", () => {
  // This deterministic writer targets only an isolated synthetic candidate.
  // It does not replace read/hash/restore or imply a multi-file atomic snapshot.
  const script = [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'import { createHash } from "node:crypto";',
    'const fixture = await import(process.argv[1]);',
    'const home = fs.mkdtempSync(join(tmpdir(), "idle-checkpoint-window-"));',
    'const root = fs.mkdtempSync(join(tmpdir(), "idle-checkpoint-saved-"));',
    'const key = "checkpoint-session", id = "checkpoint-native";',
    'const relative = join("idle-candidates", key + ".json");',
    'const source = join(home, relative), saved = join(root, relative);',
    'const original = Buffer.from(JSON.stringify({ pending: true, revision: "before" }));',
    'const changed = Buffer.from(JSON.stringify({ pending: true, revision: "after" }));',
    'const originalCopy = fs.cpSync, originalWrite = fs.writeFileSync;',
    'let injected = 0;',
    'const afterWrite = (path) => {',
    '  if (String(path) === saved && injected === 0) { injected++; originalWrite(source, changed); }',
    '};',
    'try {',
    '  fs.mkdirSync(join(home, "idle-candidates"), { recursive: true });',
    '  fs.mkdirSync(join(home, "claude-config"), { recursive: true });',
    '  fs.writeFileSync(source, original);',
    '  fs.writeFileSync(join(home, "claude-config", id + ".jsonl"), "{}\\n");',
    '  fs.cpSync = (...args) => { const value = originalCopy(...args); afterWrite(args[1]); return value; };',
    '  fs.writeFileSync = (...args) => { const value = originalWrite(...args); afterWrite(args[0]); return value; };',
    '  syncBuiltinESMExports();',
    '  const snapshot = fixture.saveIdleCheckpoint(home, root, key, id);',
    '  assert.equal(injected, 1, "must hit the actual snapshot write window");',
    '  assert.deepEqual(fs.readFileSync(source), changed, "writer must change the live source");',
    '  assert.deepEqual(fs.readFileSync(saved), original, "snapshot must retain captured bytes");',
    '  const receipt = snapshot.files.find(file => file.relative === relative);',
    '  const hash = createHash("sha256").update(original).digest("hex");',
    '  assert.equal(receipt.sha256, hash, "manifest hash must describe the captured snapshot bytes");',
    '  fixture.restoreIdleCheckpoint(snapshot);',
    '  assert.deepEqual(fs.readFileSync(source), original, "restore must retain the original integrity check");',
    '  originalWrite(saved, changed);',
    '  assert.throws(() => fixture.restoreIdleCheckpoint(snapshot), { code: "ERR_ASSERTION" });',
    '  console.log(JSON.stringify({ injected, savedSha256: hash, receiptSha256: receipt.sha256, restore: true, corruptRejected: true }));',
    '} finally {',
    '  fs.cpSync = originalCopy; fs.writeFileSync = originalWrite; syncBuiltinESMExports();',
    '  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });',
    '}',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    script, new URL("./idleCrashFixture.ts", import.meta.url).href], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  const receipt = JSON.parse(child.stdout.trim());
  assert.deepEqual(receipt, { injected: 1, savedSha256: receipt.receiptSha256,
    receiptSha256: receipt.savedSha256, restore: true, corruptRejected: true });
});
