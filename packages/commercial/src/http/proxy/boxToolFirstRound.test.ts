import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runBoxToolFirstRound } from "./boxToolFirstRound.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import { makeBoxNativeHistoryBasis } from "./boxNativeHistory.js";
import { parseBoxNativePointer, type BoxNativePointer } from "./boxNativePointer.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import type { ProxyBody } from "./shared.js";
import type { BoxReplayMessageWriter,
  BoxReplayMessagePointer } from "./boxReplayMessageFile.js";

const inheritedInstance = process.env.OC_INSTANCE_ID;
process.env.OC_INSTANCE_ID = "box-test";
test.after(() => {
  if (inheritedInstance === undefined) delete process.env.OC_INSTANCE_ID;
  else process.env.OC_INSTANCE_ID = inheritedInstance;
});

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
  stageFailureCode?: string; failCleanup?: boolean; ambiguousArm?: boolean;
  badAssetManifest?: boolean;
  nativeCandidate?: { ownerRequestId: string; pointer: BoxNativePointer };
  spoolPrefix?: Buffer;
  spoolBody?: Buffer;
  compactUsingLaunchSession?: boolean;
  /** Claude Code build the resolver read on this Box; null = not read. */
  cliVersion?: string | null } = {}) {
  let launchedSession = "";
  const sequence: string[] = [];
  const unknownPhases: string[] = [];
  const emitted: string[] = [];
  let disposed = false, launches = 0, recordedOffset = -1;
  let currentNonce = "", currentEpoch = "";
  let controlHash = "";
  let retained = false, cleanupRetained = false;
  let admittedNative: unknown = null;
  const nativeLookups: string[] = [];
  let admittedStart: unknown = null;
  let assetIndex = -1, inputIndex = -1;
  const target = { accountId: 20n, dispose: async () => { disposed = true; },
    ...(options.cliVersion === null ? {} : { cliVersion: options.cliVersion ?? "2.1.280" }),
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
        const sessionFlag = args.indexOf("--session-id");
        if (sessionFlag >= 0 && typeof args[sessionFlag + 1] === "string") {
          launchedSession = args[sessionFlag + 1]!;
        }
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
        const body = options.spoolBody ?? (options.directFinal
          ? options.finalTrailing ? Buffer.concat([finalRaw, Buffer.from("bad-after-success\n")])
            : finalRaw : raw);
        const prefix = options.compactUsingLaunchSession
          ? compactPrefix(launchedSession) : options.spoolPrefix;
        const spool = prefix ? Buffer.concat([prefix, body]) : body;
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
      if (args[2]?.includes("print(json.dumps({'sha256':actual")) {
        sequence.push("native-inspect");
        return { stdout: JSON.stringify({ sha256: "f".repeat(64), size: 100 }) + "\n",
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
        const manifest = Array.from({ length: (args.length - 3) / 4 }, (_, i) =>
          args[5 + i * 4]).join(",");
        return { stdout: `${options.badAssetManifest && args.length > 7 ? "bad" : manifest}\n`,
          stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[2]?.includes("print('staged:'+str(len(steps)))")) {
        sequence.push("input-batch");
        const steps = JSON.parse(Buffer.from(args[3]!, "base64").toString("utf8")) as unknown[];
        if (options.failInputStage === 0) {
          throw new BoxExecTransportError(options.stageFailureCode ?? "BOX_EXEC_TIMEOUT", false);
        }
        return { stdout: `staged:${steps.length}\n`, stderrBytes: 0, exitCode: 0 as const };
      }
      sequence.push("input-stage");
      inputIndex++;
      if (inputIndex === options.failInputStage) {
        throw new BoxExecTransportError(options.stageFailureCode ?? "BOX_EXEC_TIMEOUT", false);
      }
      return { stdout: "ok\n", stderrBytes: 0, exitCode: 0 as const };
    } } };
  const journal = {
    findNativeCandidate: async (args: { sessionId: string }) => {
      sequence.push("native-lookup"); nativeLookups.push(args.sessionId);
      return options.nativeCandidate ?? null;
    },
    admit: async (identity: { runNonce: string; leaseEpoch: string;
      nativeClaim?: unknown; nativeStart?: unknown }) => {
      sequence.push("admit"); currentNonce = identity.runNonce;
      currentEpoch = identity.leaseEpoch;
      admittedNative = identity.nativeClaim ?? null;
      admittedStart = identity.nativeStart ?? null;
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
    attachNativePointer: async () => { sequence.push("native-attach"); return true; },
  };
  const deps = { supervisorAsset: asset("box_supervisor.py"),
    keeperAsset: asset("box_keeper.py"), virtualMcpAsset: asset("box_virtual_mcp.py"),
    detachedRunnerAsset: asset("box_detached_runner.py"),
    journal: journal as never, maxOutputTokensForModel: () => 128_000,
    resolveTarget: async () => target as never,
    onUnknown: async () => { sequence.push("notify-unknown"); },
    retainUnknownTarget: () => { retained = true; sequence.push("retain-unknown"); },
    retainCleanupTarget: () => { cleanupRetained = true; sequence.push("retain-cleanup"); } };
  const input = { uid: 3n, sessionId: "openclaude-peer-session", requestId: "box-synthetic",
    canonicalModel: canonicalBody.model, canonicalBody, upstreamModel: model,
    url: BOX_INTERNAL_ENDPOINT, init: { method: "POST", body: JSON.stringify(upstreamBody) },
    emit: (sse: string) => { sequence.push("emit"); emitted.push(sse); } };
  return { input, deps, target, sequence, unknownPhases, emitted,
    get disposed() { return disposed; }, get launches() { return launches; },
    get recordedOffset() { return recordedOffset; },
    get retained() { return retained; },
    get admittedNative() { return admittedNative; }, nativeLookups,
    get admittedStart() { return admittedStart; },
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

test("first tool or final Message is retained before its exact journal CAS", async () => {
  for (const directFinal of [false, true]) {
    const f = fixture({ directFinal });
    const journal = f.deps.journal as unknown as {
      admit: (input: { replayRequired?: boolean }) => Promise<void>;
      recordToolHandoff: (input: { messagePointer?: BoxReplayMessagePointer }) => Promise<unknown>;
      complete: (input: { messagePointer?: BoxReplayMessagePointer }) => Promise<void>;
    };
    const originalAdmit = journal.admit.bind(journal);
    journal.admit = async (input) => {
      assert.equal(input.replayRequired, true);
      return originalAdmit(input);
    };
    const originalHandoff = journal.recordToolHandoff.bind(journal);
    const originalFinal = journal.complete.bind(journal);
    journal.recordToolHandoff = async (input) => {
      assert.equal(input.messagePointer?.requestId, f.input.requestId);
      assert.equal(input.messagePointer?.roundNo, 1);
      return originalHandoff(input);
    };
    journal.complete = async (input) => {
      assert.equal(input.messagePointer?.requestId, f.input.requestId);
      assert.equal(input.messagePointer?.roundNo, 1);
      return originalFinal(input);
    };
    const writeMessage: BoxReplayMessageWriter = async (identity, message) => {
      f.sequence.push("capsule-write");
      assert.equal((message as { id: string }).id,
        directFinal ? "msg_direct_final" : "msg_synthetic");
      return { version: 1, ...identity, bytes: 100, sha256: "a".repeat(64) };
    };
    await runBoxToolFirstRound(f.input, { ...f.deps, writeMessage });
    const journalEvent = directFinal ? "terminal-journal" : "durable-handoff";
    assert.ok(f.sequence.indexOf("capsule-write") < f.sequence.indexOf(journalEvent));
    assert.ok(f.sequence.indexOf(journalEvent) < f.sequence.lastIndexOf("emit"));
  }
});

test("one batched asset Exec still precedes durable arm and the sole paid launch", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const f = fixture();
    const result = await runBoxToolFirstRound(f.input, f.deps);
    assert.equal(result.kind, "tool_handoff");
    assert.equal(f.sequence.filter((step) => step === "asset-stage").length, 1);
    assert.ok(f.sequence.indexOf("asset-stage") < f.sequence.indexOf("launch-arm"));
    assert.equal(f.launches, 1);
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
});

test("batch manifest mismatch cannot arm or start a paid model", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const f = fixture({ badAssetManifest: true });
    await assert.rejects(runBoxToolFirstRound(f.input, f.deps),
      /BOX_TOOL_ASSET_STAGE_INVALID/);
    assert.equal(f.launches, 0);
    assert.ok(!f.sequence.includes("launch-arm"));
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
});

test("one guarded private-stage Exec still precedes durable arm and sole launch", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const f = fixture();
    const result = await runBoxToolFirstRound(f.input, f.deps);
    assert.equal(result.kind, "tool_handoff");
    assert.equal(f.sequence.filter((step) => step === "input-batch").length, 1);
    assert.equal(f.sequence.filter((step) => step === "input-stage").length, 0);
    assert.ok(f.sequence.indexOf("prelaunch-journal") < f.sequence.indexOf("input-batch"));
    assert.ok(f.sequence.indexOf("input-batch") < f.sequence.indexOf("launch-arm"));
    assert.equal(f.launches, 1);
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
});

