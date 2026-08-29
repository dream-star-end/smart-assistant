import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertDynamicInputsStable,
  assertNoUnisolatedArchiveMutations,
  assertSameLane,
  assertStandardScratchRestored,
  assertTurnUsageMatchesFrames,
  analyzeEfficiency,
  durablyPersistWorkspaceArtifact,
  hashSafeTree,
  parseReprovisionResult,
  parseRunArmArgs,
  parseTurnResult,
  turnHelperTimeoutMs,
  verifyCasePack,
  verifyHelper,
  verifyWorkspaceArtifactDocument,
} from "../v5-synthetic-eval-run-arm.mjs";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../..");
const runner = join(repoRoot, "scripts/v5-synthetic-eval-run-arm.mjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  chmodSync(directory, 0o700);
  return directory;
}

function validArgs(arm: "A" | "B" = "A"): string[] {
  const base = "a".repeat(40);
  const candidate = arm === "A" ? base : "b".repeat(40);
  return [
    "--arm",
    arm,
    "--uid",
    arm === "A" ? "247" : "626",
    "--engine",
    arm === "A" ? "ccb" : "codex",
    "--agent-id",
    "research-assistant",
    "--model",
    arm === "A" ? "glm-5.2" : "gpt-5.6-sol",
    "--case-pack",
    "/root/eval/held-out.json",
    "--case-pack-sha",
    "f".repeat(64),
    "--case-id",
    "direct-answer-01",
    "--pair-id",
    "pair-direct-01",
    "--order",
    arm === "A" ? "A_FIRST" : "B_FIRST",
    "--expected-prompt-delta-sha",
    "1".repeat(64),
    "--base-sha",
    base,
    "--candidate-sha",
    candidate,
    "--reprovision-helper",
    "/root/eval/reprovision.mjs",
    "--reprovision-helper-sha",
    "c".repeat(64),
    "--reprovision-helper-root",
    "/root/eval",
    "--reprovision-helper-tree-sha",
    "e".repeat(64),
    "--turn-helper",
    "/root/eval/capture.mjs",
    "--turn-helper-sha",
    "d".repeat(64),
    "--turn-helper-root",
    "/root/eval",
    "--turn-helper-tree-sha",
    "e".repeat(64),
    "--evidence-file",
    `/root/eval/${arm}.json`,
  ];
}

