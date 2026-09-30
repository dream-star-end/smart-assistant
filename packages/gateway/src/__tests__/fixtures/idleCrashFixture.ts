/** Test-only event injection into a git-archive candidate, never the product tree.
 * Normal paths are unchanged. A fault stops at a real durable consumer boundary;
 * it never manufactures summary/applied/receipt state or truncates a JSON file. */
import assert from "node:assert/strict";
import { assembleIdleArtifact } from "../../boxIdleCompact.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
export type IdleFault = "before-artifact" | "native-half" | "receipt-lost";

export function installIdleFaultFixture(candidate: string, control: string): { before: string; after: string } {
  mkdirSync(control, { recursive: true });
  const path = join(candidate, "claude-code-best/src/services/compact/idleRecover.ts");
  const before = readFileSync(path, "utf8");
  const armed = JSON.stringify(join(control, "armed.json"));
  const reached = JSON.stringify(join(control, "reached.json"));
  const hook = `
function testIdleFaultArmed(point: string): boolean {
  try { return JSON.parse(readFileSync(${armed}, 'utf8')).point === point } catch { return false }
}
async function testIdleFault(point: string, evidence: unknown): Promise<void> {
  if (!testIdleFaultArmed(point)) return
  writeFileSync(${reached}, JSON.stringify({ point, evidence, pid: process.pid }))
  await new Promise<never>(() => {})
}
`;
  let after = before + hook;
  const replace = (needle: string, replacement: string) => {
    assert.equal(after.split(needle).length, 2, `fault injection seam: ${needle}`);
    after = after.replace(needle, replacement);
  };
  replace("  const built = buildIdleCompactionResult(resumed.file, input.messages, annotateBoundaryWithPreservedSegment)",
    "  await testIdleFault('before-artifact', resumed.file)\n  const built = buildIdleCompactionResult(resumed.file, input.messages, annotateBoundaryWithPreservedSegment)");
  replace("  await input.record(messages, undefined, undefined, undefined, true)",
    `  if (testIdleFaultArmed('native-half')) {
    await input.record(messages.slice(0, 2), undefined, undefined, undefined, true)
    await input.flush()
    await testIdleFault('native-half', { file: resumed.file, writtenUuids: messages.slice(0, 2).map(m => m.uuid) })
  }
  await input.record(messages, undefined, undefined, undefined, true)`);
  replace("  writeIdleNativeFile(resumed.path, { ...resumed.file, applied: true, artifact: built.artifact })",
    "  writeIdleNativeFile(resumed.path, { ...resumed.file, applied: true, artifact: built.artifact })\n  await testIdleFault('receipt-lost', { file: readIdleNativeFile(resumed.path), messageUuids: messages.map(m => m.uuid) })");
  writeFileSync(path, after);
  return { before: createHash("sha256").update(before).digest("hex"), after: createHash("sha256").update(after).digest("hex") };
}

export function armIdleFault(control: string, point: IdleFault | null): void {
  rmSync(join(control, "reached.json"), { force: true });
  if (point) writeFileSync(join(control, "armed.json"), JSON.stringify({ point }));
  else rmSync(join(control, "armed.json"), { force: true });
}

export type IdleCheckpoint = { root: string; home: string; files: Array<{ relative: string; sha256: string }>; directories: string[] };
export function saveIdleCheckpoint(home: string, root: string, sessionKey: string, nativeId: string): IdleCheckpoint {
  assert.match(nativeId, /^[a-zA-Z0-9-]+$/);
  mkdirSync(root, { recursive: true });
  const files: string[] = [];
  const walk = (dir: string, filter: (name: string) => boolean) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file, filter);
      else if (entry.isFile() && filter(entry.name)) files.push(file);
    }
  };
  const directories = [join("idle-ops", encodeURIComponent(sessionKey)), join("idle-native", encodeURIComponent(nativeId))];
  for (const dir of directories) walk(join(home, dir), name => name.endsWith(".json"));
  const candidate = join(home, "idle-candidates", `${encodeURIComponent(sessionKey)}.json`);
  assert.ok(existsSync(candidate), "checkpoint requires the real pending candidate");
  files.push(candidate);
  walk(join(home, "claude-config"), name => name === `${nativeId}.jsonl`);
  assert.equal(files.filter(file => file.endsWith(".jsonl")).length, 1, "exactly this session transcript required");
  const saved = files.map(file => {
    const rel = relative(home, file);
    assert.ok(!rel.startsWith(".."));
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(file, join(root, rel));
    return { relative: rel, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  });
  const result = { root, home, files: saved, directories };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(result, null, 2));
  return result;
}

