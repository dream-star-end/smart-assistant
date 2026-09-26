import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runBoxToolFirstRound } from "./boxToolFirstRound.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { ProxyBody } from "./shared.js";

const asset = (name: string) => readFileSync(
  new URL(`../../../../../scripts/ocv5-289/${name}`, import.meta.url));
const model = "claude-opus-5-5", toolId = "toolu_synthetic_a";
const boxName = "mcp__ocbridge__t0";
const canonicalBody: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, messages: [{ role: "user", content: "synthetic tool request" }],
  tools: [{ name: "local_echo", description: "synthetic local tool",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }],
  tool_choice: { type: "auto" },
  metadata: { user_id: JSON.stringify({ session_id: "session-synthetic",
    oc_turn_key: "a".repeat(64) }) } };
const upstreamBody = { ...canonicalBody, model };
const event = (value: unknown) => ({ type: "stream_event", event: value });
const use = { type: "tool_use", id: toolId, name: boxName, input: { value: "x" } };
const records = [
  { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] },
  event({ type: "message_start", message: { id: "msg_synthetic", model,
    role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
  event({ type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id: toolId, name: boxName, input: {} } }),
  event({ type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
  { type: "assistant", message: { id: "msg_synthetic", model,
    role: "assistant", content: [use] } },
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "tool_use" },
    usage: { input_tokens: 2, output_tokens: 4 } }),
  event({ type: "message_stop" }),
];
const raw = Buffer.from(records.map((record) => JSON.stringify(record) + "\n").join(""));
const finalRecords = [records[0],
  event({ type: "message_start", message: { id: "msg_direct_final", model,
    role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
  event({ type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "direct answer" } }),
  { type: "assistant", message: { id: "msg_direct_final", model,
    role: "assistant", content: [{ type: "text", text: "direct answer" }] } },
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 2, output_tokens: 4 } }),
  event({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 2, output_tokens: 4 } },
];
const finalRaw = Buffer.from(finalRecords.map((record) => JSON.stringify(record) + "\n").join(""));

