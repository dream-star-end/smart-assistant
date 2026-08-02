#!/usr/bin/env node
/**
 * Execute and capture exactly one synthetic foreground turn.
 *
 * The local helper validates runner-bound case/prompt/output identities before
 * opening exactly one foreground ssh process to kl-mirror. The fixed remote
 * Node script issues one fixed synthetic-user token, performs one session PUT,
 * one relay WebSocket, and one `inbound.message`. A disconnect, error, missing
 * final, or missing cost frame
 * fails without retry.
 */

import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

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
const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{8,160}$/;
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

function requiredEnv(name, trim = true) {
  const raw = process.env[name];
  const value = trim ? raw?.trim() : raw;
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

function absoluteNormalizedPath(name) {
  const value = requiredEnv(name);
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return value;
}

function assertSecureOutput(path) {
  const parent = dirname(path);
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== process.geteuid()
    || (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(`${parent} must be a real current-user-owned 0700 directory`);
  }
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing output ${path}`);
}

export function readTurnInputs() {
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
  if (requiredEnv("OC_SYNTHETIC_EVAL_PHASE") !== "turn") {
    throw new Error("OC_SYNTHETIC_EVAL_PHASE must be turn");
  }
  const caseId = requiredEnv("OC_SYNTHETIC_EVAL_CASE_ID");
  if (!CASE_ID_RE.test(caseId)) {
    throw new Error("OC_SYNTHETIC_EVAL_CASE_ID is invalid");
  }
  const pairId = requiredEnv("OC_SYNTHETIC_EVAL_PAIR_ID");
  if (!CASE_ID_RE.test(pairId)) {
    throw new Error("OC_SYNTHETIC_EVAL_PAIR_ID is invalid");
  }
  const order = requiredEnv("OC_SYNTHETIC_EVAL_ORDER");
  if (!["A_FIRST", "B_FIRST"].includes(order)) {
    throw new Error("OC_SYNTHETIC_EVAL_ORDER must be A_FIRST or B_FIRST");
  }
  const casePackSha = requiredEnv("OC_SYNTHETIC_EVAL_CASE_PACK_SHA");
  if (!SHA256_RE.test(casePackSha)) {
    throw new Error("OC_SYNTHETIC_EVAL_CASE_PACK_SHA must be a SHA-256");
  }
  const prompt = requiredEnv("OC_SYNTHETIC_EVAL_PROMPT", false);
  const promptSha = requiredEnv("OC_SYNTHETIC_EVAL_PROMPT_SHA");
  if (
    !SHA256_RE.test(promptSha)
    || createHash("sha256").update(prompt).digest("hex") !== promptSha
  ) {
    throw new Error("OC_SYNTHETIC_EVAL_PROMPT_SHA differs from exact prompt bytes");
  }
  const model = requiredEnv("OC_SYNTHETIC_EVAL_MODEL");
  if (!MODEL_RE.test(model)) {
    throw new Error("OC_SYNTHETIC_EVAL_MODEL is invalid");
  }
  const timeoutSeconds = Number(
    process.env.OC_SYNTHETIC_EVAL_TIMEOUT_SECONDS ?? "900",
  );
  if (
    !Number.isSafeInteger(timeoutSeconds)
    || timeoutSeconds < 60
    || timeoutSeconds > 1_050
  ) {
    throw new Error("OC_SYNTHETIC_EVAL_TIMEOUT_SECONDS must be 60..1050");
  }
  const turnPath = absoluteNormalizedPath("OC_SYNTHETIC_EVAL_TURN_PATH");
  const framesPath = absoluteNormalizedPath("OC_SYNTHETIC_EVAL_FRAMES_PATH");
  const extraPromptPath = absoluteNormalizedPath(
    "OC_SYNTHETIC_EVAL_EXTRA_PROMPT_PATH",
  );
  if (new Set([turnPath, framesPath, extraPromptPath]).size !== 3) {
    throw new Error("turn, frames, and extra-prompt output paths must be distinct");
  }
  assertSecureOutput(turnPath);
  assertSecureOutput(framesPath);
  assertSecureOutput(extraPromptPath);
  const containerId = requiredEnv("OC_SYNTHETIC_EVAL_CONTAINER_ID");
  if (!CONTAINER_ID_RE.test(containerId)) {
    throw new Error("OC_SYNTHETIC_EVAL_CONTAINER_ID must be a 64-hex Docker ID");
  }
  return {
    uid,
    engine,
    agentId,
    caseId,
    pairId,
    order,
    casePackSha,
    prompt,
    promptSha,
    model,
    timeoutSeconds,
    turnPath,
    framesPath,
    extraPromptPath,
    containerId,
  };
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

async function remoteTurn(encodedConfig, issueSyntheticUserAccessToken) {
  const { execFileSync, spawn } = await import("node:child_process");
  const { createHash, createHmac, randomBytes } = await import("node:crypto");
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
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(config.caseId ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(config.pairId ?? "")
    || !["A_FIRST", "B_FIRST"].includes(config.order)
    || !/^[0-9a-f]{64}$/.test(config.casePackSha ?? "")
    || typeof config.prompt !== "string"
    || !/^[0-9a-f]{64}$/.test(config.promptSha ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(config.model ?? "")
    || !/^[0-9a-f]{64}$/.test(config.containerId ?? "")
    || !Number.isSafeInteger(config.timeoutSeconds)
    || config.timeoutSeconds < 60
    || config.timeoutSeconds > 1_050
  ) {
    throw new Error("remote synthetic turn identity is invalid");
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
  const lane = execFileSync(
    "psql",
    [
      commandEnvironment.DATABASE_URL,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-F",
      "|",
      "-c",
      "SELECT phase,active_slot,coalesce(candidate_slot,''),cohort_percent " +
        "FROM deploy_state WHERE singleton=true",
    ],
    {
      encoding: "utf8",
      env: commandEnvironment,
      maxBuffer: 1024 * 1024,
    },
  ).trim().split("\n").filter(Boolean);
  if (lane.length !== 1) throw new Error("deploy state must contain exactly one row");
  const [phase, activeSlot, candidateSlot, cohortPercent] = lane[0].split("|");
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
    session_puts: 0,
    websocket_instances: 0,
    inbound_messages: 0,
    finals: 0,
    matching_costs: 0,
    binding_queries: 0,
    prompt_watchers: 0,
    prompt_ready: 0,
    prompt_captures: 0,
  };
  runtime.user_access_token_issues += 1;
  const accessToken = issueSyntheticUserAccessToken(
    config.uid,
    commandEnvironment.COMMERCIAL_JWT_SECRET,
    Math.floor(Date.now() / 1000),
    createHmac,
    randomBytes,
  );

  const peerId = `eval${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
  const clientMessageId =
    `evalmsg_${Date.now().toString(36)}_${randomBytes(12).toString("hex")}`;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId)) {
    throw new Error("synthetic client message identity is invalid");
  }
  runtime.session_puts += 1;
  const put = await fetch(`${base}/api/sessions/${peerId}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agentId: config.agentId,
      title: `exact eval ${config.caseId}`,
      modelId: config.model,
      messages: [],
    }),
  });
  if (!put.ok) {
    throw new Error(`synthetic session PUT failed ${put.status}: ${(await put.text()).slice(0, 200)}`);
  }

  const sessionKey = `agent:${config.agentId}:webchat:dm:${peerId}`;
  const promptWatcherSource = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { createHash } = require("node:crypto");',
    'const [engine,sessionKey,containerId,timeoutText] = process.argv.slice(1);',
    'if(!["ccb","codex"].includes(engine)||!/^agent:[A-Za-z0-9_-]+:webchat:dm:[A-Za-z0-9_-]{8,160}$/.test(sessionKey)||!/^[0-9a-f]{64}$/.test(containerId)||!/^[1-9][0-9]*$/.test(timeoutText))throw new Error("invalid prompt watcher identity");',
    'const timeoutMs=Number(timeoutText);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<60000||timeoutMs>1050000)throw new Error("invalid prompt watcher timeout");',
    'const sha=(value)=>createHash("sha256").update(value).digest("hex");',
    'const sleepView=new Int32Array(new SharedArrayBuffer(4));',
    'const sleep=()=>Atomics.wait(sleepView,0,0,100);',
    'const processStart=(pid)=>fs.readFileSync("/proc/"+pid+"/stat","utf8").split(" ")[21];',
    'const parseEnv=(pid)=>Object.fromEntries(fs.readFileSync("/proc/"+pid+"/environ").toString("utf8").split("\\0").filter(Boolean).map((entry)=>{const index=entry.indexOf("=");return index<0?[entry,""]:[entry.slice(0,index),entry.slice(index+1)]}));',
    'const promptSettings=(args)=>{const values=[];for(let index=0;index<args.length-1;index++){if(args[index]!=="-c"||!args[index+1].startsWith("model_instructions_file="))continue;let value=args[index+1].slice("model_instructions_file=".length);if(value.startsWith("\\\""))value=JSON.parse(value);values.push(value)}return values};',
    'const codexSessions=(args)=>{const values=[];for(const arg of args){if(!arg.startsWith("mcp_servers.openclaude_memory.env="))continue;for(const match of arg.matchAll(/"OPENCLAUDE_SESSION_KEY"="([^"]+)"/g))values.push(match[1])}return values};',
    'process.stdout.write(JSON.stringify({type:"ready",schemaVersion:1,containerId,pollMs:100})+"\\n");',
    'const deadline=Date.now()+timeoutMs;let captureComplete=false;',
    'captureLoop: while(Date.now()<deadline){',
    ' const candidates=[];',
    ' for(const name of fs.readdirSync("/proc")){',
    '  if(!/^[0-9]+$/.test(name))continue;const root="/proc/"+name;',
    '  try{',
    '   const args=fs.readFileSync(root+"/cmdline").toString("utf8").split("\\0").filter(Boolean);',
    '   if(engine==="ccb"){',
    '    if(!args.includes("--append-system-prompt-file"))continue;',
    '    const env=parseEnv(name);if(env.OPENCLAUDE_SESSION_KEY!==sessionKey)continue;',
    '    const indexes=[];for(let index=0;index<args.length;index++)if(args[index]==="--append-system-prompt-file")indexes.push(index);',
    '    if(indexes.length!==1||typeof args[indexes[0]+1]!=="string")throw new Error("session-bound CCB prompt argv is ambiguous");',
    '    candidates.push({pid:Number(name),startTime:processStart(name),args,promptPath:args[indexes[0]+1],sessionKey});',
    '   }else{',
    '    if(!args.includes("app-server"))continue;',
    '    const prompts=promptSettings(args);const sessions=codexSessions(args);',
    '    if(prompts.length!==1||sessions.length!==1)throw new Error("Codex app-server prompt/session argv is ambiguous");',
    '    candidates.push({pid:Number(name),startTime:processStart(name),args,promptPath:prompts[0],sessionKey:sessions[0]});',
    '   }',
    '  }catch(error){if(error&&["ENOENT","ESRCH"].includes(error.code))continue;throw error}',
    ' }',
    ' if(engine==="ccb"&&candidates.length>1)throw new Error("expected one session-bound CCB process, got "+candidates.length);',
    ' if(candidates.length===0){sleep();continue}',
    ' if(candidates.some((candidate)=>candidate.sessionKey!==sessionKey))throw new Error("fresh container has a Codex app-server for another session");',
    ' const promptPaths=new Set();',
    ' for(const candidate of candidates){if(typeof candidate.promptPath!=="string"||!path.isAbsolute(candidate.promptPath)||path.resolve(candidate.promptPath)!==candidate.promptPath||path.basename(candidate.promptPath)!=="extra-prompt.md")throw new Error("invalid extra prompt path");const real=fs.realpathSync(candidate.promptPath);if(real!==candidate.promptPath)throw new Error("extra prompt path is not canonical");promptPaths.add(real)}',
    ' if(promptPaths.size!==1)throw new Error("session-bound engine processes use multiple prompt paths");',
    ' const promptPath=[...promptPaths][0];let fd;',
    ' try{fd=fs.openSync(promptPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)}catch(error){if(error&&["ENOENT","ESRCH"].includes(error.code)){sleep();continue}throw error}',
    ' try{',
    '  const before=fs.fstatSync(fd);if(!before.isFile()||before.size>2097152)throw new Error("extra prompt is not a bounded regular file");',
    '  const livePids=new Set();for(const candidate of candidates){try{if(processStart(candidate.pid)!==candidate.startTime)throw new Error("engine process identity changed before prompt capture");livePids.add(candidate.pid)}catch(error){if(!error||!["ENOENT","ESRCH"].includes(error.code))throw error}}',
    '  if(livePids.size<1){fs.closeSync(fd);fd=undefined;sleep();continue}',
    '  const bytes=fs.readFileSync(fd);const after=fs.fstatSync(fd);',
    '  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==after.size)throw new Error("extra prompt file changed while reading exact fd");',
    '  const processes=candidates.map((candidate)=>{let aliveAfter=false;try{aliveAfter=processStart(candidate.pid)===candidate.startTime}catch(error){if(!error||!["ENOENT","ESRCH"].includes(error.code))throw error}return {pid:candidate.pid,startTime:candidate.startTime,cmdlineSha256:sha(Buffer.from(candidate.args.join("\\0")+"\\0")),aliveAtOpen:livePids.has(candidate.pid),aliveAfter}}).sort((left,right)=>left.pid-right.pid);',
    '  process.stdout.write(JSON.stringify({type:"captured",schemaVersion:1,containerId,engine,sessionKey,path:promptPath,bytes:bytes.length,sha256:sha(bytes),candidateCount:processes.length,selection:engine==="ccb"?"exact-session-process":"exact-session-unique-prompt-path",processes,contentBase64:bytes.toString("base64")})+"\\n");',
    '  captureComplete=true;break captureLoop;',
    ' }finally{if(fd!==undefined)fs.closeSync(fd)}',
    '}',
    'if(!captureComplete)throw new Error("session-bound extra prompt did not appear before watcher deadline");',
  ].join("\n");

  function startPromptWatcher() {
    runtime.prompt_watchers += 1;
    const child = spawn(
      "docker",
      [
        "exec",
        config.containerId,
        "node",
        "-e",
        promptWatcherSource,
        config.engine,
        sessionKey,
        config.containerId,
        String(config.timeoutSeconds * 1_000),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let readyDone = false;
    let captureSeen = false;
    let captureSettled = false;
    let captureEvent = null;
    let exited = false;
    let resolveReady;
    let rejectReady;
    let resolveCapture;
    let rejectCapture;
    const ready = new Promise((resolveReadyValue, rejectReadyValue) => {
      resolveReady = resolveReadyValue;
      rejectReady = rejectReadyValue;
    });
    const captured = new Promise((resolveCaptureValue, rejectCaptureValue) => {
      resolveCapture = resolveCaptureValue;
      rejectCapture = rejectCaptureValue;
    });
    const rejectPending = (error) => {
      if (!readyDone) {
        readyDone = true;
        rejectReady(error);
      }
      if (!captureSettled) {
        captureSettled = true;
        rejectCapture(error);
      }
    };
    const acceptLine = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error("prompt watcher returned non-JSON evidence");
      }
      if (!readyDone) {
        if (
          event?.type !== "ready"
          || event.schemaVersion !== 1
          || event.containerId !== config.containerId
          || event.pollMs !== 100
          || Object.keys(event).sort().join(",")
            !== "containerId,pollMs,schemaVersion,type"
        ) {
          throw new Error("prompt watcher READY evidence is invalid");
        }
        readyDone = true;
        runtime.prompt_ready += 1;
        resolveReady(event);
        return;
      }
      if (captureSeen || event?.type !== "captured") {
        throw new Error("prompt watcher returned duplicate or unordered evidence");
      }
      captureSeen = true;
      captureEvent = event;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      try {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
          throw new Error("prompt watcher stdout exceeds 4 MiB");
        }
        for (;;) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) break;
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          if (line) acceptLine(line);
        }
      } catch (error) {
        rejectPending(error);
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 64 * 1024) {
        stderr = stderr.slice(-64 * 1024);
      }
    });
    child.on("error", rejectPending);
    child.on("close", (code, signal) => {
      exited = true;
      if (stdout.trim().length > 0) {
        rejectPending(new Error("prompt watcher ended with an incomplete frame"));
        return;
      }
      if (code !== 0 || !readyDone || !captureSeen) {
        rejectPending(new Error(
          `prompt watcher failed (${code ?? signal ?? "unknown"}): ${stderr.trim()}`,
        ));
        return;
      }
      if (!captureSettled) {
        captureSettled = true;
        runtime.prompt_captures += 1;
        resolveCapture(captureEvent);
      }
    });
    return {
      ready,
      captured,
      cancel() {
        if (!exited) child.kill("SIGKILL");
      },
    };
  }

  const result = await new Promise((resolve, reject) => {
    runtime.websocket_instances += 1;
    const socket = new WebSocket(
      `${base.replace(/^http/, "ws")}/ws/user-chat-bridge`,
      ["bearer", accessToken],
    );
    const frames = [];
    const connection = { opens: 0, closes: 0, reconnects: 0 };
    let sequence = 0;
    let sendPreparing = false;
    let sent = false;
    let settled = false;
    let completionReady = false;
    let startedAtMs = null;
    let finalAtMs = null;
    let billingEvidenceAtMs = null;
    let promptCapturedAtMs = null;
    let firstOutputAtMs = null;
    let finalText = "";
    let turnTraceId = null;
    let costRequestId = null;
    let costTraceId = null;
    let costFrame = null;
    const costFrames = [];
    let billingBinding = null;
    let extraPrompt = null;
    let promptWatcher = null;
    let bindingPoll = null;
    let bindingDeadlineMs = null;
    let billingDeadline = null;
    const connectDeadline = setTimeout(
      () => fail(new Error("relay and prompt watcher did not become ready in 120s")),
      120_000,
    );
    let turnDeadline = null;
    let closeDeadline = null;

    const record = (direction, text) => {
      frames.push({
        seq: sequence,
        at: new Date().toISOString(),
        direction,
        bytes: Buffer.byteLength(text),
        text,
      });
      sequence += 1;
    };
    const cleanup = () => {
      clearTimeout(connectDeadline);
      clearTimeout(turnDeadline);
      clearTimeout(billingDeadline);
      clearTimeout(closeDeadline);
      clearTimeout(bindingPoll);
      promptWatcher?.cancel();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.close();
      } catch {}
      reject(error);
    };
    const maybeRequestSuccessfulClose = () => {
      if (
        completionReady
        || billingEvidenceAtMs === null
        || promptCapturedAtMs === null
      ) return;
      completionReady = true;
      clearTimeout(turnDeadline);
      closeDeadline = setTimeout(
        () => fail(new Error("turn relay did not close after successful capture")),
        10_000,
      );
      socket.close(1000, "turn captured");
    };
    const markBillingCaptured = () => {
      if (billingEvidenceAtMs !== null) return;
      billingEvidenceAtMs = Date.now();
      clearTimeout(billingDeadline);
      maybeRequestSuccessfulClose();
    };
    const readCcbBinding = () => {
      runtime.binding_queries += 1;
      const sql = [
        "WITH exact_dispatch AS (",
        " SELECT dispatch_id,user_id,session_id,client_message_id,agent_id,model,",
        "        billing_request_id,attempt_no,status,outcome",
        "   FROM turn_dispatches",
        "  WHERE user_id=:'uid'::bigint",
        "    AND session_id=:'peer'",
        "    AND client_message_id=:'client_message_id'",
        "),",
        "authority_binding AS (",
        " SELECT atd.authority_turn_id,atd.user_id,atd.dispatch_model,",
        "        atd.canonical_model,atd.session_id,atd.dispatch_id,atd.attempt_no",
        "   FROM authority_turn_dispatches atd",
        "   JOIN exact_dispatch d",
        "     ON d.dispatch_id=atd.dispatch_id AND d.attempt_no=atd.attempt_no",
        "),",
        "root_usage AS (",
        " SELECT u.id::text,u.request_id,u.model,u.status,u.cost_credits::text,",
        "        u.ledger_id::text,u.turn_key,u.dispatch_id,u.attempt_no",
        "   FROM usage_records u",
        "   JOIN exact_dispatch d",
        "     ON d.dispatch_id=u.dispatch_id AND d.attempt_no=u.attempt_no",
        "  WHERE u.user_id=:'uid'::bigint",
        "),",
        "root_turn AS (",
        " SELECT min(turn_key) AS turn_key,",
        "        count(DISTINCT turn_key) FILTER (WHERE turn_key IS NOT NULL) AS keys",
        "   FROM root_usage",
        "),",
        "delegate_usage AS (",
        " SELECT u.id::text,u.request_id,u.model,u.status,u.cost_credits::text,",
        "        u.ledger_id::text,u.turn_key,u.dispatch_id,u.attempt_no",
        "   FROM usage_records u",
        "  WHERE u.user_id=:'uid'::bigint",
        "    AND u.parent_session_id=:'peer'",
        "    AND u.parent_turn_key=(SELECT turn_key FROM root_turn)",
        "),",
        "bound_usage AS (",
        " SELECT * FROM root_usage UNION ALL SELECT * FROM delegate_usage",
        "),",
        "bound_ledger AS (",
        " SELECT l.id::text,l.delta::text,l.reason,l.ref_type,l.ref_id",
        "   FROM credit_ledger l",
        "  WHERE l.user_id=:'uid'::bigint",
        "    AND l.ref_type='usage_record'",
        "    AND l.ref_id IN (SELECT id FROM bound_usage)",
        ")",
        "SELECT json_build_object(",
        " 'dispatchCount',(SELECT count(*)::int FROM exact_dispatch),",
        " 'dispatch',(SELECT row_to_json(exact_dispatch) FROM exact_dispatch),",
        " 'authorityBindings',COALESCE((SELECT json_agg(authority_binding ORDER BY authority_turn_id) FROM authority_binding),'[]'::json),",
        " 'rootTurnKeyCount',(SELECT keys::int FROM root_turn),",
        " 'rootUsage',COALESCE((SELECT json_agg(root_usage ORDER BY id::bigint) FROM root_usage),'[]'::json),",
        " 'delegateUsage',COALESCE((SELECT json_agg(delegate_usage ORDER BY id::bigint) FROM delegate_usage),'[]'::json),",
        " 'ledger',COALESCE((SELECT json_agg(bound_ledger ORDER BY id::bigint) FROM bound_ledger),'[]'::json)",
        ")::text;",
      ].join("\n");
      const raw = execFileSync(
        "psql",
        [
          commandEnvironment.DATABASE_URL,
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "-At",
          "-v",
          `uid=${config.uid}`,
          "-v",
          `peer=${peerId}`,
          "-v",
          `client_message_id=${clientMessageId}`,
        ],
        {
          encoding: "utf8",
          env: commandEnvironment,
          input: `${sql}\n`,
          maxBuffer: 4 * 1024 * 1024,
          timeout: 5_000,
          killSignal: "SIGKILL",
        },
      ).trim();
      if (!raw) throw new Error("CCB billing binding query returned no row");
      const value = JSON.parse(raw);
      if (value.dispatchCount === 0) {
        throw new Error("CCB dispatch is missing after the final frame");
      }
      if (
        value.dispatchCount !== 1
        || !value.dispatch
        || value.dispatch.user_id !== config.uid
        || value.dispatch.session_id !== peerId
        || value.dispatch.client_message_id !== clientMessageId
        || value.dispatch.agent_id !== config.agentId
        || value.dispatch.model !== config.model
      ) {
        throw new Error("CCB dispatch identity mismatch");
      }
      if (
        typeof value.dispatch.billing_request_id !== "string"
        || value.dispatch.billing_request_id.length === 0
      ) {
        throw new Error("CCB dispatch billing identity is missing");
      }
      if (!Array.isArray(value.authorityBindings)) {
        throw new Error("CCB authority binding evidence is invalid");
      }
      if (value.authorityBindings.length === 0) {
        throw new Error("CCB authority binding is missing after the final frame");
      }
      if (value.authorityBindings.length !== 1) {
        throw new Error("CCB authority binding is not unique");
      }
      const authority = value.authorityBindings[0];
      if (
        !/^[0-9a-f]{32}$/.test(authority.authority_turn_id ?? "")
        || authority.user_id !== config.uid
        || authority.dispatch_id !== value.dispatch.dispatch_id
        || authority.attempt_no !== value.dispatch.attempt_no
        || authority.session_id !== peerId
        || authority.dispatch_model !== value.dispatch.model
        || authority.canonical_model !== config.model
      ) {
        throw new Error("CCB authority binding identity mismatch");
      }
      if (value.dispatch.status !== "terminal") return null;
      if (value.dispatch.outcome !== "completed") {
        throw new Error("CCB terminal dispatch did not complete");
      }
      if (!Array.isArray(value.rootUsage) || !Array.isArray(value.delegateUsage)) {
        throw new Error("CCB usage binding evidence is invalid");
      }
      if (value.rootUsage.length === 0) return null;
      if (value.rootTurnKeyCount !== 1) {
        throw new Error("CCB root usage has ambiguous turn identity");
      }
      const usage = [...value.rootUsage, ...value.delegateUsage];
      if (
        usage.some((row) =>
          typeof row.id !== "string"
          || !/^[1-9][0-9]*$/.test(row.id)
          || typeof row.request_id !== "string"
          || row.request_id.length === 0
          || row.status !== "success"
          || !/^[0-9]+$/.test(row.cost_credits ?? "")
        )
        || new Set(usage.map((row) => row.request_id)).size !== usage.length
        || value.rootUsage.some((row) =>
          row.dispatch_id !== value.dispatch.dispatch_id
          || row.attempt_no !== value.dispatch.attempt_no
          || row.model !== config.model
        )
      ) {
        throw new Error("CCB usage binding identity mismatch");
      }
      if (!Array.isArray(value.ledger)) {
        throw new Error("CCB ledger evidence is invalid");
      }
      const ledgerByUsage = new Map();
      for (const row of value.ledger) {
        if (
          typeof row.id !== "string"
          || !/^[1-9][0-9]*$/.test(row.id)
          || typeof row.ref_id !== "string"
          || row.ref_type !== "usage_record"
          || row.reason !== "chat"
          || !/^-?[0-9]+$/.test(row.delta ?? "")
        ) {
          throw new Error("CCB ledger identity mismatch");
        }
        const rows = ledgerByUsage.get(row.ref_id) ?? [];
        rows.push(row);
        ledgerByUsage.set(row.ref_id, rows);
      }
      const positive = usage.filter((row) => BigInt(row.cost_credits) > 0n);
      const positiveRoot = value.rootUsage.filter(
        (row) => BigInt(row.cost_credits) > 0n,
      );
      if (positive.length === 0 || positiveRoot.length === 0) return null;
      for (const row of positive) {
        const ledger = ledgerByUsage.get(row.id) ?? [];
        if (ledger.length === 0) return null;
        if (
          typeof row.ledger_id !== "string"
          || !ledger.some((entry) => entry.id === row.ledger_id)
          || ledger.some((entry) => BigInt(entry.delta) >= 0n)
          || ledger.reduce((sum, entry) => sum - BigInt(entry.delta), 0n)
            !== BigInt(row.cost_credits)
        ) {
          throw new Error("CCB ledger amount or primary identity mismatch");
        }
      }
      return {
        mode: "ccb_authority_dispatch_attempt",
        finalTraceId: turnTraceId,
        dispatchBillingRequestId: value.dispatch.billing_request_id,
        authorityTurnId: authority.authority_turn_id,
        dispatchId: value.dispatch.dispatch_id,
        attemptNo: value.dispatch.attempt_no,
        requestIds: positive.map((row) => row.request_id).sort(),
        rootRequestIds: positiveRoot.map((row) => row.request_id).sort(),
        usageIds: usage.map((row) => row.id).sort((left, right) =>
          BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
        ),
        ledgerIds: value.ledger.map((row) => row.id).sort((left, right) =>
          BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
        ),
      };
    };
    const pollCcbBinding = () => {
      bindingPoll = null;
      if (settled || completionReady || runtime.finals !== 1 || turnTraceId === null) {
        return;
      }
      let binding;
      try {
        binding = readCcbBinding();
      } catch (error) {
        fail(error);
        return;
      }
      if (binding !== null) {
        const byRequest = new Map();
        for (const frame of costFrames) {
          if (typeof frame.requestId !== "string" || byRequest.has(frame.requestId)) {
            fail(new Error("CCB cost frame request identity is missing or duplicated"));
            return;
          }
          byRequest.set(frame.requestId, frame);
        }
        const expected = new Set(binding.requestIds);
        const unexpected = [...byRequest.keys()].filter((requestId) =>
          !expected.has(requestId)
        );
        if (unexpected.length > 0) {
          fail(new Error("CCB cost frame is not bound to the exact durable usage"));
          return;
        }
        if (binding.requestIds.every((requestId) => byRequest.has(requestId))) {
          billingBinding = binding;
          runtime.matching_costs = binding.requestIds.length;
          costFrame = byRequest.get(binding.rootRequestIds[0]);
          costRequestId = costFrame.requestId;
          costTraceId = typeof costFrame.traceId === "string" ? costFrame.traceId : null;
          markBillingCaptured();
          return;
        }
      }
      if (Date.now() >= bindingDeadlineMs) {
        fail(new Error("CCB final billing evidence did not become exact in 60s"));
        return;
      }
      bindingPoll = setTimeout(pollCcbBinding, 250);
    };
    const maybeComplete = () => {
      if (runtime.finals !== 1 || turnTraceId === null) return;
      if (billingEvidenceAtMs !== null) return;
      if (config.engine === "ccb") {
        bindingDeadlineMs ??= finalAtMs + 60_000;
        if (bindingPoll === null) bindingPoll = setTimeout(pollCcbBinding, 0);
        return;
      }
      const matchingCosts = costFrames.filter((frame) =>
        frame.traceId === turnTraceId || frame.requestId === turnTraceId
      );
      if (matchingCosts.length < 1) return;
      runtime.matching_costs = matchingCosts.length;
      costFrame = matchingCosts[0];
      costRequestId =
        typeof costFrame.requestId === "string"
          ? costFrame.requestId
          : null;
      costTraceId =
        typeof costFrame.traceId === "string"
          ? costFrame.traceId
          : null;
      billingBinding = {
        mode: "codex_server_trace",
        traceId: turnTraceId,
        requestIds: matchingCosts.map((frame) => frame.requestId).filter(
          (requestId) => typeof requestId === "string",
        ),
      };
      markBillingCaptured();
    };
    const validatePromptCapture = (event) => {
      if (
        !event
        || event.type !== "captured"
        || event.schemaVersion !== 1
        || event.containerId !== config.containerId
        || event.engine !== config.engine
        || event.sessionKey !== sessionKey
        || typeof event.path !== "string"
        || !event.path.startsWith("/")
        || !event.path.endsWith("/extra-prompt.md")
        || !Number.isSafeInteger(event.bytes)
        || event.bytes < 1
        || event.bytes > 2 * 1024 * 1024
        || !/^[0-9a-f]{64}$/.test(event.sha256 ?? "")
        || !Number.isSafeInteger(event.candidateCount)
        || event.candidateCount < 1
        || event.selection !== (
          config.engine === "ccb"
            ? "exact-session-process"
            : "exact-session-unique-prompt-path"
        )
        || !Array.isArray(event.processes)
        || event.processes.length !== event.candidateCount
        || typeof event.contentBase64 !== "string"
      ) {
        throw new Error("prompt watcher capture identity is invalid");
      }
      if (config.engine === "ccb" && event.candidateCount !== 1) {
        throw new Error("CCB prompt capture is not bound to one process");
      }
      const pids = new Set();
      for (const processIdentity of event.processes) {
        if (
          !Number.isSafeInteger(processIdentity?.pid)
          || processIdentity.pid < 1
          || !/^[1-9][0-9]*$/.test(processIdentity.startTime ?? "")
          || !/^[0-9a-f]{64}$/.test(processIdentity.cmdlineSha256 ?? "")
          || typeof processIdentity.aliveAtOpen !== "boolean"
          || typeof processIdentity.aliveAfter !== "boolean"
          || pids.has(processIdentity.pid)
        ) {
          throw new Error("prompt watcher process identity is invalid");
        }
        pids.add(processIdentity.pid);
      }
      if (!event.processes.some((identity) => identity.aliveAtOpen)) {
        throw new Error("prompt watcher did not capture a live engine process");
      }
      const bytes = Buffer.from(event.contentBase64, "base64");
      if (
        bytes.toString("base64") !== event.contentBase64
        || bytes.length !== event.bytes
        || createHash("sha256").update(bytes).digest("hex") !== event.sha256
      ) {
        throw new Error("prompt watcher capture bytes are invalid");
      }
      return event;
    };
    const prepareAndSendTurn = () => {
      if (sent || sendPreparing) return;
      sendPreparing = true;
      promptWatcher = startPromptWatcher();
      promptWatcher.captured.then((event) => {
        if (settled) return;
        try {
          extraPrompt = validatePromptCapture(event);
          promptCapturedAtMs = Date.now();
          maybeRequestSuccessfulClose();
        } catch (error) {
          fail(error);
        }
      }, fail);
      promptWatcher.ready.then(() => {
        if (settled) return;
        sent = true;
        clearTimeout(connectDeadline);
        startedAtMs = Date.now();
        const frame = JSON.stringify({
          type: "inbound.message",
          channel: "webchat",
          peer: { id: peerId, kind: "dm" },
          clientMessageId,
          agentId: config.agentId,
          model: config.model,
          content: { text: config.prompt },
          ts: startedAtMs,
        });
        record("sent", frame);
        socket.send(frame);
        runtime.inbound_messages += 1;
        turnDeadline = setTimeout(
          () => fail(new Error(`turn did not complete in ${config.timeoutSeconds}s`)),
          config.timeoutSeconds * 1_000,
        );
      }, fail);
    };

    socket.addEventListener("open", () => {
      connection.opens += 1;
      if (connection.opens !== 1) {
        fail(new Error("turn relay opened more than once"));
      }
    });
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      record("received", text);
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        fail(new Error("relay returned a non-JSON text frame"));
        return;
      }
      if (!sent) {
        if (frame?.type === "sys.relay_ready") prepareAndSendTurn();
        return;
      }
      if (
        ["outbound.error", "outbound.turn_error", "error"].includes(frame?.type)
        || frame?.error
      ) {
        fail(new Error(`turn returned an error: ${JSON.stringify(frame).slice(0, 500)}`));
        return;
      }
      const framePeerId = frame?.peer?.id;
      if (
        frame?.type === "outbound.message"
        && framePeerId === peerId
      ) {
        if (
          firstOutputAtMs === null
          && Array.isArray(frame.blocks)
          && frame.blocks.length > 0
        ) {
          firstOutputAtMs = Date.now();
        }
        for (const block of frame.blocks ?? []) {
          if (block?.kind === "text" && typeof block.text === "string") {
            finalText += block.text;
          }
        }
        if (frame.isFinal === true) {
          runtime.finals += 1;
          if (runtime.finals !== 1) {
            fail(new Error("turn returned more than one matching final frame"));
            return;
          }
          turnTraceId =
            typeof frame.traceId === "string"
              ? frame.traceId
              : typeof frame.requestId === "string"
                ? frame.requestId
                : null;
          if (!/^[0-9a-f]{32}$/.test(turnTraceId ?? "")) {
            fail(new Error("final frame has an invalid server request identity"));
            return;
          }
          finalAtMs = Date.now();
          clearTimeout(turnDeadline);
          billingDeadline = setTimeout(
            () => fail(new Error("final billing evidence did not become exact in 60s")),
            60_000,
          );
        }
      } else if (
        frame?.type === "outbound.cost_charged"
      ) {
        costFrames.push(frame);
      }
      maybeComplete();
    });
    socket.addEventListener("error", () => fail(new Error("turn relay WebSocket failed")));
    socket.addEventListener("close", (event) => {
      connection.closes += 1;
      connection.reconnects = Math.max(0, runtime.websocket_instances - 1);
      if (settled) return;
      if (!completionReady) {
        fail(new Error(`turn relay closed before final+cost (${event.code})`));
        return;
      }
      if (
        event.code !== 1000
        || connection.opens !== 1
        || connection.closes !== 1
        || connection.reconnects !== 0
        || runtime.login_requests !== 0
        || runtime.user_access_token_issues !== 1
        || runtime.admin_access_token_issues !== 0
        || runtime.session_puts !== 1
        || runtime.websocket_instances !== 1
        || runtime.inbound_messages !== 1
        || runtime.finals !== 1
        || runtime.matching_costs < 1
        || runtime.prompt_watchers !== 1
        || runtime.prompt_ready !== 1
        || runtime.prompt_captures !== 1
        || extraPrompt === null
        || promptCapturedAtMs === null
        || billingEvidenceAtMs === null
      ) {
        fail(new Error("turn connection/runtime counts are not exact"));
        return;
      }
      settled = true;
      cleanup();
      resolve({
        peer_id: peerId,
        client_message_id: clientMessageId,
        case_id: config.caseId,
        pair_id: config.pairId,
        order: config.order,
        case_pack_sha: config.casePackSha,
        prompt_sha: config.promptSha,
        model: config.model,
        uid: config.uid,
        engine: config.engine,
        agent_id: config.agentId,
        started_at: new Date(startedAtMs).toISOString(),
        finished_at: new Date(finalAtMs).toISOString(),
        billing_evidence_at: new Date(billingEvidenceAtMs).toISOString(),
        prompt_captured_at: new Date(promptCapturedAtMs).toISOString(),
        wall_ms: finalAtMs - startedAtMs,
        billing_evidence_wait_ms: billingEvidenceAtMs - finalAtMs,
        ttft_ms: firstOutputAtMs === null ? null : firstOutputAtMs - startedAtMs,
        final_text: finalText.trim(),
        trace_id: turnTraceId,
        cost_request_id: costRequestId,
        cost_trace_id: costTraceId,
        cost: costFrame,
        billing_binding: billingBinding,
        extra_prompt: extraPrompt,
        connection,
        runtime,
        frames,
      });
    });
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export const TURN_REMOTE_SCRIPT =
  `const issueSyntheticUserAccessToken = ${issueSyntheticUserAccessToken.toString()};\n` +
  `await (${remoteTurn.toString()})(process.argv.at(-1), issueSyntheticUserAccessToken);\n`;

function extraPromptBytes(value, expected, peerId) {
  const sessionKey = `agent:${expected.agentId}:webchat:dm:${peerId}`;
  if (
    !value
    || typeof value !== "object"
    || value.type !== "captured"
    || value.schemaVersion !== 1
    || value.containerId !== expected.containerId
    || value.engine !== expected.engine
    || value.sessionKey !== sessionKey
    || typeof value.path !== "string"
    || !isAbsolute(value.path)
    || resolve(value.path) !== value.path
    || !value.path.endsWith("/extra-prompt.md")
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1
    || value.bytes > 2 * 1024 * 1024
    || !SHA256_RE.test(value.sha256 ?? "")
    || !Number.isSafeInteger(value.candidateCount)
    || value.candidateCount < 1
    || value.selection !== (
      expected.engine === "ccb"
        ? "exact-session-process"
        : "exact-session-unique-prompt-path"
    )
    || !Array.isArray(value.processes)
    || value.processes.length !== value.candidateCount
    || typeof value.contentBase64 !== "string"
  ) {
    throw new Error("remote extra-prompt evidence is invalid");
  }
  if (expected.engine === "ccb" && value.candidateCount !== 1) {
    throw new Error("remote CCB extra-prompt evidence is not process-unique");
  }
  let priorPid = 0;
  let aliveAtOpen = 0;
  for (const identity of value.processes) {
    if (
      !Number.isSafeInteger(identity?.pid)
      || identity.pid <= priorPid
      || !/^[1-9][0-9]*$/.test(identity.startTime ?? "")
      || !SHA256_RE.test(identity.cmdlineSha256 ?? "")
      || typeof identity.aliveAtOpen !== "boolean"
      || typeof identity.aliveAfter !== "boolean"
    ) {
      throw new Error("remote extra-prompt process evidence is invalid");
    }
    priorPid = identity.pid;
    if (identity.aliveAtOpen) aliveAtOpen += 1;
  }
  if (aliveAtOpen < 1) {
    throw new Error("remote extra-prompt evidence lacks a live engine process");
  }
  const bytes = Buffer.from(value.contentBase64, "base64");
  if (
    bytes.toString("base64") !== value.contentBase64
    || bytes.length !== value.bytes
    || createHash("sha256").update(bytes).digest("hex") !== value.sha256
  ) {
    throw new Error("remote extra-prompt bytes are corrupt or non-canonical");
  }
  return bytes;
}

function parseRemoteTurn(stdout, expected) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("remote turn must output exactly one JSON line");
  }
  const value = JSON.parse(lines[0]);
  if (
    !value
    || typeof value !== "object"
    || !PEER_ID_RE.test(value.peer_id ?? "")
    || !CLIENT_MESSAGE_ID_RE.test(value.client_message_id ?? "")
    || value.case_id !== expected.caseId
    || value.pair_id !== expected.pairId
    || value.order !== expected.order
    || value.case_pack_sha !== expected.casePackSha
    || value.prompt_sha !== expected.promptSha
    || value.model !== expected.model
    || value.uid !== expected.uid
    || value.engine !== expected.engine
    || value.agent_id !== expected.agentId
    || typeof value.started_at !== "string"
    || !Number.isFinite(Date.parse(value.started_at))
    || typeof value.finished_at !== "string"
    || !Number.isFinite(Date.parse(value.finished_at))
    || typeof value.billing_evidence_at !== "string"
    || !Number.isFinite(Date.parse(value.billing_evidence_at))
    || typeof value.prompt_captured_at !== "string"
    || !Number.isFinite(Date.parse(value.prompt_captured_at))
    || !Number.isFinite(value.wall_ms)
    || value.wall_ms < 0
    || !Number.isFinite(value.billing_evidence_wait_ms)
    || value.billing_evidence_wait_ms < 0
    || value.billing_evidence_wait_ms > 66_000
    || Date.parse(value.finished_at) - Date.parse(value.started_at)
      !== value.wall_ms
    || Date.parse(value.billing_evidence_at) - Date.parse(value.finished_at)
      !== value.billing_evidence_wait_ms
    || (
      value.ttft_ms !== null
      && (!Number.isFinite(value.ttft_ms) || value.ttft_ms < 0)
    )
    || typeof value.final_text !== "string"
    || !TRACE_ID_RE.test(value.trace_id ?? "")
    || !value.cost
    || !value.billing_binding
    || value.billing_binding.mode !== (
      expected.engine === "ccb"
        ? "ccb_authority_dispatch_attempt"
        : "codex_server_trace"
    )
    || (
      expected.engine === "ccb"
      && (
        value.billing_binding.finalTraceId !== value.trace_id
        || typeof value.billing_binding.dispatchBillingRequestId !== "string"
        || value.billing_binding.dispatchBillingRequestId.length === 0
        || !Array.isArray(value.billing_binding.requestIds)
        || !Array.isArray(value.billing_binding.rootRequestIds)
        || !value.billing_binding.rootRequestIds.includes(value.cost_request_id)
      )
    )
    || (
      expected.engine === "codex"
      && value.cost.traceId !== value.trace_id
      && value.cost.requestId !== value.trace_id
    )
    || !Array.isArray(value.frames)
    || value.frames.length < 2
    || !value.frames.some((frame) => frame?.direction === "sent")
    || !value.frames.some((frame) => frame?.direction === "received")
    || value.cost.type !== "outbound.cost_charged"
    || (
      value.cost.model !== undefined
      && value.cost.model !== expected.model
    )
    || value.connection?.opens !== 1
    || value.connection?.closes !== 1
    || value.connection?.reconnects !== 0
    || !value.runtime
    || typeof value.runtime !== "object"
    || Object.keys(value.runtime).sort().join(",")
      !== "admin_access_token_issues,binding_queries,finals,inbound_messages,login_requests,matching_costs,prompt_captures,prompt_ready,prompt_watchers,session_puts,user_access_token_issues,websocket_instances"
    || value.runtime.login_requests !== 0
    || value.runtime.user_access_token_issues !== 1
    || value.runtime.admin_access_token_issues !== 0
    || value.runtime?.session_puts !== 1
    || value.runtime?.websocket_instances !== 1
    || value.runtime?.inbound_messages !== 1
    || value.runtime?.finals !== 1
    || value.runtime?.prompt_watchers !== 1
    || value.runtime?.prompt_ready !== 1
    || value.runtime?.prompt_captures !== 1
    || !Number.isSafeInteger(value.runtime?.matching_costs)
    || value.runtime.matching_costs < 1
  ) {
    throw new Error("remote turn output is invalid or differs from runner identity");
  }
  extraPromptBytes(value.extra_prompt, expected, value.peer_id);
  let inboundCount = 0;
  let finalCount = 0;
  let matchingFinalCount = 0;
  let matchingCostCount = 0;
  for (let index = 0; index < value.frames.length; index += 1) {
    const frame = value.frames[index];
    if (
      frame?.seq !== index
      || !["sent", "received"].includes(frame.direction)
      || typeof frame.at !== "string"
      || !Number.isFinite(Date.parse(frame.at))
      || !Number.isSafeInteger(frame.bytes)
      || frame.bytes < 0
      || typeof frame.text !== "string"
      || Buffer.byteLength(frame.text) !== frame.bytes
    ) {
      throw new Error("remote turn frames are incomplete or unordered");
    }
    let payload;
    try {
      payload = JSON.parse(frame.text);
    } catch {
      throw new Error("remote turn frames must contain JSON protocol bytes");
    }
    if (frame.direction === "sent" && payload?.type === "inbound.message") {
      inboundCount += 1;
      if (
        payload?.peer?.id !== value.peer_id
        || payload.clientMessageId !== value.client_message_id
        || payload.agentId !== expected.agentId
        || payload.model !== expected.model
        || payload?.content?.text !== expected.prompt
      ) {
        throw new Error("remote inbound frame differs from runner-bound turn");
      }
    }
    if (
      frame.direction === "received"
      && payload?.type === "outbound.message"
      && payload.isFinal === true
      && payload?.peer?.id === value.peer_id
    ) {
      finalCount += 1;
    }
    if (
      frame.direction === "received"
      && payload?.type === "outbound.message"
      && payload.isFinal === true
      && (
        payload.traceId === value.trace_id
        || payload.requestId === value.trace_id
      )
    ) {
      matchingFinalCount += 1;
    }
    if (
      frame.direction === "received"
      && payload?.type === "outbound.cost_charged"
      && (
        expected.engine === "ccb"
          ? value.billing_binding.requestIds?.includes(payload.requestId)
          : (payload.model === undefined || payload.model === expected.model)
            && (
              payload.traceId === value.trace_id
              || payload.requestId === value.trace_id
            )
      )
    ) {
      matchingCostCount += 1;
    }
  }
  if (
    inboundCount !== 1
    || finalCount !== 1
    || finalCount !== value.runtime.finals
    || matchingFinalCount !== 1
    || matchingCostCount < 1
    || matchingCostCount !== value.runtime.matching_costs
  ) {
    throw new Error("remote turn lacks exactly one inbound or matching final/cost evidence");
  }
  return value;
}

function writeExclusive(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function fsyncDirectory(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurableExclusive(path, bytes) {
  const parent = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd = null;
  let temporaryExists = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    temporaryExists = true;
    writeFileSync(fd, bytes);
    chmodSync(temporary, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    linkSync(temporary, path);
    fsyncDirectory(parent);
    unlinkSync(temporary);
    temporaryExists = false;
    fsyncDirectory(parent);
  } finally {
    if (fd !== null) closeSync(fd);
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
        fsyncDirectory(parent);
      } catch {}
    }
  }
}

export function main() {
  const inputs = readTurnInputs();
  const sshBinary = process.env.OC_SYNTHETIC_EVAL_SSH_BINARY?.trim() || "ssh";
  if (!sshBinary || sshBinary.includes("\0")) {
    throw new Error("OC_SYNTHETIC_EVAL_SSH_BINARY is invalid");
  }
  const remoteConfig = {
    uid: inputs.uid,
    engine: inputs.engine,
    agentId: inputs.agentId,
    caseId: inputs.caseId,
    pairId: inputs.pairId,
    order: inputs.order,
    casePackSha: inputs.casePackSha,
    prompt: inputs.prompt,
    promptSha: inputs.promptSha,
    model: inputs.model,
    timeoutSeconds: inputs.timeoutSeconds,
    containerId: inputs.containerId,
  };
  const encoded = Buffer.from(JSON.stringify(remoteConfig)).toString("base64url");
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
      input: TURN_REMOTE_SCRIPT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `synthetic turn ssh failed (${result.status}): ${
        result.stderr || result.stdout
      }`.trim(),
    );
  }
  const remote = parseRemoteTurn(result.stdout, inputs);
  const promptBytes = extraPromptBytes(remote.extra_prompt, inputs, remote.peer_id);
  const {
    contentBase64: _contentBase64,
    ...extraPromptEvidence
  } = remote.extra_prompt;
  const frameDocument = {
    schema_version: 2,
    peer_id: remote.peer_id,
    client_message_id: remote.client_message_id,
    case_id: inputs.caseId,
    pair_id: inputs.pairId,
    order: inputs.order,
    case_pack_sha: inputs.casePackSha,
    prompt_sha: inputs.promptSha,
    uid: inputs.uid,
    engine: inputs.engine,
    agent_id: inputs.agentId,
    model: inputs.model,
    connection: remote.connection,
    runtime: remote.runtime,
    billing_binding: remote.billing_binding,
    frames: remote.frames,
  };
  const frameBytes = Buffer.from(`${JSON.stringify(frameDocument)}\n`);
  const framesSha = createHash("sha256").update(frameBytes).digest("hex");
  const turnDocument = {
    schema_version: 2,
    peer_id: remote.peer_id,
    client_message_id: remote.client_message_id,
    case_id: inputs.caseId,
    pair_id: inputs.pairId,
    order: inputs.order,
    case_pack_sha: inputs.casePackSha,
    prompt_sha: inputs.promptSha,
    model: inputs.model,
    uid: inputs.uid,
    engine: inputs.engine,
    agent_id: inputs.agentId,
    started_at: remote.started_at,
    finished_at: remote.finished_at,
    billing_evidence_at: remote.billing_evidence_at,
    prompt_captured_at: remote.prompt_captured_at,
    wall_ms: remote.wall_ms,
    billing_evidence_wait_ms: remote.billing_evidence_wait_ms,
    ttft_ms: remote.ttft_ms,
    final_text: remote.final_text,
    trace_id: remote.trace_id,
    cost_request_id: remote.cost_request_id,
    cost_trace_id: remote.cost_trace_id,
    cost: remote.cost,
    billing_binding: remote.billing_binding,
    extra_prompt: {
      ...extraPromptEvidence,
      captured_path: inputs.extraPromptPath,
    },
    connection: remote.connection,
    runtime: remote.runtime,
    frames_path: inputs.framesPath,
    frames_sha256: framesSha,
    frames_bytes: frameBytes.length,
    frame_count: remote.frames.length,
  };
  const turnBytes = Buffer.from(`${JSON.stringify(turnDocument)}\n`);
  writeDurableExclusive(inputs.extraPromptPath, promptBytes);
  writeExclusive(inputs.framesPath, frameBytes);
  writeExclusive(inputs.turnPath, turnBytes);
  process.stdout.write(`${inputs.turnPath}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