test("ambiguous guarded batch never arms or launches a paid model", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const f = fixture({ failInputStage: 0 });
    await assert.rejects(runBoxToolFirstRound(f.input, f.deps));
    assert.equal(f.launches, 0);
    assert.ok(!f.sequence.includes("launch-arm"));
    assert.ok(f.sequence.includes("prelaunch-cleanup"));
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
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

test("selfhost default runs native and both batches in one paid first round", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  const instance = process.env.OC_INSTANCE_ID;
  process.env.OC_INSTANCE_ID = "v5-selfhost-sg";
  delete process.env.OC_BOX_FAST_NATIVE;
  try {
    const f = fixture({ directFinal: true });
    const result = await runBoxToolFirstRound(f.input, f.deps);
    assert.equal(result.kind, "final");
    if (result.kind !== "final") return;
    assert.equal(result.nativePointer?.accountId, "20");
    assert.equal(result.nativePointer?.transcriptSha256, "f".repeat(64));
    assert.ok(!result.plan.run.args.includes("--no-session-persistence"));
    assert.equal(f.launches, 1);
    assert.equal(f.sequence.filter((step) => step === "asset-stage").length, 1);
    assert.equal(f.sequence.filter((step) => step === "input-batch").length, 1);
    assert.equal(f.sequence.filter((step) => step === "input-stage").length, 0);
    assert.deepEqual(f.admittedStart, { sessionId: result.plan.sessionId,
      cliCwd: result.plan.cliCwd, cliVersion: "2.1.280" });
    assert.ok(f.sequence.indexOf("terminal-journal") < f.sequence.indexOf("native-inspect"));
    assert.ok(f.sequence.indexOf("native-inspect") < f.sequence.indexOf("native-attach"));
    assert.ok(f.sequence.indexOf("native-attach") < f.sequence.lastIndexOf("emit"));
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
    if (instance === undefined) delete process.env.OC_INSTANCE_ID;
    else process.env.OC_INSTANCE_ID = instance;
  }
});

