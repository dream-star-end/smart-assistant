#!/usr/bin/env node
/**
 * Cold-reprovision one fixed synthetic evaluation account.
 *
 * This local helper has no mutable dependency tree. It starts exactly one
 * foreground ssh process to kl-mirror and feeds it the fixed Node script
 * below. The remote script performs exactly one supported admin restart API
 * call, then waits for the user relay to become ready. A supported restart is
 * asynchronous, so the relay may answer with the normal 4503
 * `starting`/`provisioning` contract before `sys.relay_ready`. The helper
 * follows only that bounded readiness contract and never sends a turn.
 */

import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

const SYNTHETIC_USERS = new Map([
  [247, {
    email: "v5-canary@claudeai.chat",
    trafficClass: "synthetic_canary",
  }],
  [626, {
    email: "v5-evals@claudeai.chat",
    trafficClass: "e2e",
  }],
]);
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

export function readReprovisionIdentity() {
  const rawUid = requiredEnv("OC_SYNTHETIC_EVAL_UID");
  if (!/^[1-9][0-9]*$/.test(rawUid)) {
    throw new Error("OC_SYNTHETIC_EVAL_UID must be a decimal synthetic uid");
  }
  const uid = Number(rawUid);
  if (!Number.isSafeInteger(uid) || !SYNTHETIC_USERS.has(uid)) {
    throw new Error("OC_SYNTHETIC_EVAL_UID must be one of 247,626");
  }
  const engine = requiredEnv("OC_SYNTHETIC_EVAL_ENGINE");
  if (!["ccb", "codex"].includes(engine)) {
    throw new Error("OC_SYNTHETIC_EVAL_ENGINE must be ccb or codex");
  }
  const agentId = requiredEnv("OC_SYNTHETIC_EVAL_AGENT_ID");
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error("OC_SYNTHETIC_EVAL_AGENT_ID is invalid");
  }
  const phase = requiredEnv("OC_SYNTHETIC_EVAL_PHASE");
  if (!["overlay", "restore"].includes(phase)) {
    throw new Error("OC_SYNTHETIC_EVAL_PHASE must be overlay or restore");
  }
  return { uid, engine, agentId, phase };
}

export function issueSyntheticUserAccessToken(
  uid,
  secret,
  now,
  createHmacFn = createHmac,
  randomBytesFn = randomBytes,
) {
  if (!Number.isSafeInteger(uid) || ![247, 626].includes(uid)) {
    throw new Error("synthetic access token uid is invalid");
  }
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("commercial JWT secret must be at least 32 UTF-8 bytes");
  }
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error("synthetic access token time is invalid");
  }
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    role: "user",
    sub: String(uid),
    iat: now,
    exp: now + 900,
    jti: randomBytesFn(16).toString("hex"),
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmacFn("sha256", secret)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

export async function waitForFreshRelay(
  url,
  accessToken,
  {
    WebSocketCtor = WebSocket,
    timeoutMs = 140_000,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("fresh relay did not become ready in 140s");
    }
    const outcome = await new Promise((resolve) => {
      const socket = new WebSocketCtor(url, ["bearer", accessToken]);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          socket.close();
        } finally {
          finish({ type: "timeout" });
        }
      }, remainingMs);
      socket.addEventListener("message", (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (frame?.type === "sys.relay_ready") {
          try {
            socket.close(1000, "relay verified");
          } finally {
            finish({ type: "ready" });
          }
        } else if (
          ["outbound.error", "outbound.turn_error", "error"].includes(frame?.type)
        ) {
          try {
            socket.close();
          } finally {
            finish({ type: "error", frame });
          }
        }
      });
      socket.addEventListener("error", () => {
        try {
          socket.close();
        } finally {
          finish({ type: "socket-error" });
        }
      });
      socket.addEventListener("close", (event) => {
        finish({ type: "close", code: event.code, reason: event.reason });
      });
    });

    if (outcome.type === "ready") return;
    if (outcome.type === "timeout") {
      throw new Error("fresh relay did not become ready in 140s");
    }
    if (outcome.type === "error") {
      throw new Error(
        `fresh relay returned an error: ${JSON.stringify(outcome.frame).slice(0, 500)}`,
      );
    }
    if (outcome.type === "socket-error") {
      throw new Error("fresh relay WebSocket failed");
    }

    let close;
    try {
      close = JSON.parse(outcome.reason);
    } catch {
      throw new Error(`fresh relay closed before ready (${outcome.code})`);
    }
    if (
      outcome.code !== 4503
      || !["starting", "provisioning"].includes(close?.reason)
      || !Number.isFinite(close?.retryAfterSec)
      || close.retryAfterSec <= 0
    ) {
      throw new Error(`fresh relay closed before ready (${outcome.code})`);
    }
    const delayMs = Math.min(
      Math.max(1_000, close.retryAfterSec * 1_000),
      60_000,
      deadline - Date.now(),
    );
    if (delayMs <= 0) {
      throw new Error("fresh relay did not become ready in 140s");
    }
    await sleep(delayMs);
  }
}

