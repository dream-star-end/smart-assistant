import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyAccess } from "../../packages/commercial/src/auth/jwt.ts";

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
    const remoteOutput = {
      ...output,
      runtime: {
        login_requests: 0,
        user_access_token_issues: 1,
        admin_access_token_issues: 1,
      },
    };
    const result = spawnSync(process.execPath, [reprovisionHelper], {
      encoding: "utf8",
      env: {
        ...commonEnv(fake.path, fake.log),
        OC_SYNTHETIC_EVAL_PHASE: "overlay",
        FAKE_SSH_OUTPUT: JSON.stringify(remoteOutput),
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
    assert.equal(source.match(/new WebSocketCtor\(/g)?.length, 1);
    assert.equal(
      source.match(/api\/admin\/agent-containers\/\$\{rowId\}\/restart/g)?.length,
      1,
    );
    assert.doesNotMatch(source, /inbound\.message/);
    assert.doesNotMatch(source, /api\/auth\/login|passwordFile|turnstile_token/);
    assert.match(
      source,
      /SELECT id,email,email_verified,role,status,signal_traffic_class/,
    );
    assert.match(source, /syntheticIdentity\[2\] !== "t"/);
    assert.ok(
      source.indexOf("const base = `http://127.0.0.1:${activePort}`")
        < source.indexOf("const now = Math.floor(Date.now() / 1000)"),
      "admin/user token lifetime starts only after synchronous safety preflights",
    );
  });

  test("fixed helper JWTs verify with the production access-token verifier", async () => {
    const secret = "fixed-eval-secret-is-at-least-32-bytes";
    const now = 1_785_600_000;
    const helpers = await Promise.all([
      import(`${pathToFileURL(reprovisionHelper).href}?jwt=${Date.now()}`),
      import(`${pathToFileURL(turnHelper).href}?jwt=${Date.now()}`),
    ]) as Array<{
      issueSyntheticUserAccessToken: (
        uid: number,
        secret: string,
        now: number,
        createHmacFn: typeof createHmac,
        randomBytesFn: typeof randomBytes,
      ) => string;
    }>;

    for (const helper of helpers) {
      for (const uid of [247, 626]) {
        const token = helper.issueSyntheticUserAccessToken(
          uid,
          secret,
          now,
          createHmac,
          randomBytes,
        );
        const [encodedHeader, encodedClaims] = token.split(".");
        assert.deepEqual(
          JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")),
          { alg: "HS256", typ: "JWT" },
        );
        const rawClaims = JSON.parse(
          Buffer.from(encodedClaims, "base64url").toString("utf8"),
        );
        const verified = await verifyAccess(token, secret, { now: now + 1 });
        assert.deepEqual(verified, rawClaims);
        assert.equal(verified.sub, String(uid));
        assert.equal(verified.role, "user");
        assert.equal(Number.isSafeInteger(verified.iat), true);
        assert.equal(Number.isSafeInteger(verified.exp), true);
        assert.equal(verified.exp - verified.iat, 900);
        assert.match(verified.jti, /^[0-9a-f]{32}$/);
      }
      assert.throws(
        () => helper.issueSyntheticUserAccessToken(
          247,
          "界".repeat(10),
          now,
          createHmac,
          randomBytes,
        ),
        /at least 32 UTF-8 bytes/,
      );
    }
  });

  test("reprovision parser requires exact zero-login and two-token evidence", async () => {
    const helper = await import(
      `${pathToFileURL(reprovisionHelper).href}?runtime=${Date.now()}`
    ) as { parseReprovisionOutput: (stdout: string) => unknown };
    const exact = {
      id: "a".repeat(64),
      started_at: "2026-07-31T10:00:00.000Z",
      runtime: {
        login_requests: 0,
        user_access_token_issues: 1,
        admin_access_token_issues: 1,
      },
    };
    assert.deepEqual(
      helper.parseReprovisionOutput(`${JSON.stringify(exact)}\n`),
      exact,
    );
    for (const runtime of [
      { ...exact.runtime, login_requests: 1 },
      { login_requests: 0, user_access_token_issues: 1 },
      { ...exact.runtime, access_token_issues: 2 },
    ]) {
      assert.throws(
        () => helper.parseReprovisionOutput(JSON.stringify({ ...exact, runtime })),
        /remote reprovision output is invalid/,
      );
    }
  });

  test("reprovision follows only bounded 4503 starting/provisioning readiness", async () => {
    const helper = await import(
      `${pathToFileURL(reprovisionHelper).href}?readiness=${Date.now()}`
    ) as {
      waitForFreshRelay: (
        url: string,
        accessToken: string,
        options: {
          WebSocketCtor: new (url: string, protocols: string[]) => FakeSocket;
          timeoutMs: number;
          sleep: (milliseconds: number) => Promise<void>;
        },
      ) => Promise<void>;
    };

    type Listener = (event: { data?: string; code?: number; reason?: string }) => void;
    type SocketScript = (socket: FakeSocket) => void;
    let scripts: SocketScript[] = [];
    let active = 0;
    let maxActive = 0;
    let sends = 0;
    const sockets: FakeSocket[] = [];

    class FakeSocket {
      readonly listeners = new Map<string, Listener[]>();
      closed = false;

      constructor(readonly url: string, readonly protocols: string[]) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        sockets.push(this);
        const script = scripts.shift();
        assert.ok(script, "unexpected WebSocket attempt");
        queueMicrotask(() => script(this));
      }

      addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type: string, event: { data?: string; code?: number; reason?: string }): void {
        if (type === "close" && !this.closed) {
          this.closed = true;
          active -= 1;
        }
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      close(): void {
        if (this.closed) return;
        this.closed = true;
        active -= 1;
      }

      send(): void {
        sends += 1;
      }
    }

    const sleeps: number[] = [];
    scripts = [
      (socket) => socket.emit("close", {
        code: 4503,
        reason: JSON.stringify({ reason: "starting", retryAfterSec: 5 }),
      }),
      (socket) => socket.emit("message", {
        data: JSON.stringify({ type: "sys.relay_ready" }),
      }),
    ];
    await helper.waitForFreshRelay("ws://relay", "token", {
      WebSocketCtor: FakeSocket,
      timeoutMs: 10_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    assert.deepEqual(sleeps, [5_000]);
    assert.equal(sockets.length, 2);
    assert.equal(maxActive, 1);
    assert.equal(active, 0);
    assert.equal(sends, 0);
    assert.ok(sockets.every((socket) => socket.closed));

    for (const close of [
      { code: 4503, reason: "not-json" },
      {
        code: 4503,
        reason: JSON.stringify({ reason: "image_outdated", retryAfterSec: 5 }),
      },
      {
        code: 4503,
        reason: JSON.stringify({ reason: "provisioning" }),
      },
      { code: 1006, reason: "" },
    ]) {
      scripts = [(socket) => socket.emit("close", close)];
      await assert.rejects(
        helper.waitForFreshRelay("ws://relay", "token", {
          WebSocketCtor: FakeSocket,
          timeoutMs: 1_000,
          sleep: async () => {},
        }),
        new RegExp(`closed before ready \\(${close.code}\\)`),
      );
    }

    scripts = [() => {}];
    const deadlineSocketIndex = sockets.length;
    await assert.rejects(
      helper.waitForFreshRelay("ws://relay", "token", {
        WebSocketCtor: FakeSocket,
        timeoutMs: 10,
        sleep: async () => {},
      }),
      /did not become ready in 140s/,
    );
    assert.equal(sockets.length, deadlineSocketIndex + 1);
    assert.equal(sockets.at(-1)?.closed, true);
    assert.equal(active, 0);
  });

  test("reprovision sends fixed SELECT through psql stdin so uid variables expand", async () => {
    const helper = await import(
      `${pathToFileURL(reprovisionHelper).href}?test=${Date.now()}`
    ) as { REPROVISION_REMOTE_SCRIPT: string };
    const calls: Array<{
      command: string;
      args: string[];
      options: { input?: string };
    }> = [];
    Reflect.set(globalThis, "__syntheticEvalExecFileSync", (
      command: string,
      args: string[],
      options: { input?: string },
    ) => {
      if (command === "/bin/bash") {
        return Buffer.from(
          "DATABASE_URL=postgresql://mock\0" +
            "COMMERCIAL_JWT_SECRET=fixed-eval-secret-is-at-least-32-bytes\0",
        );
      }
      if (command === "psql") {
        calls.push({ command, args, options });
        throw new Error("STOP_AFTER_FIRST_PSQL");
      }
      throw new Error(`unexpected command before psql: ${command}`);
    });
    const instrumented = helper.REPROVISION_REMOTE_SCRIPT.replace(
      /^  const \{ execFileSync \} = .*;$/m,
      "  const execFileSync = globalThis.__syntheticEvalExecFileSync;",
    );
    assert.notEqual(instrumented, helper.REPROVISION_REMOTE_SCRIPT);
    const encoded = Buffer.from(JSON.stringify({
      uid: 247,
      engine: "ccb",
      agentId: "main",
      phase: "overlay",
    })).toString("base64url");
    const argvLength = process.argv.length;
    process.argv.push(encoded);
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await assert.rejects(
        async () => new AsyncFunction(instrumented)(),
        /STOP_AFTER_FIRST_PSQL/,
      );
    } finally {
      process.argv.length = argvLength;
      Reflect.deleteProperty(globalThis, "__syntheticEvalExecFileSync");
    }

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "postgresql://mock",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-F",
      "|",
      "-v",
      "uid=247",
    ]);
    assert.equal(calls[0].args.includes("-c"), false);
    assert.equal(
      calls[0].options.input,
      "SELECT id,email,email_verified,role,status,signal_traffic_class " +
        "FROM users WHERE id=:'uid'::bigint\n",
    );
  });

  test("both remote helpers reject email-verification drift before token use", async () => {
    const encodedReprovision = Buffer.from(JSON.stringify({
      uid: 247,
      engine: "ccb",
      agentId: "main",
      phase: "overlay",
    })).toString("base64url");
    const encodedTurn = Buffer.from(JSON.stringify({
      uid: 247,
      engine: "ccb",
      agentId: "main",
      caseId: "identity-drift",
      pairId: "identity-drift-pair",
      order: "A_FIRST",
      casePackSha: "d".repeat(64),
      prompt: "do not run",
      promptSha: createHash("sha256").update("do not run").digest("hex"),
      model: "glm-5.2",
      timeoutSeconds: 60,
      containerId: "e".repeat(64),
    })).toString("base64url");
    const modules = await Promise.all([
      import(`${pathToFileURL(reprovisionHelper).href}?drift=${Date.now()}`),
      import(`${pathToFileURL(turnHelper).href}?drift=${Date.now()}`),
    ]) as Array<{ REPROVISION_REMOTE_SCRIPT?: string; TURN_REMOTE_SCRIPT?: string }>;
    let psqlCalls = 0;
    let fetchCalls = 0;
    Reflect.set(globalThis, "__syntheticEvalExecFileSync", (
      command: string,
      _args: string[],
      _options: { input?: string },
    ) => {
      if (command === "/bin/bash") {
        return Buffer.from(
          "DATABASE_URL=postgresql://mock\0" +
            "COMMERCIAL_JWT_SECRET=fixed-eval-secret-is-at-least-32-bytes\0",
        );
      }
      assert.equal(command, "psql");
      psqlCalls += 1;
      return "247|v5-canary@claudeai.chat|f|user|active|synthetic_canary\n";
    });
    Reflect.set(globalThis, "__syntheticEvalFetch", async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run after identity drift");
    });
    const argvLength = process.argv.length;
    try {
      for (const [source, encoded] of [
        [modules[0].REPROVISION_REMOTE_SCRIPT, encodedReprovision],
        [modules[1].TURN_REMOTE_SCRIPT, encodedTurn],
      ] as const) {
        assert.equal(typeof source, "string");
        const instrumented = source
          .replace(
            /^  const \{ execFileSync \} = .*;$/m,
            "  const execFileSync = globalThis.__syntheticEvalExecFileSync;",
          )
          .replace(
            /^  const \{ execFileSync, spawn \} = .*;$/m,
            "  const execFileSync = globalThis.__syntheticEvalExecFileSync;\n" +
              "  const spawn = () => { throw new Error('spawn must not run'); };",
          )
          .replaceAll("await fetch(", "await globalThis.__syntheticEvalFetch(");
        process.argv.push(encoded);
        try {
          const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
          await assert.rejects(
            async () => new AsyncFunction(instrumented)(),
            /synthetic user identity differs from the fixed account/,
          );
        } finally {
          process.argv.pop();
        }
      }
    } finally {
      process.argv.length = argvLength;
      Reflect.deleteProperty(globalThis, "__syntheticEvalExecFileSync");
      Reflect.deleteProperty(globalThis, "__syntheticEvalFetch");
    }
    assert.equal(psqlCalls, 2);
    assert.equal(fetchCalls, 0);
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
    const extraPromptPath = join(directory, "extra-prompt.md");
    const containerId = "e".repeat(64);
    const extraPromptBytes = Buffer.from("exact live engine prompt\n");
    const extraPromptSha = createHash("sha256")
      .update(extraPromptBytes)
      .digest("hex");
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
      billing_evidence_at: "2026-07-31T10:00:01.500Z",
      prompt_captured_at: "2026-07-31T10:00:00.750Z",
      wall_ms: 1_250,
      billing_evidence_wait_ms: 250,
      ttft_ms: 500,
      final_text: "done",
      trace_id: traceId,
      cost_request_id: "request-1",
      cost_trace_id: null,
      cost: {
        type: "outbound.cost_charged",
        requestId: "request-1",
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
        usageIds: ["52247"],
        ledgerIds: ["57327"],
      },
      extra_prompt: {
        type: "captured",
        schemaVersion: 1,
        containerId,
        engine: "ccb",
        sessionKey: `agent:research-assistant:webchat:dm:${peerId}`,
        path: "/tmp/oc-eval/extra-prompt.md",
        bytes: extraPromptBytes.length,
        sha256: extraPromptSha,
        candidateCount: 1,
        selection: "exact-session-process",
        processes: [{
          pid: 42,
          startTime: "12345",
          cmdlineSha256: "c".repeat(64),
          aliveAtOpen: true,
          aliveAfter: false,
        }],
        contentBase64: extraPromptBytes.toString("base64"),
      },
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
      OC_SYNTHETIC_EVAL_EXTRA_PROMPT_PATH: extraPromptPath,
      OC_SYNTHETIC_EVAL_CONTAINER_ID: containerId,
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
    assert.equal(statSync(extraPromptPath).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(extraPromptPath), extraPromptBytes);

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
    assert.equal(turn.billing_binding.mode, "ccb_authority_dispatch_attempt");
    assert.equal(turn.cost_trace_id, null);
    assert.equal(turn.extra_prompt.captured_path, extraPromptPath);
    assert.equal(turn.extra_prompt.sha256, extraPromptSha);
    assert.equal(turn.extra_prompt.processes[0].aliveAfter, false);
    assert.equal("contentBase64" in turn.extra_prompt, false);

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
        OC_SYNTHETIC_EVAL_EXTRA_PROMPT_PATH: join(
          directory,
          "invalid-extra-prompt.md",
        ),
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

    const corruptPromptPath = join(directory, "corrupt-extra-prompt.md");
    const corruptPrompt = spawnSync(process.execPath, [turnHelper], {
      encoding: "utf8",
      env: {
        ...env,
        OC_SYNTHETIC_EVAL_TURN_PATH: join(directory, "corrupt-turn.json"),
        OC_SYNTHETIC_EVAL_FRAMES_PATH: join(directory, "corrupt-frames.json"),
        OC_SYNTHETIC_EVAL_EXTRA_PROMPT_PATH: corruptPromptPath,
        FAKE_SSH_OUTPUT: JSON.stringify({
          ...remote,
          extra_prompt: {
            ...remote.extra_prompt,
            contentBase64: Buffer.from("wrong bytes").toString("base64"),
          },
        }),
      },
    });
    assert.notEqual(corruptPrompt.status, 0);
    assert.match(corruptPrompt.stderr, /extra-prompt bytes|corrupt|invalid/);
    assert.equal(existsSync(corruptPromptPath), false);
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

  test("CCB remote turn completes on authority-bound upstream cost without trace equality", async () => {
    const helper = await import(
      `${pathToFileURL(turnHelper).href}?ccb-binding=${Date.now()}`
    ) as { TURN_REMOTE_SCRIPT: string };
    const traceId = "a".repeat(32);
    const dispatchBillingId = "d".repeat(32);
    const authorityTurnId = "b".repeat(32);
    const dispatchId = "50af992a-0bca-4e19-ba11-24df12de0bed";
    const usageRequestId = "upstream-request-1";
    let bindingVariant:
      | "exact"
      | "missing_dispatch"
      | "missing_authority"
      | "nonterminal_missing_authority"
      | "terminal_failed" = "exact";
    let bindingQueries = 0;
    const jwtSecret = "fixed-eval-secret-is-at-least-32-bytes";
    const execFileSync = (
      command: string,
      args: string[],
      options: { input?: string },
    ): Buffer | string => {
      if (command === "/bin/bash") {
        return Buffer.from(
          `DATABASE_URL=postgresql://mock\0COMMERCIAL_JWT_SECRET=${jwtSecret}\0`,
        );
      }
      assert.equal(command, "psql");
      if (args.includes("-c")) return "stable|B||0\n";
      if (options.input?.includes("FROM users WHERE")) {
        return "247|v5-canary@claudeai.chat|t|user|active|synthetic_canary\n";
      }
      bindingQueries += 1;
      assert.match(options.input ?? "", /authority_turn_dispatches/);
      const variables = Object.fromEntries(
        args.flatMap((value, index) =>
          args[index - 1] === "-v" && value.includes("=")
            ? [value.split(/=(.*)/s).slice(0, 2)]
            : []
        ),
      );
      return `${JSON.stringify({
        dispatchCount: bindingVariant === "missing_dispatch" ? 0 : 1,
        dispatch: bindingVariant === "missing_dispatch" ? null : {
          dispatch_id: dispatchId,
          user_id: 247,
          session_id: variables.peer,
          client_message_id: variables.client_message_id,
          agent_id: "main",
          model: "glm-5.2",
          billing_request_id: dispatchBillingId,
          attempt_no: 1,
          status: bindingVariant === "nonterminal_missing_authority"
            ? "admitted"
            : "terminal",
          outcome: bindingVariant === "terminal_failed" ? "failed" : "completed",
        },
        authorityBindings: ["missing_authority", "nonterminal_missing_authority"]
          .includes(bindingVariant) ? [] : [{
          authority_turn_id: authorityTurnId,
          user_id: 247,
          dispatch_model: "glm-5.2",
          canonical_model: "glm-5.2",
          session_id: variables.peer,
          dispatch_id: dispatchId,
          attempt_no: 1,
        }],
        rootTurnKeyCount: 1,
        rootUsage: [{
          id: "52247",
          request_id: usageRequestId,
          model: "glm-5.2",
          status: "success",
          cost_credits: "4",
          ledger_id: "57327",
          turn_key: "c".repeat(64),
          dispatch_id: dispatchId,
          attempt_no: 1,
        }],
        delegateUsage: [],
        ledger: [{
          id: "57327",
          delta: "-1",
          reason: "chat",
          ref_type: "usage_record",
          ref_id: "52247",
        }, {
          id: "57328",
          delta: "-3",
          reason: "chat",
          ref_type: "usage_record",
          ref_id: "52247",
        }],
      })}\n`;
    };
    const readFileSync = (path: string): string => {
      if (path.endsWith("openclaude.json")) return JSON.stringify({ gateway: { port: 18789 } });
      throw new Error(`unexpected read: ${path}`);
    };
    const containerId = "e".repeat(64);
    const livePrompt = Buffer.from("captured before the engine exits\n");
    let watcherExitCode = 0;
    const spawn = (
      command: string,
      args: string[],
    ): EventEmitter & {
      stdout: EventEmitter & { setEncoding: () => void };
      stderr: EventEmitter & { setEncoding: () => void };
      kill: () => boolean;
    } => {
      assert.equal(command, "docker");
      assert.deepEqual(args.slice(0, 4), ["exec", containerId, "node", "-e"]);
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding: () => void };
        stderr: EventEmitter & { setEncoding: () => void };
        kill: () => boolean;
      };
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
      child.kill = () => true;
      const sessionKey = args[6];
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({
          type: "ready",
          schemaVersion: 1,
          containerId,
          pollMs: 100,
        })}\n${JSON.stringify({
          type: "captured",
          schemaVersion: 1,
          containerId,
          engine: "ccb",
          sessionKey,
          path: "/tmp/turn/extra-prompt.md",
          bytes: livePrompt.length,
          sha256: createHash("sha256").update(livePrompt).digest("hex"),
          candidateCount: 1,
          selection: "exact-session-process",
          processes: [{
            pid: 17,
            startTime: "9001",
            cmdlineSha256: "f".repeat(64),
            aliveAtOpen: true,
            aliveAfter: false,
          }],
          contentBase64: livePrompt.toString("base64"),
        })}\n`);
        child.emit("close", watcherExitCode, null);
      });
      return child;
    };
    let sessionAccessToken = "";
    const fetch = async (
      url: string,
      options?: { headers?: Record<string, string> },
    ): Promise<Record<string, unknown>> => {
      if (url.includes("/api/sessions/")) {
        sessionAccessToken = options?.headers?.authorization?.replace(/^Bearer /, "") ?? "";
        return { ok: true, text: async () => "" };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    type Listener = (event: { data?: string; code?: number }) => void;
    class FakeSocket {
      listeners = new Map<string, Listener[]>();

      constructor() {
        queueMicrotask(() => {
          this.emit("open", {});
          this.emit("message", { data: JSON.stringify({ type: "sys.relay_ready" }) });
        });
      }

      addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type: string, event: { data?: string; code?: number }): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      send(text: string): void {
        const inbound = JSON.parse(text);
        queueMicrotask(() => {
          this.emit("message", { data: JSON.stringify({
            type: "outbound.message",
            peer: inbound.peer,
            blocks: [{ kind: "text", text: "done" }],
            isFinal: true,
            traceId,
          }) });
          this.emit("message", { data: JSON.stringify({
            type: "outbound.cost_charged",
            requestId: usageRequestId,
            model: "glm-5.2",
            costCredits: "4",
          }) });
        });
      }

      close(): void {
        queueMicrotask(() => this.emit("close", { code: 1000 }));
      }
    }
    Reflect.set(globalThis, "__syntheticEvalExecFileSync", execFileSync);
    Reflect.set(globalThis, "__syntheticEvalSpawn", spawn);
    Reflect.set(globalThis, "__syntheticEvalReadFileSync", readFileSync);
    Reflect.set(globalThis, "__syntheticEvalFetch", fetch);
    Reflect.set(globalThis, "WebSocket", FakeSocket);
    const instrumented = helper.TURN_REMOTE_SCRIPT
      .replace(
        /^  const \{ execFileSync, spawn \} = .*;$/m,
        "  const execFileSync = globalThis.__syntheticEvalExecFileSync;\n" +
          "  const spawn = globalThis.__syntheticEvalSpawn;",
      )
      .replace(
        /^  const \{ readFileSync \} = .*;$/m,
        "  const readFileSync = globalThis.__syntheticEvalReadFileSync;",
      )
      .replaceAll("await fetch(", "await globalThis.__syntheticEvalFetch(")
      .replace(
        /  process\.stdout\.write\(`\$\{JSON\.stringify\(result\)\}\\n`\);/,
        "  globalThis.__syntheticEvalResult = result;",
      );
    const encoded = Buffer.from(JSON.stringify({
      uid: 247,
      engine: "ccb",
      agentId: "main",
      caseId: "ccb-binding",
      pairId: "ccb-binding-pair",
      order: "A_FIRST",
      casePackSha: "d".repeat(64),
      prompt: "answer once",
      promptSha: createHash("sha256").update("answer once").digest("hex"),
      model: "glm-5.2",
      timeoutSeconds: 60,
      containerId,
    })).toString("base64url");
    const argvLength = process.argv.length;
    process.argv.push(encoded);
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      const execute = new AsyncFunction(instrumented);
      await execute();
      const result = Reflect.get(globalThis, "__syntheticEvalResult") as Record<string, any>;
      assert.equal(result.trace_id, traceId);
      assert.equal(result.cost_request_id, usageRequestId);
      assert.equal(result.cost_trace_id, null);
      assert.equal(result.billing_binding.mode, "ccb_authority_dispatch_attempt");
      assert.equal(result.billing_binding.finalTraceId, traceId);
      assert.equal(
        result.billing_binding.dispatchBillingRequestId,
        dispatchBillingId,
      );
      assert.equal(result.billing_binding.authorityTurnId, authorityTurnId);
      assert.deepEqual(result.billing_binding.ledgerIds, ["57327", "57328"]);
      assert.equal(result.runtime.binding_queries, 1);
      assert.equal(result.runtime.login_requests, 0);
      assert.equal(result.runtime.user_access_token_issues, 1);
      assert.equal(result.runtime.admin_access_token_issues, 0);
      assert.equal(result.runtime.matching_costs, 1);
      assert.equal(result.runtime.prompt_watchers, 1);
      assert.equal(result.runtime.prompt_ready, 1);
      assert.equal(result.runtime.prompt_captures, 1);
      assert.equal(result.extra_prompt.processes[0].aliveAfter, false);
      assert.ok(result.billing_evidence_wait_ms < 1_000);
      const claims = await verifyAccess(sessionAccessToken, jwtSecret);
      assert.equal(claims.sub, "247");
      assert.equal(claims.role, "user");

      watcherExitCode = 1;
      await assert.rejects(
        () => execute(),
        /prompt watcher failed/,
      );
      watcherExitCode = 0;

      bindingVariant = "missing_dispatch";
      const beforeMissingDispatch = bindingQueries;
      await assert.rejects(
        () => execute(),
        /dispatch is missing after the final frame/,
      );
      assert.equal(bindingQueries - beforeMissingDispatch, 1);

      bindingVariant = "missing_authority";
      const beforeMissingAuthority = bindingQueries;
      await assert.rejects(
        () => execute(),
        /authority binding is missing after the final frame/,
      );
      assert.equal(bindingQueries - beforeMissingAuthority, 1);

      bindingVariant = "nonterminal_missing_authority";
      const beforeNonterminalConflict = bindingQueries;
      await assert.rejects(
        () => execute(),
        /authority binding is missing after the final frame/,
      );
      assert.equal(bindingQueries - beforeNonterminalConflict, 1);

      bindingVariant = "terminal_failed";
      const beforeTerminalFailure = bindingQueries;
      await assert.rejects(
        () => execute(),
        /terminal dispatch did not complete/,
      );
      assert.equal(bindingQueries - beforeTerminalFailure, 1);
    } finally {
      process.argv.length = argvLength;
      for (const name of [
        "__syntheticEvalExecFileSync",
        "__syntheticEvalSpawn",
        "__syntheticEvalReadFileSync",
        "__syntheticEvalFetch",
        "__syntheticEvalResult",
        "WebSocket",
      ]) Reflect.deleteProperty(globalThis, name);
    }
  });

  test("turn remote contract has one PUT, one WebSocket, and one inbound send", () => {
    const source = readFileSync(turnHelper, "utf8");
    assert.doesNotMatch(source, /api\/auth\/login|passwordFile|turnstile_token/);
    assert.match(
      source,
      /SELECT id,email,email_verified,role,status,signal_traffic_class/,
    );
    assert.match(source, /syntheticIdentity\[2\] !== "t"/);
    assert.equal(source.match(/new WebSocket\(/g)?.length, 1);
    assert.equal(source.match(/method: "PUT"/g)?.length, 1);
    assert.equal(source.match(/type: "inbound\.message"/g)?.length, 1);
    assert.match(source, /clientMessageId,/);
    assert.equal(source.match(/socket\.send\(frame\)/g)?.length, 1);
    assert.match(source, /turn relay closed before final\+cost/);
    assert.match(source, /authority_turn_dispatches/);
    assert.match(source, /d\.attempt_no=u\.attempt_no/);
    const exactDispatchSql = source.slice(
      source.indexOf('"WITH exact_dispatch AS ("'),
      source.indexOf('"),",\n        "authority_binding AS ("'),
    );
    assert.doesNotMatch(exactDispatchSql, /agent_id=|model=/);
    assert.match(source, /value\.dispatch\.agent_id !== config\.agentId/);
    assert.match(source, /authority\.dispatch_model !== value\.dispatch\.model/);
    assert.doesNotMatch(source, /billing_request_id !== turnTraceId/);
    assert.match(source, /ccb_authority_dispatch_attempt/);
    assert.match(source, /codex_server_trace/);
    assert.match(source, /CCB final billing evidence did not become exact in 60s/);
    assert.match(source, /socket\.addEventListener\("close"/);
    assert.match(source, /connection\.closes \+= 1/);
    assert.match(source, /runtime\.finals !== 1/);
    assert.match(source, /Atomics\.wait\(sleepView,0,0,100\)/);
    assert.match(source, /type:"ready",schemaVersion:1,containerId,pollMs:100/);
    assert.match(source, /fs\.constants\.O_RDONLY\|fs\.constants\.O_NOFOLLOW/);
    assert.match(source, /const before=fs\.fstatSync\(fd\)/);
    assert.match(source, /const after=fs\.fstatSync\(fd\)/);
    assert.match(source, /promptPaths\.size!==1/);
    assert.match(source, /candidate\.sessionKey!==sessionKey/);
    assert.ok(
      source.indexOf("promptWatcher.ready.then")
        < source.indexOf("socket.send(frame)"),
      "the exact watcher READY gate precedes the one inbound send",
    );
    assert.match(source, /billingEvidenceAtMs = Date\.now\(\)/);
    assert.match(source, /promptCapturedAtMs = Date\.now\(\)/);
    assert.match(source, /billingEvidenceAtMs === null[\s\S]*promptCapturedAtMs === null/);
    assert.match(source, /openSync\(path, "wx"/);
    assert.ok(
      (source.match(/fsyncDirectory\(parent\)/g) ?? []).length >= 2,
      "prompt publication fsyncs the directory before and after temp cleanup",
    );
    for (const imported of source.matchAll(/from "([^"]+)"/g)) {
      assert.match(imported[1], /^node:/);
    }
  });
});
