/** OCV5-294: coordinate captions fold into the owning tool_result before resume. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";
import { validateBoxRequest } from "./boxRequestGate.js";
import { deriveBoxContextHash } from "./boxCallFingerprint.js";
import { classifyBoxContinuation } from "./boxPreparedContinuation.js";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import { makeBoxToolResultPlan } from "./boxToolResultPlan.js";
import { BoxToolResultEcho, BoxToolResultEchoError } from "./boxToolResultEcho.js";
import { compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import { makeBoxNativeHistoryBasis, matchesBoxNativeHistory } from "./boxNativeHistory.js";
import { BoxToolFetch } from "./boxToolFetch.js";
import type { ProxyBody } from "./shared.js";

const CAPTION_80 = "[Image: original 80x2200, displayed at 73x2000. Multiply coordinates by 1.10 to map to original image.]";
const CAPTION_JSONL = "[Image: original 1290x2796, displayed at 923x2000. Multiply coordinates by 1.40 to map to original image.]";
const HOOK = "<system-reminder>\nPreToolUse:Read hook additional context: keep the figure.\n</system-reminder>";
const BUDGET = "<total_tokens>14999987 tokens left</total_tokens>";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SEALED = fileURLToPath(new URL("./__fixtures__/box-image-continuation/", import.meta.url));
const SMALL_PRIOR = "07627858ce0e2f31de209036a2e0e7985d217c0c47ce3f01b8a334d1506f2ea2";
const SMALL_NEXT = "1e12632030a3e7f45a9f275a6de7ce6031830ba601151529db4a897832fd6922";
const SEALED_IMAGE = "a9491d8d9cb458b11d4ac6c5fc4b5c2d4d370a1d9b6f7960cc5dffae678538a0";

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function image(data = PNG) {
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}
function budget(text = BUDGET) {
  return { role: "system", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] };
}
function body(messages: unknown[], extra: Record<string, unknown> = {}): ProxyBody {
  return { model: "box-api-claude-opus-5-5", stream: true, max_tokens: 128,
    tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
      { name: "Note", description: "note", input_schema: { type: "object", properties: {} } }],
    messages, metadata: { user_id: JSON.stringify({ session_id: "sess-a",
      oc_turn_key: "ab".repeat(32) }) }, ...extra } as ProxyBody;
}
function uses() {
  return [
    { type: "tool_use", id: "toolu_img_owner", name: "Read", input: { file_path: "a.png" } },
    { type: "tool_use", id: "toolu_note_last", name: "Note", input: { file_path: "a.md" } },
  ];
}
function siblingTurn(caption = CAPTION_80, data = PNG): ProxyBody {
  return body([
    { role: "user", content: "look" },
    { role: "assistant", content: uses() },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_img_owner", content: [image(data)] },
      { type: "tool_result", tool_use_id: "toolu_note_last", content: "note-bytes" },
      { type: "text", text: caption },
      { type: "text", text: HOOK },
    ] },
    budget(),
  ]);
}
test("a caption in CCB's adjacent user message resumes the image handoff", () => {
  const raw = body([
    { role: "user", content: "look" },
    { role: "assistant", content: uses() },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_img_owner", content: [image()] },
      { type: "tool_result", tool_use_id: "toolu_note_last", content: "note-bytes" },
    ] },
    { role: "user", content: CAPTION_JSONL },
  ]);
  assert.equal(classifyBoxContinuation(raw).classification, "continuation_candidate");
  const normalized = normalizeBoxSemanticBody(raw);
  const current = normalized.messages.at(-1) as { content?: unknown };
  assert.equal(JSON.stringify(current.content).includes(CAPTION_JSONL), true);
});

function resultContent(normalized: ProxyBody, id: string): unknown[] {
  const user = normalized.messages.at(-1) as { content: Array<Record<string, unknown>> };
  const block = user.content.find((part) => part.tool_use_id === id);
  assert.ok(block, id);
  assert.ok(Array.isArray(block.content));
  return block.content as unknown[];
}

test("unique non-terminal image keeps the original caption once, then hook and budget", () => {
  const raw = siblingTurn();
  const snapshot = structuredClone(raw);
  const once = normalizeBoxSemanticBody(raw);
  const twice = normalizeBoxSemanticBody(once);
  assert.deepEqual(raw, snapshot);
  assert.deepEqual(once, twice);
  assert.equal(validateBoxRequest(raw, true), null);
  const user = once.messages.at(-1) as { content: Array<Record<string, unknown>> };
  assert.ok(user.content.every((part) => part.type === "tool_result"));
  const flat = JSON.stringify(once);
  assert.equal(flat.split(CAPTION_80).length - 1, 1);
  assert.equal(flat.split(HOOK.replaceAll("\n", "\\n")).length - 1, 1);
  assert.equal(flat.includes("<total_tokens>"), false);
  const owned = resultContent(once, "toolu_img_owner");
  assert.deepEqual(owned[0], image());
  assert.deepEqual(owned[1], { type: "text", text: CAPTION_80 });
  const note = resultContent(once, "toolu_note_last");
  assert.equal(JSON.stringify(note).includes(CAPTION_80), false);
  assert.equal(JSON.stringify(note).includes(HOOK.replaceAll("\n", "\\n")), true);
  const jsonl = normalizeBoxSemanticBody(siblingTurn(CAPTION_JSONL));
  assert.equal(JSON.stringify(resultContent(jsonl, "toolu_img_owner")).includes(CAPTION_JSONL), true);
});

test("unknown, conflicting, and malformed captions stay unfolded", () => {
  const unknown = siblingTurn("[Image: original 10x10, displayed at 10x10. Multiply coordinates by 1.00 to map to original image.]");
  assert.notEqual(validateBoxRequest(unknown, true), null);
  assert.equal(JSON.stringify(normalizeBoxSemanticBody(unknown)).split("displayed at").length - 1, 1);
  const conflict = siblingTurn();
  const user = conflict.messages[2] as { content: Array<Record<string, unknown>> };
  (user.content[0]!.content as unknown[]).push({ type: "text", text: CAPTION_80 });
  const kept = normalizeBoxSemanticBody(conflict);
  const still = (kept.messages[2] as { content: unknown[] }).content;
  assert.equal(still.some((part) => (part as { type?: string }).type === "text"), true);
  const swapped = siblingTurn();
  const blocks = (swapped.messages[2] as { content: Array<{ tool_use_id?: string }> }).content;
  blocks[0]!.tool_use_id = "toolu_not_the_owner";
  assert.equal((normalizeBoxSemanticBody(swapped).messages[2] as { content: unknown[] }).content
    .some((part) => (part as { type?: string }).type === "text"), true);
  const bare = Buffer.from(PNG, "base64");
  bare[bare.length - 1] ^= 0xff;
  const mutated = bare.toString("base64");
  assert.equal(Buffer.from(mutated, "base64").toString("base64"), mutated);
  assert.equal(validateBoxRequest(siblingTurn(CAPTION_80, mutated), true), null);
});

test("historical strict images compile and top-level images stay unsupported", () => {
  const args = { cwd: "/tmp/ocv5-289-run-aaaaaaaaaaaaaaaaaaaaaaaa", cliVersion: "2.1.280" };
  const history = body([
    { role: "user", content: "look" },
    { role: "assistant", content: [uses()[0]] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_img_owner", content: [image(), { type: "text", text: CAPTION_80 }] },
    ] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "next" },
  ]);
  const turn = compileBoxCliSyntheticTurn(history, args);
  assert.match(turn.snapshotJsonl, /toolu_img_owner/);
  assert.throws(() => compileBoxCliSyntheticTurn(body([
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
  ]), args), (error: unknown) => error instanceof Error && "code" in error
    && error.code === "BOX_BLOCK_UNSUPPORTED");
  assert.throws(() => compileBoxCliSyntheticTurn(body([
    { role: "user", content: "prior" },
    { role: "assistant", content: [uses()[0]] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_img_owner",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG, extra: true } }] }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "next" },
  ]), args), (error: unknown) => error instanceof Error && "code" in error
    && error.code === "BOX_BLOCK_UNSUPPORTED");
});

test("native history hits the folded prefix and a tool tail does not resume as first round", async () => {
  const previous = siblingTurn();
  const basis = makeBoxNativeHistoryBasis(previous, [{ type: "text", text: "final answer" }]);
  const next = body([
    ...(previous.messages as unknown[]),
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    { role: "user", content: "thanks" },
  ]);
  assert.equal(matchesBoxNativeHistory(next, basis), true);
  const changed = structuredClone(next);
  const caption = (((changed.messages[2] as { content: Array<{ text?: string }> }).content)
    .find((part) => part.text === CAPTION_80)!);
  caption.text = `${CAPTION_80} `;
  assert.equal(matchesBoxNativeHistory(changed, basis), false);
  let first = 0, published = 0;
  const target = { accountId: 20n, exec: { run: async () => ({ stdout: "", stderrBytes: 0, exitCode: 0 as const }) },
    dispose: async () => {} };
  const claim = { runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), accountId: 20n,
    spoolOffset: 8, roundNo: 2 };
  const service = new BoxToolFetch({ supervisorAsset: Buffer.from("s"), keeperAsset: Buffer.from("k"),
    virtualMcpAsset: Buffer.from("m"), detachedRunnerAsset: Buffer.from("d"),
    journal: { claimRemoteCleanup: async () => true, remoteCleanupStatus: async () => "pending",
      remoteCleanupDoneByRunIdentity: async () => false, prelaunchCleanupDoneByRunIdentity: async () => false,
      listRemoteCleanupCandidates: async () => [], markRemoteCleaned: async () => {} } as never,
    maxOutputTokensForModel: () => 128,
    resolveTarget: async () => target as never, onUnknown: async () => {},
    runFirst: (async () => { first += 1; throw new Error("runFirst"); }) as never,
    publishResume: (async () => { published += 1; return { claim, target, access: {} }; }) as never,
    runContinuation: (async (input: { emit: (sse: string) => void }) => {
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", proof: { runNonce: claim.runNonce, leaseEpoch: claim.leaseEpoch,
        keeperPid: 1, cliPid: 2, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  const response = await service.fetch({ uid: 3n, sessionId: "s", requestId: "img-next",
    canonicalModel: previous.model, canonicalBody: previous, upstreamModel: "claude-opus-5-5",
    url: "http://127.0.0.1/box", init: { method: "POST" } });
  assert.match(await response.text(), /message_stop/);
  assert.equal(first, 0);
  assert.equal(published, 1);
});

test("publisher file and echo bind the fixture bytes, not the matcher hash", () => {
  const raw = siblingTurn();
  const imageBytes = Buffer.from(PNG, "base64");
  const oracleContent = [
    { type: "image", data: PNG, mimeType: "image/png" },
    { type: "text", text: CAPTION_80 },
    { type: "text", text: HOOK },
  ];
  // Image is not the last tool, so the hook lands on the note. Oracle for the
  // image result is the picture plus the original caption only.
  const imageOracle = oracleContent.slice(0, 2);
  const imageHash = sha(JSON.stringify({ content: imageOracle, isError: false }));
  const matched = matchBoxToolResults(raw, [
    { id: "toolu_img_owner", boxName: "mcp__ocbridge__t0", clientName: "Read", input: { file_path: "a.png" } },
    { id: "toolu_note_last", boxName: "mcp__ocbridge__t1", clientName: "Note", input: { file_path: "a.md" } },
  ]);
  const imageMatch = matched.find((item) => item.modelToolUseId === "toolu_img_owner")!;
  assert.equal(imageMatch.contentHash, imageHash);
  const cwd = `/tmp/ocv5-289-run-${"c".repeat(24)}`;
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { mode: 0o700 });
  try {
    const pending = { version: 1 as const, modelToolUseId: "toolu_img_owner", mcpRequestId: 7,
      name: "t0", arguments: { file_path: "a.png" } };
    const plan = makeBoxToolResultPlan({ cwd, expected: { id: "toolu_img_owner",
      boxName: "mcp__ocbridge__t0", clientName: "Read", input: { file_path: "a.png" } },
      pending, matched: imageMatch });
    for (const request of plan.requests) {
      const ran = spawnSync(request.command, request.args, { cwd: request.cwd,
        env: { ...process.env, ...request.environment }, encoding: "utf8" });
      assert.equal(ran.status, 0, ran.stderr);
    }
    const file = JSON.parse(readFileSync(plan.path, "utf8")) as { modelToolUseId: string;
      content: Array<{ type: string; data?: string; text?: string; mimeType?: string }> };
    assert.equal(file.modelToolUseId, "toolu_img_owner");
    assert.equal(file.content.filter((part) => part.text === CAPTION_80).length, 1);
    const stored = file.content.find((part) => part.type === "image");
    assert.equal(stored?.data, PNG);
    assert.equal(sha(Buffer.from(stored!.data!, "base64")), sha(imageBytes));
    const echo = new BoxToolResultEcho([{ modelToolUseId: "toolu_img_owner",
      contentHash: imageHash, isError: false }]);
    echo.accept({ type: "user", message: { role: "user", content: [{ type: "tool_result",
      tool_use_id: "toolu_img_owner", content: [image(), { type: "text", text: CAPTION_80 }] }] } });
    echo.assertComplete();
    const dropped = new BoxToolResultEcho([{ modelToolUseId: "toolu_img_owner",
      contentHash: imageHash, isError: false }]);
    assert.throws(() => dropped.accept({ type: "user", message: { role: "user", content: [{
      type: "tool_result", tool_use_id: "toolu_img_owner", content: [image()] }] } }),
    (error: unknown) => error instanceof BoxToolResultEchoError
      && error.code === "BOX_TOOL_ECHO_CONTENT_MISMATCH");
    const nudged = `${CAPTION_80.slice(0, -2)}X]`;
    assert.throws(() => new BoxToolResultEcho([{ modelToolUseId: "toolu_img_owner",
      contentHash: imageHash, isError: false }]).accept({ type: "user", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_img_owner",
        content: [image(), { type: "text", text: nudged }] }] } }),
    (error: unknown) => error instanceof BoxToolResultEchoError
      && error.code === "BOX_TOOL_ECHO_CONTENT_MISMATCH");
    const flipped = Buffer.from(imageBytes);
    flipped[flipped.length - 1] ^= 0xff;
    const flippedData = flipped.toString("base64");
    assert.notEqual(sha(JSON.stringify({ content: [
      { type: "image", data: flippedData, mimeType: "image/png" },
      { type: "text", text: CAPTION_80 }], isError: false })), imageHash);
    assert.throws(() => new BoxToolResultEcho([{ modelToolUseId: "toolu_img_owner",
      contentHash: imageHash, isError: false }]).accept({ type: "user", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_img_owner",
        content: [image(flippedData), { type: "text", text: CAPTION_80 }] }] } }),
    (error: unknown) => error instanceof BoxToolResultEchoError
      && error.code === "BOX_TOOL_ECHO_CONTENT_MISMATCH");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function readSealedFixture(name: string, expectedSha: string) {
  const bytes = readFileSync(join(SEALED, name));
  assert.equal(sha(bytes), expectedSha, "fixture byte identity must not drift");
  const parsed = JSON.parse(bytes.toString("utf8")) as { label: string;
    rounds: Array<{ body: ProxyBody; sha256: string; bytes: number }> };
  assert.equal(parsed.label, "sanitized-synthetic-loopback-not-incident-wire");
  for (const round of parsed.rounds) {
    const bodyBytes = JSON.stringify(round.body);
    assert.equal(round.sha256, sha(bodyBytes), "current round hash is not a stale source hash");
    assert.equal(round.bytes, Buffer.byteLength(bodyBytes));
  }
  return parsed;
}

test("sealed tall raw resumes and the small raw context hashes stay put", () => {
  const tall = readSealedFixture("ocv5-294-image-repro-raw-859a435f.json",
    "208d9f42222fe5563f88b6b7ff97fcf8bc6fbee015e5f3e6ef7f41ec9aed5c4f");
  const small = readSealedFixture("ocv5-294-image-repro-raw-0d4483e2.json",
    "04228e790e830b1fec9f95ed7ffb04f002fb977ccde72a90a870bc256ac3c2d8");
  const tallBody = tall.rounds[1]!.body;
  const smallBody = small.rounds[1]!.body;
  const tallSnap = JSON.stringify(tallBody);
  assert.equal(validateBoxRequest(tallBody, true), null);
  assert.equal(JSON.stringify(tallBody), tallSnap);
  const folded = normalizeBoxSemanticBody(tallBody);
  const encoded = JSON.stringify(folded);
  assert.equal(encoded.split(CAPTION_80).length - 1, 1);
  assert.equal(encoded.includes("a9491d8d"), false);
  const user = (folded.messages as Array<{ role?: string; content?: unknown }>)
    .filter((message) => message.role === "user").at(-1) as { content: Array<Record<string, unknown>> };
  const imageResult = user.content.find((part) => JSON.stringify(part).includes("image/png"));
  assert.equal(JSON.stringify(imageResult).split(CAPTION_80).length - 1, 1);
  const stored = JSON.stringify(imageResult);
  const data = /"data":"([^"]+)"/.exec(stored)?.[1] ?? "";
  assert.equal(sha(Buffer.from(data, "base64")), SEALED_IMAGE);
  assert.equal(deriveBoxContextHash(smallBody, true), SMALL_PRIOR);
  assert.equal(deriveBoxContextHash(smallBody), SMALL_NEXT);
});