function fixture(options: { rejectAdmission?: boolean; ambiguousLaunch?: boolean;
  directFinal?: boolean; finalTrailing?: boolean;
  failAssetStage?: number; failInputStage?: number;
  stageFailureCode?: string; failCleanup?: boolean; ambiguousArm?: boolean } = {}) {
  const sequence: string[] = [];
  const unknownPhases: string[] = [];
  const emitted: string[] = [];
  let disposed = false, launches = 0, recordedOffset = -1;
  let currentNonce = "", currentEpoch = "";
  let controlHash = "";
  let retained = false, cleanupRetained = false;
  let assetIndex = -1, inputIndex = -1;
  const target = { accountId: 20n, dispose: async () => { disposed = true; },
    exec: { run: async (request: { args: string[] }) => {
      const args = request.args;
      if (args[2]?.includes("identity['identityHash']")) {
        sequence.push("prelaunch-bootstrap");
        const manifest = { accountId: args[5], controlDev: "2049",
          controlId: args[6], controlIno: "9001", leaseEpoch: args[4],
          lockDev: "2049", lockIno: "9002", runNonce: args[3], version: 2 };
        controlHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
        return { stdout: JSON.stringify({ ...manifest, identityHash: controlHash }) + "\n",
          stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[2]?.includes("def clean_dir(parent_path,name,allowed):")) {
        sequence.push("prelaunch-cleanup");
        if (options.failCleanup) throw new BoxExecTransportError("BOX_EXEC_TIMEOUT", false);
        return { stdout: `cleaned:${controlHash}\n`, stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[0] === "-I" && args[1] === "-c"
        && args[2]?.includes("sys.argv=[p,*argv]")
        && args[3]?.startsWith("/tmp/ocv5-289-v2-detached-runner-")
        && args[5] !== "--read") {
        sequence.push("launch"); launches++;
        if (options.ambiguousLaunch) throw new BoxExecTransportError("synthetic", false);
        return { stdout: "launched\n", stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[0] === "-I" && args[1] === "-c"
        && args[2]?.includes("sys.argv=[p,*argv]")
        && args[3]?.startsWith("/tmp/ocv5-289-v2-detached-runner-")
        && args[5] === "--read") {
        sequence.push("spool-read");
        const offset = Number(args[7]);
        const spool = options.directFinal
          ? options.finalTrailing ? Buffer.concat([finalRaw, Buffer.from("bad-after-success\n")])
            : finalRaw : raw;
        const bytes = spool.subarray(offset);
        return { stdout: JSON.stringify({ data: bytes.toString("base64"),
          offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("pending.")) {
        sequence.push("pending-read");
        return { stdout: JSON.stringify({ version: 1, modelToolUseId: toolId,
          mcpRequestId: 7, name: "t0", arguments: { value: "x" } }),
        stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("terminal.json")) {
        sequence.push("proof-read");
        return { stdout: JSON.stringify({ runNonce: currentNonce,
          leaseEpoch: currentEpoch, keeperPid: 101, cliPid: 102,
          reason: "worker_complete", revision: 1 }) + "\n",
        stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[0] === "-I" && args[1] === "-c"
        && args[3]?.startsWith("/tmp/ocv5-289-")
        && !args[3]?.startsWith("/tmp/ocv5-289-run-")) {
        sequence.push("asset-stage");
        assetIndex++;
        if (assetIndex === options.failAssetStage) {
          throw new BoxExecTransportError(options.stageFailureCode ?? "BOX_EXEC_TIMEOUT", false);
        }
        return { stdout: `${Array.from({ length: (args.length - 3) / 4 }, (_, i) =>
          args[5 + i * 4]).join(",")}\n`, stderrBytes: 0, exitCode: 0 as const };
      }
      sequence.push("input-stage");
      inputIndex++;
      if (inputIndex === options.failInputStage) {
        throw new BoxExecTransportError(options.stageFailureCode ?? "BOX_EXEC_TIMEOUT", false);
      }
      return { stdout: "ok\n", stderrBytes: 0, exitCode: 0 as const };
    } } };
  const journal = {
    admit: async (identity: { runNonce: string; leaseEpoch: string }) => {
      sequence.push("admit"); currentNonce = identity.runNonce;
      currentEpoch = identity.leaseEpoch;
      if (options.rejectAdmission) throw new Error("synthetic admission denied"); },
    recordPrelaunchControl: async () => { sequence.push("prelaunch-journal"); },
    armGuardedLaunch: async () => { sequence.push("launch-arm");
      if (options.ambiguousArm) throw new Error("synthetic arm acknowledgement lost"); },
    markGuardedPrestartStopped: async () => { sequence.push("guarded-prestart-stopped"); },
    markPrestartStopped: async () => { sequence.push("prestart-stopped"); },
    markUnknown: async (arg: { phase: string }) => {
      sequence.push("unknown"); unknownPhases.push(arg.phase);
    },
    recordToolHandoff: async (arg: { spoolOffset: number; catalogHash: string;
      detachedRunnerHash: string }) => {
      sequence.push("durable-handoff"); recordedOffset = arg.spoolOffset;
      assert.match(arg.catalogHash, /^[a-f0-9]{64}$/);
      assert.match(arg.detachedRunnerHash, /^[a-f0-9]{64}$/);
      return { durableRevision: "synthetic-revision", journaledToolUseIds: [toolId],
        verifiedPendingToolUseIds: [toolId] };
    },
    complete: async (evidence: { proof: { runNonce: string; leaseEpoch: string };
      usage: { outputTokens: number } }) => {
      sequence.push("terminal-journal");
      assert.equal(evidence.usage.outputTokens, 4);
      assert.equal(evidence.proof.runNonce, currentNonce);
    },
  };
  const deps = { supervisorAsset: asset("box_supervisor.py"),
    keeperAsset: asset("box_keeper.py"), virtualMcpAsset: asset("box_virtual_mcp.py"),
    detachedRunnerAsset: asset("box_detached_runner.py"),
    journal: journal as never, maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => { sequence.push("notify-unknown"); },
    retainUnknownTarget: () => { retained = true; sequence.push("retain-unknown"); },
    retainCleanupTarget: () => { cleanupRetained = true; sequence.push("retain-cleanup"); } };
  const input = { uid: 3n, sessionId: "session-synthetic", requestId: "box-synthetic",
    canonicalModel: canonicalBody.model, canonicalBody, upstreamModel: model,
    url: BOX_INTERNAL_ENDPOINT, init: { method: "POST", body: JSON.stringify(upstreamBody) },
    emit: (sse: string) => { sequence.push("emit"); emitted.push(sse); } };
  return { input, deps, target, sequence, unknownPhases, emitted,
    get disposed() { return disposed; }, get launches() { return launches; },
    get recordedOffset() { return recordedOffset; },
    get retained() { return retained; },
    get cleanupRetained() { return cleanupRetained; } };
}

test("first tool round admits before one launch and emits terminal only after durable handoff", async () => {
  const f = fixture();
  const handoff = await runBoxToolFirstRound(f.input, f.deps);
  if (handoff.kind !== "tool_handoff") throw new Error("expected tool handoff");
  assert.equal(handoff.target, f.target);
  assert.equal(handoff.spoolOffset, raw.length);
  assert.equal(f.recordedOffset, raw.length);
  assert.equal(f.launches, 1);
  assert.equal(f.disposed, false, "detached target remains owned until terminal proof");
  assert.ok(f.sequence.indexOf("admit") < f.sequence.indexOf("launch"));
  assert.ok(f.sequence.indexOf("prelaunch-journal") < f.sequence.indexOf("input-stage"));
  assert.ok(f.sequence.indexOf("launch-arm") < f.sequence.indexOf("launch"));
  assert.ok(f.sequence.indexOf("durable-handoff") < f.sequence.lastIndexOf("emit"));
  assert.ok(f.emitted.join("").includes('"name":"local_echo"'));
  assert.ok(f.emitted.at(-1)?.includes("event: message_stop"));
});

test("one batched asset Exec still precedes durable arm and the sole paid launch", async () => {
  const previous = process.env.OC_BOX_ASSET_BATCH;
  process.env.OC_BOX_ASSET_BATCH = "1";
  try {
    const f = fixture();
    const result = await runBoxToolFirstRound(f.input, f.deps);
    assert.equal(result.kind, "tool_handoff");
    assert.equal(f.sequence.filter((step) => step === "asset-stage").length, 1);
    assert.ok(f.sequence.indexOf("asset-stage") < f.sequence.indexOf("launch-arm"));
    assert.equal(f.launches, 1);
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_ASSET_BATCH;
    else process.env.OC_BOX_ASSET_BATCH = previous;
  }
});

test("tool_choice auto may answer directly with one paid launch and proven final usage", async () => {
  const f = fixture({ directFinal: true });
  const result = await runBoxToolFirstRound(f.input, f.deps);
  assert.equal(result.kind, "final");
  assert.equal(f.launches, 1);
  assert.ok(f.sequence.indexOf("proof-read") < f.sequence.indexOf("terminal-journal"));
  assert.ok(f.sequence.indexOf("terminal-journal") < f.sequence.lastIndexOf("emit"));
  assert.ok(f.emitted.join("").includes("direct answer"));
  assert.ok(f.emitted.at(-1)?.includes("event: message_stop"));
  assert.equal(f.retained, false);
});

test("direct final cannot bill or emit terminal when success has trailing bytes", async () => {
  const f = fixture({ directFinal: true, finalTrailing: true });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    /BOX_TOOL_FINAL_TRAILING_BYTES/);
  assert.equal(f.launches, 1);
  assert.ok(!f.sequence.includes("terminal-journal"));
  assert.ok(!f.emitted.join("").includes("event: message_stop"));
  assert.equal(f.retained, true);
});

test("denied admission never stages or launches paid CLI and closes prestart target", async () => {
  const f = fixture({ rejectAdmission: true });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    /synthetic admission denied/);
  assert.equal(f.launches, 0);
  assert.equal(f.disposed, true);
  assert.deepEqual(f.sequence, ["admit"]);
});

test("asset-only stage timeout closes paid capacity without private data or launch", async () => {
  const f = fixture({ failAssetStage: 0 });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    (error: unknown) => error instanceof BoxExecTransportError
      && error.code === "BOX_EXEC_TIMEOUT");
  assert.deepEqual(f.unknownPhases, []);
  assert.equal(f.launches, 0);
  assert.equal(f.sequence.includes("prestart-stopped"), true);
  assert.equal(f.retained, false);
  assert.equal(f.disposed, true);
});

test("injected private-stage abort is fenced and cleaned before capacity release", async () => {
  const f = fixture({ failInputStage: 0, stageFailureCode: "BOX_EXEC_ABORTED" });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    (error: unknown) => error instanceof BoxExecTransportError
      && error.code === "BOX_EXEC_ABORTED");
  assert.deepEqual(f.unknownPhases, []);
  assert.ok(f.sequence.indexOf("prelaunch-cleanup") <
    f.sequence.indexOf("guarded-prestart-stopped"));
  assert.equal(f.launches, 0);
  assert.equal(f.retained, false);
});

test("private-stage ambiguity remains unknown if remote cleanup cannot be proven", async () => {
  const f = fixture({ failInputStage: 0, failCleanup: true });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps), BoxExecTransportError);
  assert.equal(f.launches, 0);
  assert.equal(f.sequence.includes("guarded-prestart-stopped"), false);
  assert.equal(f.retained, true);
  assert.equal(f.unknownPhases.length, 1);
});

test("arm acknowledgement loss never dispatches prelaunch cleanup or paid CLI", async () => {
  const f = fixture({ ambiguousArm: true });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    /synthetic arm acknowledgement lost/);
  assert.equal(f.launches, 0);
  assert.equal(f.sequence.includes("prelaunch-cleanup"), false);
  assert.equal(f.sequence.includes("guarded-prestart-stopped"), false);
  assert.equal(f.retained, true);
  assert.deepEqual(f.unknownPhases, ["launch_arm_unknown"]);
});

test("ambiguous launch is not retried and leaves durable capacity unknown", async () => {
  const f = fixture({ ambiguousLaunch: true });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    BoxExecTransportError);
  assert.equal(f.launches, 1);
  assert.ok(f.sequence.includes("unknown"));
  assert.equal(f.disposed, false);
  assert.equal(f.retained, true);
  assert.equal(f.emitted.length, 0);
});