test("one emergency off switch restores serial staging and no native persistence", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  const instance = process.env.OC_INSTANCE_ID;
  process.env.OC_INSTANCE_ID = "v5-selfhost-sg";
  process.env.OC_BOX_FAST_NATIVE = "0";
  try {
    const f = fixture({ directFinal: true });
    const result = await runBoxToolFirstRound(f.input, f.deps);
    assert.equal(result.kind, "final");
    if (result.kind !== "final") return;
    assert.equal(result.nativePointer, undefined);
    assert.ok(result.plan.run.args.includes("--no-session-persistence"));
    assert.equal(f.sequence.filter((step) => step === "asset-stage").length, 4);
    assert.equal(f.sequence.filter((step) => step === "input-batch").length, 0);
    assert.equal(f.sequence.filter((step) => step === "input-stage").length, 7);
    assert.equal(f.launches, 1);
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
    if (instance === undefined) delete process.env.OC_INSTANCE_ID;
    else process.env.OC_INSTANCE_ID = instance;
  }
});

test("warm native hit preflights one UUID and atomically claims before one paid launch", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const priorBody = { ...canonicalBody,
      messages: [{ role: "user", content: "prior question" }] } as ProxyBody;
    const basis = makeBoxNativeHistoryBasis(priorBody,
      [{ type: "text", text: "READY" }]);
    const pointer = parseBoxNativePointer({ version: 1, accountId: "20",
      upstreamModel: model, cliVersion: "2.1.280",
      nativeSessionId: "12345678-1234-4123-8123-123456789abc",
      cliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
      transcriptSha256: "f".repeat(64), ...basis,
      catalogHash: compileBoxToolCatalog(canonicalBody.tools).bindingSha256,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000 });
    assert.ok(pointer);
    const f = fixture({ directFinal: true,
      nativeCandidate: { ownerRequestId: "native-owner", pointer } });
    const next = { ...canonicalBody, messages: [
      { role: "user", content: "prior question" },
      { role: "assistant", content: [{ type: "text", text: "READY" }] },
      { role: "user", content: "new question" },
    ] } as ProxyBody;
    const input = { ...f.input, canonicalBody: next,
      init: { ...f.input.init, body: JSON.stringify({ ...next, model }) } };
    const result = await runBoxToolFirstRound(input, f.deps);
    assert.equal(result.kind, "final");
    if (result.kind !== "final") return;
    assert.equal(result.plan.sessionId, pointer.nativeSessionId);
    assert.equal(result.plan.cliCwd, pointer.cliCwd);
    assert.equal(result.plan.snapshotHash, null);
    assert.equal((f.admittedNative as { ownerRequestId: string }).ownerRequestId,
      "native-owner");
    assert.equal(f.admittedStart, null);
    assert.deepEqual(f.nativeLookups, ["session-synthetic"],
      "the candidate is looked up by the CLI session of the request metadata (the journal key), not the OpenClaude peer id");
    assert.equal(f.sequence.filter((step) => step === "native-inspect").length, 2);
    assert.ok(f.sequence.indexOf("native-inspect") < f.sequence.indexOf("admit"));
    assert.equal(f.launches, 1);
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
});