async function remoteReprovision(
  encodedConfig,
  waitForFreshRelay,
  issueSyntheticUserAccessToken,
) {
  const { execFileSync } = await import("node:child_process");
  const { createHmac, randomBytes } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");

  const config = JSON.parse(
    Buffer.from(encodedConfig, "base64url").toString("utf8"),
  );
  const users = {
    247: {
      email: "v5-canary@claudeai.chat",
      trafficClass: "synthetic_canary",
    },
    626: {
      email: "v5-evals@claudeai.chat",
      trafficClass: "e2e",
    },
  };
  if (
    !Number.isSafeInteger(config.uid)
    || users[config.uid] === undefined
    || !["ccb", "codex"].includes(config.engine)
    || !/^[A-Za-z0-9_-]{1,80}$/.test(config.agentId ?? "")
    || !["overlay", "restore"].includes(config.phase)
  ) {
    throw new Error("remote synthetic reprovision identity is invalid");
  }

  const serviceEnvironmentBytes = execFileSync(
    "/bin/bash",
    [
      "-lc",
      "set -a; source /etc/openclaude/commercial-v5.env; set +a; exec /usr/bin/env -0",
    ],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
  );
  const serviceEnvironment = {};
  for (const entry of serviceEnvironmentBytes.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      serviceEnvironment[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  const commandEnvironment = { ...process.env, ...serviceEnvironment };
  if (!commandEnvironment.DATABASE_URL || !commandEnvironment.COMMERCIAL_JWT_SECRET) {
    throw new Error("commercial service environment is incomplete");
  }

  const query = (sql, variables = []) =>
    execFileSync(
      "psql",
      [
        commandEnvironment.DATABASE_URL,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-F",
        "|",
        ...variables.flatMap(([name, value]) => ["-v", `${name}=${value}`]),
      ],
      {
        encoding: "utf8",
        env: commandEnvironment,
        input: `${sql}\n`,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).trim();
  const oneRow = (output, label) => {
    const rows = output.split("\n").filter(Boolean);
    if (rows.length !== 1) throw new Error(`${label} must contain exactly one row`);
    return rows[0];
  };
  const readJson = (command, args) =>
    JSON.parse(execFileSync(command, args, {
      encoding: "utf8",
      env: commandEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    }));

  const user = users[config.uid];
  const syntheticIdentity = oneRow(
    query(
      "SELECT id,email,email_verified,role,status,signal_traffic_class " +
        "FROM users WHERE id=:'uid'::bigint",
      [["uid", config.uid]],
    ),
    "synthetic user identity",
  ).split("|");
  if (
    syntheticIdentity.length !== 6
    || syntheticIdentity[0] !== String(config.uid)
    || syntheticIdentity[1] !== user.email
    || syntheticIdentity[2] !== "t"
    || syntheticIdentity[3] !== "user"
    || syntheticIdentity[4] !== "active"
    || syntheticIdentity[5] !== user.trafficClass
  ) {
    throw new Error("synthetic user identity differs from the fixed account");
  }
  const [rowId, databaseContainerId] = oneRow(
    query(
      "SELECT id,container_internal_id FROM agent_containers " +
        "WHERE user_id=:'uid'::bigint AND state='active' AND runtime_channel='v5' " +
        "ORDER BY id DESC",
      [["uid", config.uid]],
    ),
    "active synthetic container",
  ).split("|");
  if (!/^[1-9][0-9]*$/.test(rowId ?? "") || !/^[0-9a-f]{64}$/.test(databaseContainerId ?? "")) {
    throw new Error("active synthetic container row is invalid");
  }
  const containerName = `oc-v5-u${config.uid}`;
  const beforeInspect = readJson("docker", ["inspect", containerName]);
  if (
    !Array.isArray(beforeInspect)
    || beforeInspect.length !== 1
    || beforeInspect[0]?.Id !== databaseContainerId
  ) {
    throw new Error("active synthetic Docker identity differs from the database");
  }
  const oldContainerId = beforeInspect[0].Id;
  const activeDispatches = oneRow(
    query(
      "SELECT count(*) FROM turn_dispatches " +
        "WHERE user_id=:'uid'::bigint AND status IN ('admitted','accepted','rejecting')",
      [["uid", config.uid]],
    ),
    "active dispatch count",
  );
  if (activeDispatches !== "0") {
    throw new Error("synthetic user has an active turn");
  }

  const [phase, activeSlot, candidateSlot, cohortPercent] = oneRow(
    query(
      "SELECT phase,active_slot,coalesce(candidate_slot,''),cohort_percent " +
        "FROM deploy_state WHERE singleton=true",
    ),
    "deploy state",
  ).split("|");
  if (
    phase !== "stable"
    || !["A", "B"].includes(activeSlot)
    || candidateSlot !== ""
    || cohortPercent !== "0"
  ) {
    throw new Error("production lane is not exact stable cohort-zero");
  }
  const activeHome = activeSlot === "A"
    ? "/root/.openclaude-v5"
    : "/root/.openclaude-v5-b";
  const activePort = JSON.parse(
    readFileSync(`${activeHome}/openclaude.json`, "utf8"),
  )?.gateway?.port;
  if (!Number.isSafeInteger(activePort) || activePort <= 0 || activePort > 65535) {
    throw new Error("active V5 gateway port is invalid");
  }
  const base = `http://127.0.0.1:${activePort}`;

  const runtime = {
    login_requests: 0,
    user_access_token_issues: 0,
    admin_access_token_issues: 0,
  };
  const now = Math.floor(Date.now() / 1000);
  runtime.user_access_token_issues += 1;
  const accessToken = issueSyntheticUserAccessToken(
    config.uid,
    commandEnvironment.COMMERCIAL_JWT_SECRET,
    now,
    createHmac,
    randomBytes,
  );
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    role: "admin",
    sub: "1",
    iat: now,
    exp: now + 300,
    jti: randomBytes(16).toString("hex"),
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac(
    "sha256",
    commandEnvironment.COMMERCIAL_JWT_SECRET,
  ).update(unsigned).digest("base64url");
  runtime.admin_access_token_issues += 1;
  const adminToken = `${unsigned}.${signature}`;

  // The sole container mutation in this helper.
  const restart = await fetch(
    `${base}/api/admin/agent-containers/${rowId}/restart`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
        "user-agent": "v5-synthetic-exact-eval",
      },
      body: "{}",
    },
  );
  if (!restart.ok) {
    throw new Error(`supported admin restart failed ${restart.status}: ${(await restart.text()).slice(0, 200)}`);
  }

  await waitForFreshRelay(
    `${base.replace(/^http/, "ws")}/ws/user-chat-bridge`,
    accessToken,
  );

  let afterInspect;
  let databaseIdentity;
  const inspectDeadline = Date.now() + 10_000;
  for (;;) {
    try {
      afterInspect = readJson("docker", ["inspect", containerName]);
      databaseIdentity = oneRow(
        query(
          "SELECT container_internal_id FROM agent_containers " +
            "WHERE user_id=:'uid'::bigint AND state='active' AND runtime_channel='v5'",
          [["uid", config.uid]],
        ),
        "fresh active synthetic container",
      );
      if (
        Array.isArray(afterInspect)
        && afterInspect.length === 1
        && afterInspect[0]?.Id === databaseIdentity
        && databaseIdentity !== oldContainerId
      ) {
        break;
      }
    } catch (error) {
      if (Date.now() >= inspectDeadline) throw error;
    }
    if (Date.now() >= inspectDeadline) {
      throw new Error("fresh relay Docker/database identity did not converge");
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  const startedAt = afterInspect[0]?.State?.StartedAt;
  if (
    !/^[0-9a-f]{64}$/.test(databaseIdentity)
    || typeof startedAt !== "string"
    || !Number.isFinite(Date.parse(startedAt))
  ) {
    throw new Error("fresh synthetic container evidence is invalid");
  }
  process.stdout.write(`${JSON.stringify({
    id: databaseIdentity,
    started_at: startedAt,
    runtime,
  })}\n`);
}

export const REPROVISION_REMOTE_SCRIPT =
  `const waitForFreshRelay = ${waitForFreshRelay.toString()};\n` +
  `const issueSyntheticUserAccessToken = ${issueSyntheticUserAccessToken.toString()};\n` +
  `await (${remoteReprovision.toString()})(process.argv.at(-1), waitForFreshRelay, issueSyntheticUserAccessToken);\n`;

export function parseReprovisionOutput(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("remote reprovision must output exactly one JSON line");
  }
  const value = JSON.parse(lines[0]);
  if (
    !value
    || typeof value !== "object"
    || Object.keys(value).sort().join(",") !== "id,runtime,started_at"
    || !CONTAINER_ID_RE.test(value.id ?? "")
    || typeof value.started_at !== "string"
    || !Number.isFinite(Date.parse(value.started_at))
    || !value.runtime
    || typeof value.runtime !== "object"
    || Object.keys(value.runtime).sort().join(",")
      !== "admin_access_token_issues,login_requests,user_access_token_issues"
    || value.runtime.login_requests !== 0
    || value.runtime.user_access_token_issues !== 1
    || value.runtime.admin_access_token_issues !== 1
  ) {
    throw new Error("remote reprovision output is invalid");
  }
  return value;
}

export function main() {
  const identity = readReprovisionIdentity();
  const sshBinary = process.env.OC_SYNTHETIC_EVAL_SSH_BINARY?.trim() || "ssh";
  if (!sshBinary || sshBinary.includes("\0")) {
    throw new Error("OC_SYNTHETIC_EVAL_SSH_BINARY is invalid");
  }
  const encoded = Buffer.from(JSON.stringify(identity)).toString("base64url");
  const result = spawnSync(
    sshBinary,
    [
      "kl-mirror",
      "node",
      "--experimental-websocket",
      "--input-type=module",
      "-",
      encoded,
    ],
    {
      input: REPROVISION_REMOTE_SCRIPT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `synthetic reprovision ssh failed (${result.status}): ${
        result.stderr || result.stdout
      }`.trim(),
    );
  }
  const value = parseReprovisionOutput(result.stdout);
  process.stdout.write(`${JSON.stringify({
    id: value.id,
    started_at: value.started_at,
  })}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