test("late resolver after caller cancellation closes only the unused target", async () => {
  const f = fixture();
  const abort = new AbortController();
  let deliver!: (target: typeof f.target) => void;
  f.deps.resolveTarget = (() => new Promise((resolve) => { deliver = resolve; })) as never;
  const task = runBoxToolFirstRound({ ...f.input,
    init: { ...f.input.init, signal: abort.signal } }, f.deps);
  abort.abort();
  deliver(f.target); // same event-loop turn as cancellation
  await assert.rejects(() => task, /BOX_TOOL_ABORTED/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.disposed, true);
  assert.equal(f.launches, 0);
});

test("synchronous late dispose failure is observed and retained for retry", async () => {
  const f = fixture();
  const abort = new AbortController();
  let deliver!: (target: typeof f.target) => void;
  f.deps.resolveTarget = (() => new Promise((resolve) => { deliver = resolve; })) as never;
  f.target.dispose = (() => { throw new Error("synthetic dispose failure"); }) as never;
  const task = runBoxToolFirstRound({ ...f.input,
    init: { ...f.input.init, signal: abort.signal } }, f.deps);
  abort.abort(); deliver(f.target);
  await assert.rejects(() => task, /BOX_TOOL_ABORTED/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.cleanupRetained, true);
  assert.equal(f.launches, 0);
});