describe("V5 synthetic exact-eval run-arm", () => {
  test("accepts only complete fixed synthetic A/B identities and bounded timeouts", () => {
    const armA = parseRunArmArgs(validArgs("A"));
    assert.equal(armA.uid, 247);
    assert.equal(armA.model, "glm-5.2");
    assert.equal(armA.caseId, "direct-answer-01");
    assert.equal(armA.timeoutSeconds, 900);
    assert.equal(armA.apply, false);
    const armB = parseRunArmArgs([
      ...validArgs("B"),
      "--timeout-seconds",
      "2700",
      "--apply",
    ]);
    assert.equal(armB.uid, 626);
    assert.equal(armB.timeoutSeconds, 2_700);
    assert.equal(armB.apply, true);

    const wrongA = validArgs("A");
    wrongA[wrongA.indexOf("--candidate-sha") + 1] = "b".repeat(40);
    assert.throws(() => parseRunArmArgs(wrongA), /arm A must stage/);
    const wrongB = validArgs("B");
    wrongB[wrongB.indexOf("--candidate-sha") + 1] = "a".repeat(40);
    assert.throws(() => parseRunArmArgs(wrongB), /arm B must stage/);
    assert.throws(
      () => parseRunArmArgs([...validArgs("A"), "--timeout-seconds", "2701"]),
      /incomplete or invalid/,
    );
    assert.throws(
      () => parseRunArmArgs(validArgs("A").map((value) =>
        value === "/root/eval/A.json" ? "relative.json" : value
      )),
      /absolute normalized/,
    );
  });

  test("freezes a root-only held-out case pack outside the release tree", () => {
    const directory = temp("v5-held-out-cases-");
    const casePack = join(directory, "cases.json");
    const value = {
      schemaVersion: 1,
      cases: {
        "implementation-01": {
          id: "implementation-01",
          category: "implementation",
          prompt: "Work only in {{EVAL_WORKSPACE}} and verify the result.",
          models: { ccb: "glm-5.2", codex: "gpt-5.6-sol" },
          workspace: "temporary",
        },
      },
    };
    writeFileSync(casePack, JSON.stringify(value), { mode: 0o600 });
    chmodSync(casePack, 0o600);
    const digest = createHash("sha256")
      .update(readFileSync(casePack))
      .digest("hex");
    const frozen = verifyCasePack(
      casePack,
      digest,
      "implementation-01",
      "ccb",
      "glm-5.2",
    );
    assert.equal(frozen.sha256, digest);
    assert.equal(frozen.model, "glm-5.2");
    assert.equal(
      frozen.temporaryWorkspace,
      "/tmp/oc-synthetic-eval-implementation-01",
    );
    assert.match(frozen.prompt, /\/tmp\/oc-synthetic-eval-implementation-01/);
    assert.doesNotMatch(frozen.prompt, /\{\{EVAL_WORKSPACE\}\}/);
    assert.throws(
      () => verifyCasePack(
        casePack,
        digest,
        "implementation-01",
        "codex",
        "glm-5.2",
      ),
      /engine\/model binding/,
    );
    chmodSync(casePack, 0o644);
    assert.throws(
      () => verifyCasePack(
        casePack,
        digest,
        "implementation-01",
        "ccb",
        "glm-5.2",
      ),
      /mode 600/,
    );
  });

  test("freezes root-owned helper bytes and rejects mutation or unsafe modes", () => {
    const directory = temp("v5-run-arm-helper-");
    const helper = join(directory, "helper.mjs");
    writeFileSync(helper, "console.log('{}')\n", { mode: 0o600 });
    chmodSync(helper, 0o600);
    const digest = createHash("sha256").update(readFileSync(helper)).digest("hex");
    const treeDigest = hashSafeTree(directory);
    assert.deepEqual(verifyHelper(helper, digest, directory, treeDigest), {
      path: helper,
      sha256: digest,
      root: directory,
      treeSha256: treeDigest,
    });
    assert.throws(
      () => verifyHelper(helper, "0".repeat(64), directory, treeDigest),
      /SHA mismatch/,
    );
    assert.throws(
      () => verifyHelper(helper, digest, directory, "0".repeat(64)),
      /dependency tree SHA mismatch/,
    );
    chmodSync(helper, 0o622);
    assert.throws(
      () => verifyHelper(helper, digest, directory, treeDigest),
      /group\/other writable/,
    );
  });

  test("parses fresh-container and true-turn helper evidence without trusting logs", () => {
    const containerId = "e".repeat(64);
    const reprovision = parseReprovisionResult(JSON.stringify({
      id: containerId,
      started_at: "2026-07-31T10:00:00.000Z",
    }));
    assert.equal(reprovision.id, containerId);
    assert.throws(
      () => parseReprovisionResult(JSON.stringify({ id: "short", started_at: "x" })),
      /invalid/,
    );

    const directory = temp("v5-run-arm-result-");
    const resultPath = join(directory, "turn.json");
    const framesPath = join(directory, "frames.json");
    const extraPromptPath = join(directory, "extra-prompt.md");
    const extraPromptBytes = Buffer.from("live captured prompt\n");
    const extraPromptSha = createHash("sha256")
      .update(extraPromptBytes)
      .digest("hex");
    const prompt = "Evaluate this exact task.";
    const promptSha = createHash("sha256").update(prompt).digest("hex");
    const traceId = "a".repeat(32);
    const clientMessageId = "evalmsg_0123456789";
    const identity = {
      caseId: "direct-answer-01",
      casePackSha: "f".repeat(64),
      pairId: "pair-direct-01",
      order: "A_FIRST",
      promptSha,
      model: "glm-5.2",
      uid: 247,
      engine: "ccb",
      agentId: "research-assistant",
      containerId,
      extraPromptPath,
    };
    const frames = {
      schema_version: 2,
      peer_id: "peer_0123456789",
      client_message_id: clientMessageId,
      case_id: identity.caseId,
      case_pack_sha: identity.casePackSha,
      pair_id: identity.pairId,
      order: identity.order,
      prompt_sha: identity.promptSha,
      model: identity.model,
      uid: identity.uid,
      engine: identity.engine,
      agent_id: identity.agentId,
      connection: { opens: 1, closes: 1, reconnects: 0 },
      runtime: {
        login_requests: 0,
        user_access_token_issues: 1,
        admin_access_token_issues: 0,
        session_puts: 1,
        websocket_instances: 1,
        inbound_messages: 1,
        finals: 1,
        matching_costs: 1,
        binding_queries: 1,
        prompt_watchers: 1,
        prompt_ready: 1,
        prompt_captures: 1,
      },
      billing_binding: {
        mode: "ccb_authority_dispatch_attempt",
        finalTraceId: traceId,
        dispatchBillingRequestId: "d".repeat(32),
        authorityTurnId: "b".repeat(32),
        dispatchId: "50af992a-0bca-4e19-ba11-24df12de0bed",
        attemptNo: 1,
        requestIds: ["request-1"],
        rootRequestIds: ["request-1"],
        usageIds: ["101"],
        ledgerIds: ["201"],
      },
      frames: [
        {
          seq: 0,
          at: "2026-07-31T10:00:00.000Z",
          direction: "sent",
          bytes: 0,
          text: JSON.stringify({
            type: "inbound.message",
            peer: { id: "peer_0123456789", kind: "dm" },
            clientMessageId,
            agentId: identity.agentId,
            model: identity.model,
            content: { text: prompt },
          }),
        },
        {
          seq: 1,
          at: "2026-07-31T10:14:59.900Z",
          direction: "received",
          bytes: 0,
          text: JSON.stringify({
            type: "outbound.message",
            peer: { id: "peer_0123456789", kind: "dm" },
            blocks: [{ kind: "text", text: "Done." }],
            isFinal: true,
            traceId,
          }),
        },
        {
          seq: 2,
          at: "2026-07-31T10:15:59.900Z",
          direction: "received",
          bytes: 0,
          text: JSON.stringify({
            type: "outbound.cost_charged",
            requestId: "request-1",
            model: identity.model,
            costCredits: "3",
          }),
        },
      ],
    };
    for (const frame of frames.frames) {
      frame.bytes = Buffer.byteLength(frame.text);
    }
    writeFileSync(framesPath, JSON.stringify(frames), { mode: 0o600 });
    chmodSync(framesPath, 0o600);
    writeFileSync(extraPromptPath, extraPromptBytes, { mode: 0o600 });
    chmodSync(extraPromptPath, 0o600);
    const frameBytes = readFileSync(framesPath);
    writeFileSync(resultPath, JSON.stringify({
      schema_version: 2,
      peer_id: "peer_0123456789",
      client_message_id: clientMessageId,
      case_id: identity.caseId,
      case_pack_sha: identity.casePackSha,
      pair_id: identity.pairId,
      order: identity.order,
      prompt_sha: identity.promptSha,
      model: identity.model,
      uid: identity.uid,
      engine: identity.engine,
      agent_id: identity.agentId,
      frames_path: framesPath,
      frames_sha256: createHash("sha256").update(frameBytes).digest("hex"),
      frames_bytes: frameBytes.length,
      frame_count: frames.frames.length,
      started_at: "2026-07-31T10:00:00.000Z",
      finished_at: "2026-07-31T10:14:59.900Z",
      billing_evidence_at: "2026-07-31T10:15:59.900Z",
      prompt_captured_at: "2026-07-31T10:00:01.000Z",
      trace_id: traceId,
      billing_binding: frames.billing_binding,
      connection: frames.connection,
      runtime: frames.runtime,
      wall_ms: 899_900,
      billing_evidence_wait_ms: 60_000,
      ttft_ms: 899_900,
      final_text: "Done.",
      extra_prompt: {
        type: "captured",
        schemaVersion: 1,
        containerId,
        engine: identity.engine,
        sessionKey:
          `agent:${identity.agentId}:webchat:dm:peer_0123456789`,
        path: "/tmp/turn/extra-prompt.md",
        captured_path: extraPromptPath,
        bytes: extraPromptBytes.length,
        sha256: extraPromptSha,
        candidateCount: 1,
        selection: "exact-session-process",
        processes: [{
          pid: 88,
          startTime: "123456",
          cmdlineSha256: "c".repeat(64),
          aliveAtOpen: true,
          aliveAfter: false,
        }],
      },
    }), {
      mode: 0o600,
    });
    chmodSync(resultPath, 0o600);
    const turn = parseTurnResult(
      `${resultPath}\n`,
      resultPath,
      framesPath,
      identity,
    );
    assert.equal(turn.peerId, "peer_0123456789");
    assert.equal(turn.value.client_message_id, clientMessageId);
    assert.equal(turn.source?.path, resultPath);
    assert.match(turn.source?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(turn.frames?.path, framesPath);
    assert.equal(turn.costFrames.length, 1);
    assert.equal(turn.parsedFrames.length, 3);
    assert.equal(turn.value.wall_ms, 899_900);
    assert.equal(turn.value.billing_evidence_wait_ms, 60_000);
    assert.equal(turn.prompt.source.path, extraPromptPath);
    assert.equal(turn.prompt.processes[0].aliveAfter, false);
    assert.equal(turnHelperTimeoutMs(900), 1_110_000);

    const storedTurn = JSON.parse(readFileSync(resultPath, "utf8"));
    const parseWithErrorFrame = (
      name: string,
      errorFrame: Record<string, unknown>,
    ) => {
      const variantFramesPath = join(directory, `${name}-frames.json`);
      const variantTurnPath = join(directory, `${name}-turn.json`);
      const variantFrames = {
        ...frames,
        frames: [
          {
            seq: 0,
            at: "2026-07-31T09:59:59.000Z",
            direction: "received",
            bytes: 0,
            text: JSON.stringify(errorFrame),
          },
          ...frames.frames.map((frame, index) => ({
            ...frame,
            seq: index + 1,
          })),
        ],
      };
      for (const frame of variantFrames.frames) {
        frame.bytes = Buffer.byteLength(frame.text);
      }
      const variantFramesBytes = Buffer.from(`${JSON.stringify(variantFrames)}\n`);
      writeFileSync(variantFramesPath, variantFramesBytes, { mode: 0o600 });
      writeFileSync(variantTurnPath, JSON.stringify({
        ...storedTurn,
        frames_path: variantFramesPath,
        frames_sha256: createHash("sha256")
          .update(variantFramesBytes)
          .digest("hex"),
        frames_bytes: variantFramesBytes.length,
        frame_count: variantFrames.frames.length,
      }), { mode: 0o600 });
      chmodSync(variantFramesPath, 0o600);
      chmodSync(variantTurnPath, 0o600);
      return () => parseTurnResult(
        `${variantTurnPath}\n`,
        variantTurnPath,
        variantFramesPath,
        identity,
      );
    };
    const staleReplay = parseWithErrorFrame("stale-replay-error", {
      type: "error",
      code: "UNAUTHORIZED_MODEL",
      peer: { id: "peer_other_0123456789", kind: "dm" },
      clientMessageId: "message_other_0123456789",
    })();
    assert.equal(staleReplay.peerId, "peer_0123456789");
    assert.throws(
      parseWithErrorFrame("current-turn-error", {
        type: "error",
        code: "UNAUTHORIZED_MODEL",
        peer: { id: "peer_0123456789", kind: "dm" },
        clientMessageId,
      }),
      /clean final plus authoritative cost/,
    );
    assert.throws(
      parseWithErrorFrame("connection-error", {
        type: "error",
        code: "RELAY_CONNECTION_FAILED",
      }),
      /clean final plus authoritative cost/,
    );
    const writeRuntimeVariant = (
      name: string,
      runtime: Record<string, number>,
    ): { turnPath: string; framesPath: string } => {
      const variantFramesPath = join(directory, `${name}-frames.json`);
      const variantTurnPath = join(directory, `${name}-turn.json`);
      const variantFramesBytes = Buffer.from(`${JSON.stringify({
        ...frames,
        runtime,
      })}\n`);
      writeFileSync(variantFramesPath, variantFramesBytes, { mode: 0o600 });
      writeFileSync(variantTurnPath, JSON.stringify({
        ...storedTurn,
        runtime,
        frames_path: variantFramesPath,
        frames_sha256: createHash("sha256").update(variantFramesBytes).digest("hex"),
        frames_bytes: variantFramesBytes.length,
      }), { mode: 0o600 });
      chmodSync(variantFramesPath, 0o600);
      chmodSync(variantTurnPath, 0o600);
      return { turnPath: variantTurnPath, framesPath: variantFramesPath };
    };
    const oldLoginRuntime = writeRuntimeVariant("old-login", {
      ...frames.runtime,
      login_requests: 1,
    });
    assert.throws(
      () => parseTurnResult(
        `${oldLoginRuntime.turnPath}\n`,
        oldLoginRuntime.turnPath,
        oldLoginRuntime.framesPath,
        identity,
      ),
      /does not prove one WebSocket connection/,
    );
    const missingTokenRuntime = { ...frames.runtime };
    delete (missingTokenRuntime as Partial<typeof frames.runtime>)
      .admin_access_token_issues;
    const missingToken = writeRuntimeVariant("missing-token-key", missingTokenRuntime);
    assert.throws(
      () => parseTurnResult(
        `${missingToken.turnPath}\n`,
        missingToken.turnPath,
        missingToken.framesPath,
        identity,
      ),
      /does not prove one WebSocket connection/,
    );
    const extraToken = writeRuntimeVariant("extra-token-key", {
      ...frames.runtime,
      access_token_issues: 1,
    });
    assert.throws(
      () => parseTurnResult(
        `${extraToken.turnPath}\n`,
        extraToken.turnPath,
        extraToken.framesPath,
        identity,
      ),
      /does not prove one WebSocket connection/,
    );
    const injectedPath = join(directory, "turn-with-injected-bytes.json");
    writeFileSync(injectedPath, JSON.stringify({
      ...storedTurn,
      extra_prompt: {
        ...storedTurn.extra_prompt,
        contentBase64: extraPromptBytes.toString("base64"),
      },
    }), { mode: 0o600 });
    chmodSync(injectedPath, 0o600);
    assert.throws(
      () => parseTurnResult(`${injectedPath}\n`, injectedPath, framesPath, identity),
      /extra-prompt identity\/evidence/,
    );

    const wrongContainerPath = join(directory, "turn-wrong-container.json");
    writeFileSync(wrongContainerPath, JSON.stringify({
      ...storedTurn,
      extra_prompt: {
        ...storedTurn.extra_prompt,
        containerId: "0".repeat(64),
      },
    }), { mode: 0o600 });
    chmodSync(wrongContainerPath, 0o600);
    assert.throws(
      () => parseTurnResult(
        `${wrongContainerPath}\n`,
        wrongContainerPath,
        framesPath,
        identity,
      ),
      /extra-prompt identity\/evidence/,
    );

    assert.throws(
      () => parseTurnResult(
        `${resultPath}\n`,
        resultPath,
        framesPath,
        { ...identity, model: "gpt-5.6-sol" },
      ),
      /identity\/evidence/,
    );
    writeFileSync(extraPromptPath, "corrupted", { mode: 0o600 });
    chmodSync(extraPromptPath, 0o600);
    assert.throws(
      () => parseTurnResult(`${resultPath}\n`, resultPath, framesPath, identity),
      /captured extra-prompt bytes differ/,
    );
  });

  test("derives efficiency only from raw frames and exact authoritative usage", () => {
    const text = (payload: unknown) => JSON.stringify(payload);
    const parsedFrames = [
      {
        seq: 0,
        at: "2026-07-31T10:00:00.000Z",
        direction: "received",
        text: text({
          blocks: [
            { kind: "text", text: "checking" },
            {
              kind: "tool_use",
              blockId: "tool-1",
              toolName: "read_file",
              input: { path: "/tmp/a" },
            },
            {
              kind: "tool_use",
              blockId: "tool-2",
              toolName: "read_file",
              input: { path: "/tmp/b" },
            },
          ],
        }),
        bytes: 10,
        payload: {
          blocks: [
            { kind: "text", text: "checking" },
            {
              kind: "tool_use",
              blockId: "tool-1",
              toolName: "read_file",
              input: { path: "/tmp/a" },
            },
            {
              kind: "tool_use",
              blockId: "tool-2",
              toolName: "read_file",
              input: { path: "/tmp/b" },
            },
          ],
        },
      },
      {
        seq: 1,
        at: "2026-07-31T10:00:00.500Z",
        direction: "received",
        text: "{}",
        bytes: 2,
        payload: {
          blocks: [
            { kind: "tool_result", toolUseBlockId: "tool-1" },
            { kind: "tool_result", toolUseBlockId: "tool-2" },
            { kind: "text", text: "done" },
          ],
        },
      },
    ];
    const efficiency = analyzeEfficiency(
      {
        value: {
          wall_ms: 1_200,
          ttft_ms: 250,
          final_text: "done",
        },
        parsedFrames,
      },
      {
        rootUsage: [{
          input_tokens: "100",
          output_tokens: "20",
          cache_read_tokens: "5",
          cache_write_tokens: "2",
          cost_credits: "3",
        }],
        delegateUsage: [],
      },
    );
    assert.equal(efficiency.wallMs, 1_200);
    assert.equal(efficiency.toolCallCount, 2);
    assert.equal(efficiency.parallelToolCallFrames, 1);
    assert.equal(efficiency.maxToolCallsInFrame, 2);
    assert.equal(efficiency.modelToolBoundaries, 2);
    assert.equal(efficiency.inputTokens, "100");
    assert.equal(efficiency.costCredits, "3");
  });

  test("binds CCB cost frames through authority/dispatch/attempt and preserves Codex trace binding", () => {
    const ccbTurn = {
      value: {
        trace_id: "a".repeat(32),
        billing_binding: {
          mode: "ccb_authority_dispatch_attempt",
          finalTraceId: "a".repeat(32),
          dispatchBillingRequestId: "d".repeat(32),
          authorityTurnId: "b".repeat(32),
          dispatchId: "50af992a-0bca-4e19-ba11-24df12de0bed",
          attemptNo: 1,
          requestIds: ["request-root", "request-delegate"].sort(),
          rootRequestIds: ["request-root"],
          usageIds: ["101", "102"],
          ledgerIds: ["201", "202"],
        },
      },
      costFrames: [
        { requestId: "request-root", model: "glm-5.2", costCredits: "4" },
        { requestId: "request-delegate", model: "glm-5.2", costCredits: "2" },
      ],
    };
    const ccbEvidence = {
      billingBindingMode: "ccb_authority_dispatch_attempt",
      dispatch: {
        dispatch_id: "50af992a-0bca-4e19-ba11-24df12de0bed",
        attempt_no: 1,
        billing_request_id: "d".repeat(32),
      },
      authorityBindings: [{ authority_turn_id: "b".repeat(32) }],
      rootUsage: [{
        id: 101,
        request_id: "request-root",
        model: "glm-5.2",
        cost_credits: 4,
      }],
      delegateUsage: [{
        id: 102,
        request_id: "request-delegate",
        model: "glm-5.2",
        cost_credits: 2,
      }],
      newUsage: [{ id: 101 }, { id: 102 }],
      ledger: [{ id: "201" }, { id: "202" }],
    };
    assert.doesNotThrow(() =>
      assertTurnUsageMatchesFrames(ccbTurn, ccbEvidence)
    );

    const wrongAuthority = structuredClone(ccbEvidence);
    wrongAuthority.authorityBindings[0].authority_turn_id = "c".repeat(32);
    assert.throws(
      () => assertTurnUsageMatchesFrames(ccbTurn, wrongAuthority),
      /CCB helper binding differs/,
    );
    const wrongRequest = structuredClone(ccbTurn);
    wrongRequest.costFrames[1].requestId = "unbound-request";
    assert.throws(
      () => assertTurnUsageMatchesFrames(wrongRequest, ccbEvidence),
      /cost frame is not uniquely bound/,
    );

    const codexTurn = {
      value: {
        trace_id: "d".repeat(32),
        billing_binding: {
          mode: "codex_server_trace",
          traceId: "d".repeat(32),
          requestIds: ["codex-request"],
        },
      },
      costFrames: [{
        requestId: "codex-request",
        traceId: "d".repeat(32),
        model: "gpt-5.6-sol",
        costCredits: "5",
      }],
    };
    assert.doesNotThrow(() =>
      assertTurnUsageMatchesFrames(codexTurn, {
        billingBindingMode: "codex_server_trace",
        dispatch: {
          dispatch_id: "d",
          attempt_no: 1,
          billing_request_id: "codex-request",
        },
        authorityBindings: [],
        rootUsage: [{
          id: 103,
          request_id: "codex-request",
          model: "gpt-5.6-sol",
          cost_credits: 5,
        }],
        delegateUsage: [],
        newUsage: [{ id: 103 }],
        ledger: [{ id: "203" }],
      })
    );

    const wrongRootTrace = structuredClone(codexTurn);
    wrongRootTrace.value.billing_binding.requestIds = ["delegate-request"];
    wrongRootTrace.costFrames = [
      {
        requestId: "codex-request",
        traceId: "e".repeat(32),
        model: "gpt-5.6-sol",
        costCredits: "5",
      },
      {
        requestId: "delegate-request",
        traceId: "d".repeat(32),
        model: "gpt-5.6-sol",
        costCredits: "2",
      },
    ];
    assert.throws(
      () => assertTurnUsageMatchesFrames(wrongRootTrace, {
        billingBindingMode: "codex_server_trace",
        dispatch: {
          dispatch_id: "d",
          attempt_no: 1,
          billing_request_id: "codex-request",
        },
        authorityBindings: [],
        rootUsage: [{
          id: 103,
          request_id: "codex-request",
          model: "gpt-5.6-sol",
          cost_credits: 5,
        }],
        delegateUsage: [{
          id: 104,
          request_id: "delegate-request",
          model: "gpt-5.6-sol",
          cost_credits: 2,
        }],
        newUsage: [{ id: 103 }, { id: 104 }],
        ledger: [{ id: "203" }, { id: "204" }],
      }),
      /exact root dispatch trace/,
    );
  });

  test("fsyncs the local workspace artifact and its parent before recovery", () => {
    const parent = temp("v5-eval-workspace-durable-");
    const artifact = join(parent, "workspace.json");
    writeFileSync(artifact, "{}", { mode: 0o600 });
    chmodSync(artifact, 0o600);

    assert.doesNotThrow(() => durablyPersistWorkspaceArtifact(artifact));
    const synced: number[] = [];
    assert.doesNotThrow(() =>
      durablyPersistWorkspaceArtifact(artifact, (fd) => synced.push(fd))
    );
    assert.equal(synced.length, 2);
    assert.throws(
      () => durablyPersistWorkspaceArtifact(artifact, () => {
        throw new Error("fsync failed");
      }),
      /fsync failed/,
    );
    let calls = 0;
    assert.throws(
      () => durablyPersistWorkspaceArtifact(artifact, () => {
        calls += 1;
        if (calls === 2) throw new Error("parent fsync failed");
      }),
      /parent fsync failed/,
    );
  });

  test("verifies complete workspace bytes and rejects path or content corruption", () => {
    const fileBytes = Buffer.from("console.log('ok');\n");
    const fileSha = createHash("sha256").update(fileBytes).digest("hex");
    const tree = createHash("sha256")
      .update("D  src\n")
      .update(`F  ${fileSha}  src/index.js\n`)
      .digest("hex");
    const identity = {
      state: "tree",
      files: 1,
      directories: 1,
      sha256: tree,
    };
    const document = {
      schemaVersion: 1,
      uid: 247,
      engine: "ccb",
      agentId: "research-assistant",
      caseId: "software-build-01",
      workspaceMode: "temporary",
      containerId: "e".repeat(64),
      manifestSha: "f".repeat(64),
      identity,
      entries: [
        { path: "src", type: "directory", mode: 0o755 },
        {
          path: "src/index.js",
          type: "file",
          mode: 0o644,
          bytes: fileBytes.length,
          sha256: fileSha,
          contentBase64: fileBytes.toString("base64"),
        },
      ],
    };
    const remote = { state: "tree", identity, entryCount: 2 };
    const expected = {
      uid: 247,
      engine: "ccb",
      agentId: "research-assistant",
      caseId: "software-build-01",
      workspaceMode: "temporary",
      containerId: "e".repeat(64),
      manifestSha: "f".repeat(64),
      identity,
    };
    assert.deepEqual(
      verifyWorkspaceArtifactDocument(document, remote, expected),
      { files: 1, directories: 1, completeBytes: fileBytes.length },
    );
    const escaped = structuredClone(document);
    escaped.entries[1].path = "../index.js";
    assert.throws(
      () => verifyWorkspaceArtifactDocument(escaped, remote, expected),
      /entry identity is invalid/,
    );
    const corrupted = structuredClone(document);
    corrupted.entries[1].contentBase64 = Buffer.from("changed").toString("base64");
    assert.throws(
      () => verifyWorkspaceArtifactDocument(corrupted, remote, expected),
      /incomplete or corrupted/,
    );
  });

  test("lane comparison ignores expected per-turn counters but rejects production drift", () => {
    const before = {
      phase: "stable",
      activeSlot: "A",
      candidateSlot: null,
      activeRelease: "/release",
      candidateRelease: null,
      cohortPercent: 0,
      lockVersion: 7,
      sourceCommit: "a".repeat(40),
      enabledCron: 0,
      cronFileEnabled: 0,
      v3State: "inactive",
      dispatchCount: 3,
      openDispatchCount: 0,
      usageCount: 4,
      usageMaxId: 9,
    };
    assert.doesNotThrow(() =>
      assertSameLane(before, {
        ...before,
        dispatchCount: 4,
        usageCount: 6,
        usageMaxId: 11,
      })
    );
    assert.throws(
      () => assertSameLane(before, { ...before, activeSlot: "B" }),
      /activeSlot/,
    );
    assert.throws(
      () => assertSameLane(before, { ...before, v3State: "active" }),
      /v3State/,
    );
  });

  test("allows isolated scratch writes but keeps real inputs and persistent scratch exact", () => {
    const emptyScratch = {
      state: "tree",
      files: 0,
      directories: 0,
      sha256: createHash("sha256").update("").digest("hex"),
      uid: 1000,
      gid: 1000,
      mode: 0o700,
    };
    const stable = {
      agentClaude: { state: "file", bytes: 1, sha256: "a".repeat(64) },
      agentMemoryIndex: { state: "absent" },
      agentMemoryTree: { state: "absent" },
      userSoul: { state: "absent" },
      userProfile: { state: "absent" },
      userSkills: { state: "tree", files: 0, directories: 0, sha256: "b".repeat(64) },
    };
    const before = {
      inputs: {
        ...structuredClone(stable),
        workspace: structuredClone(emptyScratch),
        browserCliScratch: structuredClone(emptyScratch),
        browserMcpScratch: structuredClone(emptyScratch),
        sharedSkillsScratch: structuredClone(emptyScratch),
        skillDraftsScratch: structuredClone(emptyScratch),
        skillEvalsScratch: structuredClone(emptyScratch),
        agentSkillsScratch: structuredClone(emptyScratch),
        temporaryWorkspace: { state: "absent" },
      },
    };
    const after = structuredClone(before);
    after.inputs.workspace.files = 50;
    after.inputs.workspace.directories = 1;
    after.inputs.workspace.sha256 = "c".repeat(64);
    after.inputs.browserCliScratch.files = 2;
    after.inputs.browserCliScratch.sha256 = "d".repeat(64);
    assert.doesNotThrow(() => assertDynamicInputsStable(before, after, "none"));

    const realInputDrift = structuredClone(after);
    realInputDrift.inputs.userSkills.sha256 = "e".repeat(64);
    assert.throws(
      () => assertDynamicInputsStable(before, realInputDrift, "none"),
      /dynamic input changed.*userSkills/,
    );

    const dirtyPre = structuredClone(before);
    dirtyPre.inputs.workspace.files = 1;
    dirtyPre.inputs.workspace.sha256 = "f".repeat(64);
    assert.throws(
      () => assertDynamicInputsStable(dirtyPre, after, "none"),
      /isolated scratch was not an empty agent-owned tree.*workspace/,
    );

    const persistent = {
      standard: true,
      persistentScratch: {
        workspace: { state: "tree", files: 8, directories: 0, sha256: "1".repeat(64) },
        browserCli: { state: "tree", files: 2, directories: 0, sha256: "2".repeat(64) },
        browserMcp: { state: "tree", files: 0, directories: 0, sha256: emptyScratch.sha256 },
        sharedSkills: { state: "tree", files: 4, directories: 2, sha256: "4".repeat(64) },
        skillDrafts: { state: "absent" },
        skillEvals: { state: "tree", files: 1, directories: 1, sha256: "5".repeat(64) },
        agentSkills: { state: "absent" },
      },
    };
    assert.doesNotThrow(() =>
      assertStandardScratchRestored(persistent, structuredClone(persistent))
    );
    const changed = structuredClone(persistent);
    changed.persistentScratch.workspace.sha256 = "3".repeat(64);
    assert.throws(
      () => assertStandardScratchRestored(persistent, changed),
      /persistent scratch changed/,
    );

    const missing = structuredClone(persistent);
    delete (missing.persistentScratch as Partial<
      typeof missing.persistentScratch
    >).browserMcp;
    assert.throws(
      () => assertStandardScratchRestored(missing, persistent),
      /invalid shape/,
    );

    const absent = structuredClone(persistent);
    (absent.persistentScratch as Record<string, unknown>).browserMcp = {
      state: "absent",
    };
    assert.throws(
      () => assertStandardScratchRestored(absent, persistent),
      /tree identity is invalid/,
    );
  });

  test("rejects completed archive mutations without treating searches or failures as writes", () => {
    const directory = temp("v5-run-arm-archive-mutation-");
    const framesPath = join(directory, "frames.json");
    const writeFrames = (blocks: Array<Record<string, unknown>>) => {
      writeFileSync(framesPath, JSON.stringify({
        frames: [{
          direction: "received",
          text: JSON.stringify({ type: "outbound.message", blocks }),
        }],
      }), { mode: 0o600 });
      chmodSync(framesPath, 0o600);
    };
    const completed = (
      blockId: string,
      toolName: string,
      inputJson: Record<string, unknown>,
      isError = false,
    ) => [
      { kind: "tool_use", blockId, toolName, inputJson },
      { kind: "tool_result", toolUseBlockId: blockId, isError },
    ];

    writeFrames(completed("direct", "codex:mcpToolCall", {
      server: "openclaude_memory",
      tool: "archival_add",
    }));
    assert.throws(
      () => assertNoUnisolatedArchiveMutations(framesPath),
      /unisolated archive mutation completed.*direct/,
    );

    writeFrames(completed("wrapped", "ExecuteExtraTool", {
      tool_name: "mcp__openclaude_memory__archival_delete",
      arguments: { id: "arc-test" },
    }));
    assert.throws(
      () => assertNoUnisolatedArchiveMutations(framesPath),
      /unisolated archive mutation completed.*wrapped/,
    );

    writeFrames(completed("direct-ccb", "mcp__openclaude_memory__archival_add", {
      content: "sample",
    }));
    assert.throws(
      () => assertNoUnisolatedArchiveMutations(framesPath),
      /unisolated archive mutation completed.*direct-ccb/,
    );

    writeFrames(completed("shell", "Bash", {
      command: "bash -lc 'command timeout 10s oc-memory archival-add sample'",
    }));
    assert.throws(
      () => assertNoUnisolatedArchiveMutations(framesPath),
      /unisolated archive mutation completed.*shell/,
    );

    writeFrames([
      ...completed("search", "Bash", {
        command: "rg \"bash -lc 'oc-memory archival-add sample'\" docs",
      }),
      ...completed("failed", "codex:mcpToolCall", {
        server: "openclaude_memory",
        tool: "archival_delete",
      }, true),
    ]);
    assert.doesNotThrow(() => assertNoUnisolatedArchiveMutations(framesPath));
  });

  test("source keeps one outer lease, measures actual prompt bytes, and restores in finally", () => {
    const source = readFileSync(runner, "utf8");
    assert.match(source, /assertLeaseEnvironment\(\)/);
    assert.equal(
      source.match(/with-production-mutation-lease\.sh/g)?.length,
      1,
      "the wrapper name appears only in usage; the runner never nests it",
    );
    assert.match(source, /"container-evidence"/);
    assert.doesNotMatch(source, /"extra-prompt-evidence"/);
    assert.match(source, /OC_SYNTHETIC_EVAL_EXTRA_PROMPT_PATH/);
    assert.match(source, /OC_SYNTHETIC_EVAL_CONTAINER_ID/);
    assert.match(source, /const \{ source: _promptSource, \.\.\.extraPrompt \} = turn\.prompt/);
    assert.match(source, /"dynamic-input-evidence"/);
    assert.match(source, /"workspace-artifact-evidence"/);
    assert.match(source, /"turn-evidence"/);
    assert.match(source, /clientMessageId: turn\.value\.client_message_id/);
    assert.match(source, /"standard-container-evidence"/);
    assert.match(source, /const prepareNonce = randomBytes\(16\)\.toString\("hex"\)/);
    assert.match(source, /"--nonce",\s+prepareNonce/);
    assert.match(source, /"--manifest-sha",\s+expectedManifestSha/);
    assert.match(source, /OC_SYNTHETIC_EVAL_PHASE: phase/);
    assert.match(source, /name !== "OC_V5_MANUAL_LEASE_NONCE"/);
    assert.equal(
      source.match(/"--foreground"/g)?.length,
      2,
      "helpers remain in the outer lease command group",
    );
    assert.match(source, /assertRunnerCommandGroupLeader\(\)/);
    assert.match(source, /terminateCommandGroupChildren\(\)/);
    assert.match(source, /processGroupId === process\.pid/);
    assert.equal(
      source.match(/spawnSync\("timeout"/g)?.length,
      2,
      "both external chains use bounded timeout plus exact descendant cleanup",
    );
    assert.match(source, /--kill-after=15s/);
    assert.match(source, /post\.dispatchCount !== pre\.dispatchCount \+ 1/);
    assert.match(source, /post\.usageMaxId !== expectedUsageMaxId/);
    assert.match(source, /verifyCasePack\(/);
    assert.match(source, /OC_SYNTHETIC_EVAL_PROMPT:/);
    assert.match(source, /spawnSync\(\s+"scp"/);
    assert.ok(
      source.indexOf("durablyPersistWorkspaceArtifact(outputPath)")
        > source.indexOf("verifyWorkspaceArtifactDocument(document"),
    );
  });

  test("help is side-effect free and a real arm fails before git/ssh without wrapper proof", () => {
    const help = spawnSync(process.execPath, [runner, "--help"], {
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /one\s+official production-mutation lease/);

    const noLease = spawnSync(process.execPath, [runner, ...validArgs("A")], {
      encoding: "utf8",
      env: {
        ...process.env,
        OC_V5_MANUAL_LEASE_NONCE: "",
        OC_V5_MANUAL_LEASE_PROOF: "",
        PATH: "/nonexistent",
      },
    });
    assert.equal(noLease.status, 2);
    assert.match(noLease.stderr, /with-production-mutation-lease/);
    assert.doesNotMatch(noLease.stderr, /git|ssh/);
  });
});
