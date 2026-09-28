import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxExecTransport } from "./boxExecTransport.js";
import { createBoxReplayReader, createBoxReplayWriter } from "../../egress/boxReplaySetup.js";
import { compileBoxToolCatalog, rehydrateBoxToolCatalog } from "./boxToolCatalog.js";
import { observeBoxToolTerminalOnly } from "./boxToolTerminalRecovery.js";
import { makeBoxStagedCatalogRead, readBoxStagedToolCatalog } from "./boxStagedCatalogRead.js";

test("catalog read script rejects symlink, loose mode and bad utf-8", async () => {
  const nonce = randomBytes(12).toString("hex");
  const request = makeBoxStagedCatalogRead(nonce, 0);
  const syntax = spawnSync("python3", ["-c", "import ast,sys;ast.parse(sys.stdin.read())"],
    { input: request.args[2], encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const run = `/tmp/ocv5-289-run-${nonce}`;
  mkdirSync(run, { mode: 0o700 });
  const script = request.args[2]!;
  const runScript = () => spawnSync(request.command, ["-I", "-c", script, nonce, "0", "262144"],
    { encoding: "utf8" });
  try {
    writeFileSync(`${run}/tool-catalog.json`, "{\"tools\":[]}");
    chmodSync(`${run}/tool-catalog.json`, 0o600);
    const ok = runScript();
    assert.equal(ok.status, 0, ok.stderr);
    const read = await readBoxStagedToolCatalog({ runNonce: nonce,
      exec: { run: async () => ({ stdout: ok.stdout, stderrBytes: 0, exitCode: 0 as const }) } });
    assert.equal(read.json, "{\"tools\":[]}");
    chmodSync(`${run}/tool-catalog.json`, 0o644);
    assert.notEqual(runScript().status, 0);
    rmSync(`${run}/tool-catalog.json`);
    symlinkSync("/etc/passwd", `${run}/tool-catalog.json`);
    assert.notEqual(runScript().status, 0);
    rmSync(`${run}/tool-catalog.json`);
    writeFileSync(`${run}/tool-catalog.json`, Buffer.from([0xff, 0xfe]));
    chmodSync(`${run}/tool-catalog.json`, 0o600);
    const badUtf8 = runScript();
    assert.equal(badUtf8.status, 0, badUtf8.stderr);
    await assert.rejects(() => readBoxStagedToolCatalog({ runNonce: nonce,
      exec: { run: async () => ({ stdout: badUtf8.stdout, stderrBytes: 0,
        exitCode: 0 as const }) } }), /BOX_CATALOG_READ_INVALID/);
    rmSync(`${run}/tool-catalog.json`);
    writeFileSync(`${run}/tool-catalog.json`, "");
    chmodSync(`${run}/tool-catalog.json`, 0o600);
    assert.notEqual(runScript().status, 0, "empty file");
    rmSync(`${run}/tool-catalog.json`);
    writeFileSync(`${run}/tool-catalog.json`, "{\"tools\":[]}");
    chmodSync(`${run}/tool-catalog.json`, 0o600);
    linkSync(`${run}/tool-catalog.json`, `${run}/tool-catalog-link.json`);
    assert.notEqual(runScript().status, 0, "nlink");
    rmSync(`${run}/tool-catalog-link.json`);
    rmSync(`${run}/tool-catalog.json`);
    assert.equal(spawnSync("mkfifo", ["-m", "600", `${run}/tool-catalog.json`]).status, 0);
    assert.notEqual(runScript().status, 0, "fifo");
    rmSync(`${run}/tool-catalog.json`);
    writeFileSync(`${run}/tool-catalog.json`, Buffer.alloc(1_048_577, 0x61));
    chmodSync(`${run}/tool-catalog.json`, 0o600);
    assert.notEqual(runScript().status, 0, "size");
    rmSync(`${run}/tool-catalog.json`);
    writeFileSync(`${run}/tool-catalog.json`, "{\"tools\":[]}");
    chmodSync(`${run}/tool-catalog.json`, 0o600);
    chownSync(`${run}/tool-catalog.json`, 65534, 65534);
    assert.notEqual(runScript().status, 0, "owner");
    assert.throws(() => makeBoxStagedCatalogRead("not-a-nonce", 0));
    assert.throws(() => makeBoxStagedCatalogRead(nonce, -1));
  } finally { rmSync(run, { recursive: true, force: true }); }
});

function connectFrame(value: unknown, flag = 0): Buffer {
  const raw = Buffer.from(JSON.stringify(value));
  const out = Buffer.alloc(raw.length + 5);
  out[0] = flag;
  out.writeUInt32BE(raw.length, 1);
  raw.copy(out, 5);
  return out;
}

test("chunked catalog read stays inside one Connect frame and still closes", async () => {
  const description = "Example: {\"path\":\"docs/a.txt\",\"mode\":\"read\"}\n".repeat(220);
  let selected: { json: string; bindingSha256: string } | null = null;
  for (let count = 50; count <= 128; count += 1) {
    try {
      const catalog = compileBoxToolCatalog(Array.from({ length: count }, (_, index) => ({
        name: `read_doc_${index}`, description,
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      })));
      const whole = Buffer.concat([
        connectFrame({ stdoutEvent: { data: catalog.json } }),
        connectFrame({ exitEvent: {} }),
        connectFrame({}, 2),
      ]);
      if (whole.length > 1_048_576 && Buffer.byteLength(catalog.json) <= 1_048_576) {
        selected = catalog;
        assert.ok(whole.length > 1_048_576);
        break;
      }
    } catch { /* catalog over the admitted file cap is not this case */ }
  }
  if (!selected) throw new Error("a legal catalog must exceed one framed Exec response");
  const admitted = selected;
  const file = Buffer.from(admitted.json);
  let calls = 0;
  let largestFrame = 0;
  const nonce = "a".repeat(24);
  const transport = new BoxExecTransport(
    { execUrl: "https://offline.invalid/exec", execToken: "synthetic", networkToken: "synthetic" },
    async (_url, init) => {
      const body = Buffer.from(init.body as Uint8Array);
      const request = JSON.parse(body.subarray(5).toString("utf8")) as { args: string[] };
      const offset = Number(request.args[4]);
      const limit = Number(request.args[5]);
      const slice = file.subarray(offset, offset + limit);
      const stdout = JSON.stringify({ data: slice.toString("base64"), dev: "7", ino: "9",
        offset, size: file.length });
      const wire = Buffer.concat([
        connectFrame({ stdoutEvent: { data: stdout } }),
        connectFrame({ exitEvent: {} }),
        connectFrame({}, 2),
      ]);
      assert.ok(wire.length <= 1_048_576);
      largestFrame = Math.max(largestFrame, wire.length);
      calls += 1;
      return new Response(wire, { status: 200 });
    }, async () => {});
  const read = await readBoxStagedToolCatalog({ exec: transport, runNonce: nonce });
  assert.equal(read.json, admitted.json);
  assert.ok(calls >= 2);
  const restored = rehydrateBoxToolCatalog(read.json);
  assert.equal(restored.bindingSha256, admitted.bindingSha256);
  const names = [...restored.clientNameByBoxName.keys()];
  const event = (value: unknown) => ({ type: "stream_event", event: value });
  const model = "claude-opus-5-5";
  const records = [
    { type: "system", subtype: "init", tools: names, mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_final", model, role: "assistant",
      content: [], usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 1,
        cache_creation_input_tokens: 2 } } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
    { type: "assistant", message: { id: "msg_final", model, role: "assistant",
      content: [{ type: "text", text: "done" }] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 3, output_tokens: 4 } }),
    event({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 9, output_tokens: 8, cache_read_input_tokens: 1,
        cache_creation_input_tokens: 2 } },
  ];
  const raw = Buffer.from(records.map((item) => JSON.stringify(item) + "\n").join(""));
  const proof = { runNonce: nonce, leaseEpoch: "b".repeat(32), keeperPid: 101, cliPid: 102,
    reason: "worker_complete", revision: 1 };
  const root = mkdtempSync(join(tmpdir(), "ocv5-catalog-close-"));
  const writer = createBoxReplayWriter(true, join(root, "state"));
  const reader = createBoxReplayReader(join(root, "state"));
  assert.ok(writer && reader);
  let completes = 0;
  try {
    const outcome = await observeBoxToolTerminalOnly({
      evidence: { requestId: "synthetic-request", uid: 3n, accountId: 20n, runNonce: nonce,
        leaseEpoch: proof.leaseEpoch, sessionId: "session-synthetic", turnKey: "c".repeat(64),
        model: "box-api-claude-opus-5-5", upstreamModel: model, roundNo: 1, spoolOffset: 0,
        catalogHash: restored.bindingSha256, detachedRunnerHash: "d".repeat(64),
        rootRequestId: "synthetic-request", rootLaunchPermit: true, resultHashes: null },
      catalog: restored,
      target: { accountId: 20n, exec: { run: async (req: { args: string[] }) => {
        if (req.args[5] === "--read") {
          const offset = Number(req.args[7]);
          const bytes = raw.subarray(offset);
          return { stdout: JSON.stringify({ data: bytes.toString("base64"),
            offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 as const };
        }
        if (req.args[2]?.includes("terminal.json")) {
          return { stdout: JSON.stringify(proof) + "\n", stderrBytes: 0, exitCode: 0 as const };
        }
        throw new Error("catalog close must not launch");
      } } } as never }, {
      writeMessage: writer,
      journal: { complete: async () => { completes += 1; },
        completeToolChain: async () => { throw new Error("root uses complete"); },
        readRecoveryWinner: async () => null } as never });
    assert.equal(outcome.status, "committed");
    assert.equal(completes, 1);
    assert.ok(largestFrame <= 1_048_576);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
