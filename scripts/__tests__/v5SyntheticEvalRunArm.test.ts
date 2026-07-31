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
  assertSameLane,
  analyzeEfficiency,
  hashSafeTree,
  parseReprovisionResult,
  parseRunArmArgs,
  parseTurnResult,
  verifyCasePack,
  verifyHelper,
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
      "1050",
      "--apply",
    ]);
    assert.equal(armB.uid, 626);
    assert.equal(armB.timeoutSeconds, 1_050);
    assert.equal(armB.apply, true);

    const wrongA = validArgs("A");
    wrongA[wrongA.indexOf("--candidate-sha") + 1] = "b".repeat(40);
    assert.throws(() => parseRunArmArgs(wrongA), /arm A must stage/);
    const wrongB = validArgs("B");
    wrongB[wrongB.indexOf("--candidate-sha") + 1] = "a".repeat(40);
    assert.throws(() => parseRunArmArgs(wrongB), /arm B must stage/);
    assert.throws(
      () => parseRunArmArgs([...validArgs("A"), "--timeout-seconds", "1051"]),
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
    };
    const frames = {
      schema_version: 1,
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
        login_requests: 1,
        session_puts: 1,
        websocket_instances: 1,
        inbound_messages: 1,
        finals: 1,
        matching_costs: 1,
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
          at: "2026-07-31T10:00:00.300Z",
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
          at: "2026-07-31T10:00:01.200Z",
          direction: "received",
          bytes: 0,
          text: JSON.stringify({
            type: "outbound.cost_charged",
            requestId: "request-1",
            traceId,
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
    const frameBytes = readFileSync(framesPath);
    writeFileSync(resultPath, JSON.stringify({
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
      trace_id: traceId,
      connection: frames.connection,
      runtime: frames.runtime,
      wall_ms: 1200,
      ttft_ms: 300,
      final_text: "Done.",
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
    assert.throws(
      () => parseTurnResult(
        `${resultPath}\n`,
        resultPath,
        framesPath,
        { ...identity, model: "gpt-5.6-sol" },
      ),
      /identity\/evidence/,
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

  test("source keeps one outer lease, measures actual prompt bytes, and restores in finally", () => {
    const source = readFileSync(runner, "utf8");
    assert.match(source, /assertLeaseEnvironment\(\)/);
    assert.equal(
      source.match(/with-production-mutation-lease\.sh/g)?.length,
      1,
      "the wrapper name appears only in usage; the runner never nests it",
    );
    assert.match(source, /"container-evidence"/);
    assert.match(source, /"extra-prompt-evidence"/);
    assert.match(source, /"dynamic-input-evidence"/);
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