test("never-settling prestart target close is bounded and retained", async () => {
  const f = fixture({ rejectAdmission: true });
  f.target.dispose = (() => new Promise<void>(() => {})) as never;
  const began = Date.now();
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    /synthetic admission denied/);
  assert.ok(Date.now() - began < 800);
  assert.equal(f.cleanupRetained, true);
  assert.equal(f.launches, 0);
});

test("late admission commit after cancellation is prestart-closed without launch", async () => {
  const f = fixture();
  const abort = new AbortController();
  let commit!: () => void;
  (f.deps.journal as unknown as { admit: () => Promise<void> }).admit =
    () => new Promise<void>((resolve) => { commit = resolve; });
  const task = runBoxToolFirstRound({ ...f.input,
    init: { ...f.input.init, signal: abort.signal } }, f.deps);
  await new Promise((resolve) => setTimeout(resolve, 0));
  abort.abort();
  await assert.rejects(() => task, /BOX_TOOL_ABORTED/);
  commit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.disposed, true);
  assert.equal(f.launches, 0);
  assert.ok(f.sequence.includes("prestart-stopped"));
});

test("proven prestart asset failure releases only local resources", async () => {
  const f = fixture();
  f.target.exec.run = async () => ({ stdout: "wrong-hash\n", stderrBytes: 0,
    exitCode: 0 as const });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    /BOX_TOOL_ASSET_STAGE_INVALID/);
  assert.equal(f.launches, 0);
  assert.equal(f.disposed, true);
  assert.ok(f.sequence.indexOf("admit") < f.sequence.indexOf("prestart-stopped"));
});

test("stalled prestart journal cleanup is bounded and retains target ownership", async () => {
  const f = fixture();
  f.target.exec.run = async () => ({ stdout: "wrong-hash\n", stderrBytes: 0,
    exitCode: 0 as const });
  (f.deps.journal as unknown as { markPrestartStopped: () => Promise<void> })
    .markPrestartStopped = () => new Promise<void>(() => {});
  const began = Date.now();
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    /BOX_TOOL_ASSET_STAGE_INVALID/);
  assert.ok(Date.now() - began < 3000);
  assert.equal(f.retained, true);
  assert.equal(f.disposed, false);
  assert.equal(f.launches, 0);
});

test("downstream SSE failure after paid launch retains unknown without replay", async () => {
  const f = fixture();
  await assert.rejects(() => runBoxToolFirstRound({ ...f.input,
    emit: () => { throw new Error("synthetic SSE disconnect"); } }, f.deps),
  /synthetic SSE disconnect/);
  assert.equal(f.launches, 1);
  assert.ok(f.sequence.includes("unknown"));
  assert.equal(f.disposed, false);
  assert.equal(f.retained, true);
});