test("OCV5-300 natural mode still resumes a pointer written on the opaque release", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const priorBody = { ...canonicalBody,
      messages: [{ role: "user", content: "prior question" }] } as ProxyBody;
    const basis = makeBoxNativeHistoryBasis(priorBody, [{ type: "text", text: "READY" }]);
    const opaqueHash = compileBoxToolCatalog(canonicalBody.tools).bindingSha256;
    assert.notEqual(opaqueHash,
      compileBoxToolCatalog(canonicalBody.tools, "natural").bindingSha256);
    const pointer = parseBoxNativePointer({ version: 1, accountId: "20",
      upstreamModel: model, cliVersion: "2.1.280",
      nativeSessionId: "12345678-1234-4123-8123-123456789abc",
      cliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
      transcriptSha256: "f".repeat(64), ...basis, catalogHash: opaqueHash,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000 });
    assert.ok(pointer);
    const f = fixture({ directFinal: true,
      nativeCandidate: { ownerRequestId: "native-owner", pointer } });
    const next = { ...canonicalBody, messages: [
      { role: "user", content: "prior question" },
      { role: "assistant", content: [{ type: "text", text: "READY" }] },
      { role: "user", content: "new question" },
    ] } as ProxyBody;
    const input = { ...f.input, canonicalBody: next,
      init: { ...f.input.init, body: JSON.stringify({ ...next, model }) } };
    const result = await runBoxToolFirstRound(input, { ...f.deps, toolAliasMode: "natural" });
    assert.equal(result.kind, "final");
    if (result.kind !== "final") return;
    assert.equal(result.plan.sessionId, pointer.nativeSessionId, "native resume kept");
    assert.equal(result.plan.catalog.bindingSha256, opaqueHash, "same catalog variant");
    assert.equal((f.admittedNative as { ownerRequestId: string }).ownerRequestId, "native-owner");
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
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

function compactPrefix(sessionId: string): Buffer {
  const anchor = "991406f8-0097-4e91-a2f1-b732812e36fe";
  const boundary = { type: "system", subtype: "compact_boundary",
    uuid: "adc44006-42e8-4ee0-92c6-6e9fc1412da8", session_id: sessionId,
    compact_metadata: { trigger: "auto", pre_tokens: 1, post_tokens: 1,
      cumulative_dropped_tokens: 1, duration_ms: 1,
      preserved_segment: { head_uuid: anchor, anchor_uuid: anchor, tail_uuid: anchor },
      preserved_messages: { anchor_uuid: anchor, uuids: [anchor], all_uuids: [anchor] } } };
  const summary = { type: "user", isSynthetic: true, parent_tool_use_id: null,
    session_id: sessionId, uuid: anchor, timestamp: "2026-09-29T13:35:53.708Z",
    message: { role: "user", content: [{ type: "text", text: "persisted native summary" }] } };
  return Buffer.from(`${JSON.stringify(boundary)}\n${JSON.stringify(summary)}\n`);
}

test("non-native first round does not trust a planned session id for compact", async () => {
  const f = fixture({ directFinal: true, spoolPrefix: compactPrefix("12345678-1234-4123-8123-123456789abc") });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "BOX_CLI_COMPACT_UNBOUND");
  assert.equal(f.launches, 1);
});

