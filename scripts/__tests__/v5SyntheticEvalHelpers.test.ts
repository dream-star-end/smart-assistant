import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../..");
const reprovisionHelper = join(
  repoRoot,
  "scripts/v5-synthetic-eval-reprovision-helper.mjs",
);
const turnHelper = join(
  repoRoot,
  "scripts/v5-synthetic-eval-turn-helper.mjs",
);
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

function fakeSsh(directory: string): { path: string; log: string } {
  const path = join(directory, "fake-ssh");
  const log = join(directory, "ssh.log");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  input_sha: process.env.FAKE_INPUT_SHA_ALGO === "none" ? input : "captured",
}) + "\\n");
process.stdout.write(process.env.FAKE_SSH_OUTPUT + "\\n");
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return { path, log };
}

function commonEnv(fakePath: string, fakeLog: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OC_SYNTHETIC_EVAL_SSH_BINARY: fakePath,
    OC_SYNTHETIC_EVAL_UID: "247",
    OC_SYNTHETIC_EVAL_ENGINE: "ccb",
    OC_SYNTHETIC_EVAL_AGENT_ID: "research-assistant",
    FAKE_SSH_LOG: fakeLog,
  };
}

describe("V5 synthetic exact-eval helpers", () => {
  test("reprovision uses one foreground ssh and prints only fresh identity JSON", () => {
    const directory = temp("v5-synthetic-reprovision-helper-");
    const fake = fakeSsh(directory);
    const output = {
      id: "a".repeat(64),
      started_at: "2026-07-31T10:00:00.000Z",
    };
    const result = spawnSync(process.execPath, [reprovisionHelper], {
      encoding: "utf8",
      env: {
        ...commonEnv(fake.path, fake.log),
        OC_SYNTHETIC_EVAL_PHASE: "overlay",
        FAKE_SSH_OUTPUT: JSON.stringify(output),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${JSON.stringify(output)}\n`);
    const calls = readFileSync(fake.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv.slice(0, 5), [
      "kl-mirror",
      "node",
      "--experimental-websocket",
      "--input-type=module",
      "-",
    ]);

    const source = readFileSync(reprovisionHelper, "utf8");
    assert.equal(source.match(/new WebSocket\(/g)?.length, 1);
    assert.equal(
      source.match(/api\/admin\/agent-containers\/\$\{rowId\}\/restart/g)?.length,
      1,
    );
    assert.doesNotMatch(source, /inbound\.message/);
  });

  test("identity validation fails before ssh for non-synthetic or mismatched phase", () => {
    const directory = temp("v5-synthetic-helper-identity-");
    const fake = fakeSsh(directory);
    for (const [uid, phase, expected] of [
      ["5", "overlay", /one of 247,626/],
      ["247", "turn", /overlay or restore/],
    ] as const) {
      const result = spawnSync(process.execPath, [reprovisionHelper], {
        encoding: "utf8",
        env: {
          ...commonEnv(fake.path, fake.log),
          OC_SYNTHETIC_EVAL_UID: uid,
          OC_SYNTHETIC_EVAL_PHASE: phase,
          FAKE_SSH_OUTPUT: "{}",
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    }
    assert.throws(() => readFileSync(fake.log, "utf8"), /ENOENT/);
  });

  test("turn uses one ssh and writes complete exclusive 0600 evidence", () => {
    const directory = temp("v5-synthetic-turn-helper-");
    const fake = fakeSsh(directory);
    const prompt = "Compare two independent sources and return a concise result.";
    const promptSha = createHash("sha256").update(prompt).digest("hex");
    const casePackSha = "b".repeat(64);
    const turnPath = join(directory, "turn.json");
    const framesPath = join(directory, "frames.json");
    const peerId = "eval_peer_0123456789";
    const traceId = "a".repeat(32);
    const clientMessageId = "evalmsg_0123456789";
    const sent = JSON.stringify({
      type: "inbound.message",
      peer: { id: peerId },
      clientMessageId,
      agentId: "research-assistant",
      model: "gpt-5.6-sol",
      content: { text: prompt },
    });
    const received = JSON.stringify({
      type: "outbound.message",
      peer: { id: peerId },
      blocks: [{ kind: "text", text: "done" }],
      isFinal: true,
      traceId,
    });
    const cost = JSON.stringify({
      type: "outbound.cost_charged",
      requestId: "request-1",
      traceId,
    });
    const remote = {
      peer_id: peerId,
      client_message_id: clientMessageId,
      case_id: "multi-source-research",
      pair_id: "research-pair-1",
      order: "A_FIRST",
      case_pack_sha: casePackSha,
      prompt_sha: promptSha,
      model: "gpt-5.6-sol",
      uid: 247,
      engine: "ccb",
      agent_id: "research-assistant",
      started_at: "2026-07-31T10:00:00.000Z",
      finished_at: "2026-07-31T10:00:01.250Z",
      wall_ms: 1_250,
      ttft_ms: 500,
      final_text: "done",
      trace_id: traceId,
      cost_request_id: "request-1",
      cost_trace_id: traceId,
      cost: {
        type: "outbound.cost_charged",
        requestId: "request-1",
        traceId,
      },
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
          bytes: Buffer.byteLength(sent),
          text: sent,
        },
        {
          seq: 1,
          at: "2026-07-31T10:00:00.500Z",
          direction: "received",
          bytes: Buffer.byteLength(received),
          text: received,
        },
        {
          seq: 2,
          at: "2026-07-31T10:00:01.250Z",
          direction: "received",
          bytes: Buffer.byteLength(cost),
          text: cost,
        },
      ],
    };
    const env = {
      ...commonEnv(fake.path, fake.log),
      OC_SYNTHETIC_EVAL_PHASE: "turn",
      OC_SYNTHETIC_EVAL_CASE_ID: "multi-source-research",
      OC_SYNTHETIC_EVAL_PAIR_ID: "research-pair-1",
      OC_SYNTHETIC_EVAL_ORDER: "A_FIRST",
      OC_SYNTHETIC_EVAL_CASE_PACK_SHA: casePackSha,
      OC_SYNTHETIC_EVAL_PROMPT: prompt,
      OC_SYNTHETIC_EVAL_PROMPT_SHA: promptSha,
      OC_SYNTHETIC_EVAL_MODEL: "gpt-5.6-sol",
      OC_SYNTHETIC_EVAL_TURN_PATH: turnPath,
      OC_SYNTHETIC_EVAL_FRAMES_PATH: framesPath,
      FAKE_SSH_OUTPUT: JSON.stringify(remote),
    };
    const result = spawnSync(process.execPath, [turnHelper], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${turnPath}\n`);
    assert.equal(readFileSync(fake.log, "utf8").trim().split("\n").length, 1);
    assert.equal(statSync(turnPath).mode & 0o777, 0o600);
    assert.equal(statSync(framesPath).mode & 0o777, 0o600);

    const framesBytes = readFileSync(framesPath);
    const frames = JSON.parse(framesBytes.toString("utf8"));
    const turn = JSON.parse(readFileSync(turnPath, "utf8"));
    assert.deepEqual(frames.frames, remote.frames);
    assert.equal(turn.peer_id, peerId);
    assert.equal(turn.client_message_id, clientMessageId);
    assert.equal(turn.case_id, "multi-source-research");
    assert.equal(turn.pair_id, "research-pair-1");
    assert.equal(turn.order, "A_FIRST");
    assert.equal(turn.case_pack_sha, casePackSha);
    assert.equal(turn.prompt_sha, promptSha);
    assert.equal(turn.frames_path, framesPath);
    assert.equal(
      turn.frames_sha256,
      createHash("sha256").update(framesBytes).digest("hex"),
    );
    assert.equal(turn.frames_bytes, framesBytes.length);
    assert.deepEqual(turn.connection, { opens: 1, closes: 1, reconnects: 0 });
    assert.deepEqual(frames.connection, turn.connection);
    assert.equal(turn.final_text, "done");

    const second = spawnSync(process.execPath, [turnHelper], {
      encoding: "utf8",
      env,
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refusing to overwrite/);
    assert.equal(
      readFileSync(fake.log, "utf8").trim().split("\n").length,
      1,
      "exclusive output preflight rejects before a second true turn",
    );

    const invalidCounts = spawnSync(process.execPath, [turnHelper], {
      encoding: "utf8",
      env: {
        ...env,
        OC_SYNTHETIC_EVAL_TURN_PATH: join(directory, "invalid-turn.json"),
        OC_SYNTHETIC_EVAL_FRAMES_PATH: join(directory, "invalid-frames.json"),
        FAKE_SSH_OUTPUT: JSON.stringify({
          ...remote,
          connection: { opens: 1, closes: 0, reconnects: 0 },
        }),
      },
    });
    assert.notEqual(invalidCounts.status, 0);
    assert.match(invalidCounts.stderr, /connection|invalid/);
    assert.equal(
      readFileSync(fake.log, "utf8").trim().split("\n").length,
      2,
      "invalid runtime evidence is rejected after exactly one ssh",
    );
  });

  test("turn rejects prompt identity drift before ssh", () => {
    const directory = temp("v5-synthetic-turn-prompt-");
    const fake = fakeSsh(directory);
    const result = spawnSync(process.execPath, [turnHelper], {
      encoding: "utf8",
      env: {
        ...commonEnv(fake.path, fake.log),
        OC_SYNTHETIC_EVAL_PHASE: "turn",
        OC_SYNTHETIC_EVAL_CASE_ID: "short-qa",
        OC_SYNTHETIC_EVAL_PAIR_ID: "short-pair-1",
        OC_SYNTHETIC_EVAL_ORDER: "B_FIRST",
        OC_SYNTHETIC_EVAL_CASE_PACK_SHA: "c".repeat(64),
        OC_SYNTHETIC_EVAL_PROMPT: "exact prompt",
        OC_SYNTHETIC_EVAL_PROMPT_SHA: "0".repeat(64),
        OC_SYNTHETIC_EVAL_MODEL: "gpt-5.6-sol",
        OC_SYNTHETIC_EVAL_TURN_PATH: join(directory, "turn.json"),
        OC_SYNTHETIC_EVAL_FRAMES_PATH: join(directory, "frames.json"),
        FAKE_SSH_OUTPUT: "{}",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /differs from exact prompt bytes/);
    assert.throws(() => readFileSync(fake.log, "utf8"), /ENOENT/);
  });

  test("turn remote contract has one PUT, one WebSocket, and one inbound send", () => {
    const source = readFileSync(turnHelper, "utf8");
    assert.equal(source.match(/new WebSocket\(/g)?.length, 1);
    assert.equal(source.match(/method: "PUT"/g)?.length, 1);
    assert.equal(source.match(/type: "inbound\.message"/g)?.length, 1);
    assert.match(source, /clientMessageId,/);
    assert.equal(source.match(/socket\.send\(frame\)/g)?.length, 1);
    assert.match(source, /turn relay closed before final\+cost/);
    assert.match(source, /socket\.addEventListener\("close"/);
    assert.match(source, /connection\.closes \+= 1/);
    assert.match(source, /runtime\.finals !== 1/);
    assert.match(source, /openSync\(path, "wx"/);
    for (const imported of source.matchAll(/from "([^"]+)"/g)) {
      assert.match(imported[1], /^node:/);
    }
  });
});