/** Call only after the old runner has exited. Restores this op and its matching
 * real transcript, not an already-applied state with fields deleted. */
export function restoreIdleCheckpoint(snapshot: IdleCheckpoint): void {
  for (const file of snapshot.files) {
    assert.equal(createHash("sha256").update(readFileSync(join(snapshot.root, file.relative))).digest("hex"), file.sha256);
  }
  for (const dir of snapshot.directories) rmSync(join(snapshot.home, dir), { recursive: true, force: true });
  for (const file of snapshot.files) {
    const target = join(snapshot.home, file.relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(snapshot.root, file.relative), target);
  }
}

export function readRecoveredConversation(candidate: string, home: string, nativeId: string, cwd: string, output: string): Array<Record<string, any>> {
  const script = join(dirname(output), "load-recovered.ts");
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
const { loadConversationForResume } = await import(${JSON.stringify(join(candidate, "claude-code-best/src/utils/conversationRecovery.ts"))});
const result = await loadConversationForResume(${JSON.stringify(nativeId)}, undefined);
if (!result || result.sessionId !== ${JSON.stringify(nativeId)}) throw new Error('loader did not return the exact native session');
writeFileSync(${JSON.stringify(output)}, JSON.stringify(result.messages));
process.exit(0);
`);
  const child = spawnSync("bun", [script], { cwd, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, OPENCLAUDE_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude-config") } });
  assert.equal(child.status, 0, `${child.error ?? ""} ${child.stderr}`);
  return JSON.parse(readFileSync(output, "utf8"));
}

export function assertRecoveredContent(messages: Array<Record<string, any>>, native: Record<string, any>, frozen: Record<string, any>): void {
  assert.equal(native.applied, true);
  assert.equal(native.modelCalls, 1);
  assert.ok(native.artifact?.digest);
  for (const key of ["opId", "sessionId", "revision", "summaryText", "modelCalls", "frozenTail", "attachments"]) {
    assert.deepEqual(native[key], frozen[key], `immutable prepared ${key}`);
  }
  const artifact = assembleIdleArtifact({ opId: frozen.opId, summaryText: frozen.summaryText,
    tail: frozen.frozenTail, attachments: frozen.attachments });
  assert.deepEqual(native.artifact, artifact, "artifact from immutable prepared input");
  const expected = [...frozen.frozenTail, ...frozen.attachments].map((row: any) => row.message);
  const ids = expected.map((row: any) => row.uuid);
  const actual = messages.filter(row => ids.includes(row.uuid));
  assert.deepEqual(actual.map(row => row.uuid), ids, "preserved UUIDs/order");
  assert.equal(new Set(actual.map(row => row.uuid)).size, ids.length, "no duplicate preserved messages");
  const stable = (row: any) => ({ uuid: row.uuid, type: row.type, role: row.message?.role,
    content: row.message?.content ?? row.content, attachment: row.attachment });
  assert.deepEqual(actual.map(stable), expected.map(stable), "complete role/tool/image/content preservation");
  const boundary = messages.find(row => row.subtype === "compact_boundary" && row.compactMetadata?.idleOpId === native.opId);
  assert.ok(boundary, "same-op real compact boundary missing");
  assert.ok(messages.some(row => row.isCompactSummary && row.message?.content === native.summaryText), "real summary missing");
}