test("persisted native resume accepts that session compact and still finishes", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const priorBody = { ...canonicalBody,
      messages: [{ role: "user", content: "prior question" }] } as ProxyBody;
    const basis = makeBoxNativeHistoryBasis(priorBody,
      [{ type: "text", text: "READY" }]);
    const sessionId = "12345678-1234-4123-8123-123456789abc";
    const pointer = parseBoxNativePointer({ version: 1, accountId: "20",
      upstreamModel: model, cliVersion: "2.1.280", nativeSessionId: sessionId,
      cliCwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`,
      transcriptSha256: "f".repeat(64), ...basis,
      catalogHash: compileBoxToolCatalog(canonicalBody.tools).bindingSha256,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000 });
    assert.ok(pointer);
    const f = fixture({ directFinal: true, spoolPrefix: compactPrefix(sessionId),
      nativeCandidate: { ownerRequestId: "native-owner", pointer } });
    const next = { ...canonicalBody, messages: [
      { role: "user", content: "prior question" },
      { role: "assistant", content: [{ type: "text", text: "READY" }] },
      { role: "user", content: "new question" },
    ] } as ProxyBody;
    const input = { ...f.input, canonicalBody: next,
      init: { ...f.input.init, body: JSON.stringify({ ...next, model }) } };
    const result = await runBoxToolFirstRound(input, f.deps);
    assert.equal(result.kind, "final");
    assert.equal(f.launches, 1);
    if (result.kind === "final") assert.equal(result.plan.sessionId, sessionId);
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
});

test("new native start binds the admitted session id", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const f = fixture({ directFinal: true, compactUsingLaunchSession: true });
    const result = await runBoxToolFirstRound(f.input, f.deps);
    assert.equal(result.kind, "final");
    assert.equal(f.launches, 1);
    if (result.kind === "final") {
      assert.equal((f.admittedStart as { sessionId: string }).sessionId, result.plan.sessionId);
    }
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
});

test("first round rejects a catalog-matching heartbeat", async () => {
  const prefix = Buffer.from(JSON.stringify({ type: "tool_progress",
    tool_use_id: `${toolId}-heartbeat-0`, tool_name: boxName,
    parent_tool_use_id: toolId, elapsed_time_seconds: 30, heartbeat: true,
    session_id: "12345678-1234-4123-8123-123456789abc",
    uuid: "22222222-2222-4222-8222-222222222222" }) + "\n");
  const f = fixture({ spoolPrefix: prefix });
  await assert.rejects(() => runBoxToolFirstRound(f.input, f.deps), /BOX_TOOL_RECORD_INVALID/);
  assert.equal(f.launches, 1);
  assert.ok(!f.sequence.includes("durable-handoff"));
  assert.ok(f.sequence.includes("unknown"));
});

// OCV5-299: a tool call the decoder must reject outright. Since OCV5-301 a
// well-formed but unexposed name (e.g. bare `Bash`) is answered by the CLI
// itself and retried in the same turn; a malformed name still takes this
// fail-closed stop path.
const unknownNameRecords = records.map((record) => {
  const text = JSON.stringify(record).replaceAll(`"name":"${boxName}"`, '"name":"Bash tool"');
  return JSON.parse(text) as unknown;
});
unknownNameRecords[0] = records[0];
const unknownNameRaw = Buffer.from(unknownNameRecords.map((record) => JSON.stringify(record) + "\n").join(""));

test("OCV5-301 a call the CLI rejects itself is retried in the same turn and handed off", async () => {
  const rejected = records.slice(1).map((record) => JSON.parse(JSON.stringify(record)
    .replaceAll(`"name":"${boxName}"`, '"name":"Bash"').replaceAll(toolId, "toolu_cli_rejected")
    .replaceAll("msg_synthetic", "msg_rejected")) as unknown);
  const cliError = { type: "user", message: { role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_cli_rejected", is_error: true,
    content: "<tool_use_error>Error: No such tool available: Bash</tool_use_error>" }] } };
  const spoolBody = Buffer.from([records[0], ...rejected, cliError, ...records.slice(1)]
    .map((record) => JSON.stringify(record) + "\n").join(""));
  const f = fixture({ spoolBody });
  let stops = 0;
  const handoff = await runBoxToolFirstRound(f.input, { ...f.deps,
    stopRejectedRun: async () => { stops++; return "stopped_proven" as const; } });
  assert.equal(handoff.kind, "tool_handoff");
  assert.equal(stops, 0, "the run is not stopped");
  assert.deepEqual(f.unknownPhases, []);
  const emitted = f.emitted.join("");
  assert.equal(emitted.match(/event: message_start/g)?.length, 1, "one client message");
  assert.ok(!emitted.includes("toolu_cli_rejected"), "the rejected call is never shown");
  assert.ok(emitted.includes('"name":"local_echo"'));
  assert.ok(f.emitted.at(-1)?.includes("event: message_stop"));
});

test("a locally rejected tool name is stopped and settled, not left unknown", async () => {
  const f = fixture({ spoolBody: unknownNameRaw });
  const stops: unknown[] = [];
  const deps = { ...f.deps, stopRejectedRun: async (identity: unknown) => {
    stops.push(identity); f.sequence.push("explicit-stop"); return "stopped_proven" as const; } };
  await assert.rejects(() => runBoxToolFirstRound(f.input, deps),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === "BOX_TOOL_NAME_UNAVAILABLE");
  assert.equal(f.launches, 1);
  assert.equal(stops.length, 1);
  const identity = stops[0] as { requestId: string; uid: bigint; accountId: bigint;
    runNonce: string; leaseEpoch: string };
  assert.equal(identity.requestId, "box-synthetic");
  assert.equal(identity.uid, 3n);
  assert.equal(identity.accountId, 20n);
  assert.match(identity.runNonce, /^[a-f0-9]{24}$/);
  assert.match(identity.leaseEpoch, /^[a-f0-9]{32}$/);
  assert.ok(!f.sequence.includes("unknown"), "no unknown row pins the session");
  assert.ok(!f.sequence.includes("durable-handoff"), "nothing is handed to the client");
  assert.equal(f.retained, false);
  assert.equal(f.disposed, true, "the local target is released after the proven stop");
});

test("an unproven stop of a rejected stream stays on the fail-closed unknown path", async () => {
  for (const outcome of ["pending", "completed_unsettled"] as const) {
    const f = fixture({ spoolBody: unknownNameRaw });
    const deps = { ...f.deps, stopRejectedRun: async () => outcome };
    await assert.rejects(() => runBoxToolFirstRound(f.input, deps), /BOX_TOOL_ID_OR_NAME_INVALID/);
    assert.deepEqual(f.unknownPhases, ["first_round_unknown"]);
    assert.equal(f.retained, true);
  }
  const f = fixture({ spoolBody: unknownNameRaw });
  const deps = { ...f.deps, stopRejectedRun: async () => { throw new Error("stop transport down"); } };
  await assert.rejects(() => runBoxToolFirstRound(f.input, deps), /BOX_TOOL_ID_OR_NAME_INVALID/);
  assert.deepEqual(f.unknownPhases, ["first_round_unknown"]);
});

test("OCV5-300 a self-completed rejected stream is settled from its keeper proof", async () => {
  const f = fixture({ spoolBody: unknownNameRaw });
  const settled: unknown[] = [];
  const proof = { reason: "worker_complete" };
  const deps = { ...f.deps, stopRejectedRun: async () => "completed_unsettled" as const,
    readTerminalProof: (async (args: { runNonce: string; leaseEpoch: string }) => {
      f.sequence.push("read-proof"); return { ...proof, runNonce: args.runNonce,
        leaseEpoch: args.leaseEpoch }; }) as never,
    journal: { ...(f.deps.journal as object), markFirstRoundRejectedStream: async (input: unknown) => {
      settled.push(input); } } as never };
  await assert.rejects(() => runBoxToolFirstRound(f.input, deps),
    (error: unknown) => (error as { code?: string }).code === "BOX_TOOL_NAME_UNAVAILABLE");
  assert.equal(settled.length, 1);
  const row = settled[0] as { requestId: string; uid: bigint; leaseEpoch: string;
    proof: { reason: string; runNonce: string } };
  assert.equal(row.requestId, "box-synthetic");
  assert.equal(row.uid, 3n);
  assert.equal(row.proof.reason, "worker_complete");
  assert.match(row.proof.runNonce, /^[a-f0-9]{24}$/);
  assert.deepEqual(f.unknownPhases, [], "no unknown row pins the session");
  assert.equal(f.retained, false);
  // an unreadable proof or a refused settle keeps the fail-closed unknown path
  for (const broken of ["proof", "settle"] as const) {
    const g = fixture({ spoolBody: unknownNameRaw });
    const d = { ...g.deps, stopRejectedRun: async () => "completed_unsettled" as const,
      readTerminalProof: (async () => { if (broken === "proof") throw new Error("no proof");
        return proof; }) as never,
      journal: { ...(g.deps.journal as object), markFirstRoundRejectedStream: async () => {
        throw new Error("BOX_REJECTED_STREAM_FENCE_LOST"); } } as never };
    await assert.rejects(() => runBoxToolFirstRound(g.input, d), /BOX_TOOL_ID_OR_NAME_INVALID/);
    assert.deepEqual(g.unknownPhases, ["first_round_unknown"]);
  }
});

test("other decoder failures never trigger the explicit stop", async () => {
  const prefix = Buffer.from(JSON.stringify({ type: "tool_progress",
    tool_use_id: `${toolId}-heartbeat-0`, tool_name: boxName,
    parent_tool_use_id: toolId, elapsed_time_seconds: 30, heartbeat: true,
    session_id: "12345678-1234-4123-8123-123456789abc",
    uuid: "22222222-2222-4222-8222-222222222222" }) + "\n");
  const f = fixture({ spoolPrefix: prefix });
  let stops = 0;
  const deps = { ...f.deps, stopRejectedRun: async () => { stops++; return "stopped_proven" as const; } };
  await assert.rejects(() => runBoxToolFirstRound(f.input, deps), /BOX_TOOL_RECORD_INVALID/);
  assert.equal(stops, 0);
  assert.ok(f.sequence.includes("unknown"));
});

// OCV5-313: a Box whose CLI build has no verified native resume (an unlisted or
// unread version) neither records nor claims a pointer. 2.1.288 is verified
// (offline probe + cache-stable request prefix) since the long-context quota work.
test("OCV5-313 a Box without verified native resume never looks up, claims or records a native pointer", async () => {
  const previous = process.env.OC_BOX_FAST_NATIVE;
  process.env.OC_BOX_FAST_NATIVE = "1";
  try {
    const pointer = parseBoxNativePointer({ version: 1, accountId: "20",
      upstreamModel: model, cliVersion: "2.1.280",
      nativeSessionId: "12345678-1234-4123-8123-123456789abc",
      cliCwd: `/tmp/ocv5-289-run-${"9".repeat(24)}`, transcriptSha256: "f".repeat(64),
      contextHashBeforeFinal: "a".repeat(64), assistantContentHash: "b".repeat(64),
      catalogHash: "c".repeat(64), expiresAtMs: Date.now() + 60_000 })!;
    for (const cliVersion of ["2.1.999", null]) {
      const f = fixture({ directFinal: true, cliVersion,
        nativeCandidate: { ownerRequestId: "native-owner", pointer } });
      const result = await runBoxToolFirstRound(f.input, f.deps);
      assert.equal(result.kind, "final");
      if (result.kind !== "final") return;
      assert.equal(result.nativePointer, undefined);
      assert.equal(f.admittedNative, null, "no native claim is admitted");
      for (const step of ["native-lookup", "native-inspect", "native-attach"]) {
        assert.equal(f.sequence.includes(step), false, `${String(cliVersion)}: ${step}`);
      }
      assert.equal(f.launches, 1);
    }
    const verified = fixture({ directFinal: true });
    const result = await runBoxToolFirstRound(verified.input, verified.deps);
    assert.equal(result.kind === "final" && result.nativePointer?.cliVersion, "2.1.280");
    assert.ok(verified.sequence.includes("native-lookup"));
    assert.ok(verified.sequence.includes("native-attach"));
    // 2.1.288 records a pointer labelled with its own build
    const next = fixture({ directFinal: true, cliVersion: "2.1.288" });
    const written = await runBoxToolFirstRound(next.input, next.deps);
    assert.equal(written.kind === "final" && written.nativePointer?.cliVersion, "2.1.288");
    // a pointer written by another build is a cache miss, not a resume
    const stale = fixture({ directFinal: true, cliVersion: "2.1.288",
      nativeCandidate: { ownerRequestId: "native-owner", pointer } });
    const decisions: unknown[] = [];
    const staleResult = await runBoxToolFirstRound(stale.input,
      { ...stale.deps, onNativeDecision: (info) => { decisions.push(info); } });
    assert.deepEqual(decisions, [{ requestId: stale.input.requestId, decision: "miss",
      reason: "build", cliVersion: "2.1.288" }], "the miss says why, without content");
    assert.equal(staleResult.kind, "final");
    assert.equal(stale.admittedNative, null, "no native claim across CLI builds");
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = previous;
  }
});

// INC-20261006-BOX-SYNTHETIC-TURN-HELD: the CLI's own synthetic user turn inside
// a model message (here without a trusted native session, so it is unbound) is a
// property of this stream: stop the run and settle it, never leave it unknown.
const syntheticTurnRaw = Buffer.from([records[0], records[1],
  { type: "user", isSynthetic: true, parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text",
      text: "Output token limit hit. Resume directly" }] } },
  ...records.slice(2)].map((record) => JSON.stringify(record) + "\n").join(""));

test("INC-20261006 a synthetic CLI turn inside a message is stopped and settled, not left unknown", async () => {
  const f = fixture({ spoolBody: syntheticTurnRaw });
  let stops = 0;
  const deps = { ...f.deps, stopRejectedRun: async () => { stops++; return "stopped_proven" as const; } };
  await assert.rejects(() => runBoxToolFirstRound(f.input, deps),
    (error: unknown) => (error as { code?: string }).code === "BOX_CLI_COMPACT_UNBOUND");
  assert.equal(stops, 1);
  assert.ok(!f.sequence.includes("unknown"));
  assert.deepEqual(f.unknownPhases, []);
  assert.equal(f.retained, false);
  // the run finished on its own: settled from its keeper proof, not billed
  const g = fixture({ spoolBody: syntheticTurnRaw });
  const settled: unknown[] = [];
  const d = { ...g.deps, stopRejectedRun: async () => "completed_unsettled" as const,
    readTerminalProof: (async (args: { runNonce: string; leaseEpoch: string }) => ({
      reason: "worker_complete", runNonce: args.runNonce, leaseEpoch: args.leaseEpoch })) as never,
    journal: { ...(g.deps.journal as object), markFirstRoundRejectedStream: async (input: unknown) => {
      settled.push(input); } } as never };
  await assert.rejects(() => runBoxToolFirstRound(g.input, d),
    (error: unknown) => (error as { code?: string }).code === "BOX_CLI_COMPACT_UNBOUND");
  assert.equal(settled.length, 1);
  assert.deepEqual(g.unknownPhases, []);
});

const upstreamRefusalRaw = Buffer.from([records[0], ...readFileSync(new URL(
  "./__fixtures__/box-cli-upstream-refusal/real-session-limit.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as unknown)]
  .map((record) => JSON.stringify(record) + "\n").join(""));

test("INC-20261006 a CLI usage-limit refusal is stopped and settled unbilled, not left to hold the session", async () => {
  const f = fixture({ spoolBody: upstreamRefusalRaw });
  let stops = 0;
  const deps = { ...f.deps, stopRejectedRun: async () => { stops++; return "stopped_proven" as const; } };
  await assert.rejects(() => runBoxToolFirstRound(f.input, deps),
    (error: unknown) => (error as { code?: string }).code === "BOX_CLI_UPSTREAM_RATE_LIMITED");
  assert.equal(stops, 1);
  assert.ok(!f.sequence.includes("unknown"));
  assert.ok(!f.sequence.includes("durable-handoff"), "nothing is handed to the client");
  assert.deepEqual(f.unknownPhases, []);
  assert.equal(f.retained, false);
  // the CLI already finished on its own: settled from its keeper proof, not billed
  const g = fixture({ spoolBody: upstreamRefusalRaw });
  const settled: unknown[] = [];
  const d = { ...g.deps, stopRejectedRun: async () => "completed_unsettled" as const,
    readTerminalProof: (async (args: { runNonce: string; leaseEpoch: string }) => ({
      reason: "worker_complete", runNonce: args.runNonce, leaseEpoch: args.leaseEpoch })) as never,
    journal: { ...(g.deps.journal as object), markFirstRoundRejectedStream: async (input: unknown) => {
      settled.push(input); } } as never };
  await assert.rejects(() => runBoxToolFirstRound(g.input, d),
    (error: unknown) => (error as { code?: string }).code === "BOX_CLI_UPSTREAM_RATE_LIMITED");
  assert.equal(settled.length, 1);
  assert.deepEqual(g.unknownPhases, []);
});
