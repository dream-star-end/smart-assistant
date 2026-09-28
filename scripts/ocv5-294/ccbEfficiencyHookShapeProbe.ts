/** Zero-paid CCB 2.1.280 loopback. The model is scripted. Only two exact
 * Bash commands can pass the guard; both then go through the real
 * efficiencyHookRunner. Captured bodies are synthetic. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = resolve(ROOT, "fixture");
const SED_FILE = resolve(FIXTURE, "sed-target.txt");
const GUARD = resolve(FIXTURE, "commandGuard.mjs");
const ALLOW = resolve(FIXTURE, "allowlist.json");
const CAPTURE = resolve(FIXTURE, "captured-wire.json");
const RUNNER = process.env.OCV5_294_EFFICIENCY_RUNNER
  ?? "/opt/openclaude/packages/gateway/dist/efficiencyHookRunner.cjs";
const ECHO = "echo ocv5-294-echo-marker";
const SED = `sed -n '1p' ${SED_FILE}`;
const TOOLS = [{ name: "Bash", description: "Synthetic fixture shell. Only two exact commands are permitted.",
  input_schema: { type: "object", properties: { command: { type: "string" } },
    required: ["command"] } }];

type ProxyBody = { model?: string; messages?: unknown; tools?: unknown;
  metadata?: unknown; [key: string]: unknown };

function assertVersion(): void {
  const version = execFileSync("/usr/local/bin/claude", ["--version"],
    { encoding: "utf8", timeout: 5000 }).trim();
  if (version !== "2.1.280 (Claude Code)") throw new Error("CC_VERSION_UNEXPECTED");
}

function featureEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (!/^(CLAUDE_|ANTHROPIC_|OPENCLAUDE_EFFICIENCY|FEATURE_|TENGU_)/.test(key)) continue;
    if (/TOKEN|KEY|SECRET|PASSWORD|COOKIE/i.test(key)) { out[key] = "<redacted>"; continue; }
    out[key] = value.length > 120 ? `<len:${value.length}>` : value;
  }
  return out;
}

function blockShape(body: ProxyBody): unknown {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((message) => {
    if (!message || typeof message !== "object") return { role: "<bad>" };
    const item = message as { role?: string; content?: unknown };
    const content = item.content;
    const blocks = Array.isArray(content) ? content.map((block) => {
      if (!block || typeof block !== "object") return { type: typeof block };
      const rec = block as Record<string, unknown>;
      const text = typeof rec.text === "string" ? rec.text : "";
      return { type: rec.type ?? "<none>", keys: Object.keys(rec).sort(),
        textBytes: text ? Buffer.byteLength(text) : 0,
        startsSystemReminder: text.startsWith("<system-reminder>"),
        hasTotalTokens: text.includes("<total_tokens>"),
        hasHookPhrase: text.includes("hook additional context"),
        contentKind: typeof rec.content === "string" ? "string"
          : Array.isArray(rec.content) ? "array" : rec.content === undefined ? "absent" : typeof rec.content };
    }) : typeof content;
    return { role: item.role ?? "<missing>", blocks };
  });
}

async function runGate(capturePath: string): Promise<void> {
  const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
    bodies: ProxyBody[] };
  const gate = await import("../../packages/commercial/src/http/proxy/boxRequestGate.js") as {
    validateBoxRequest: (body: ProxyBody, enabled: boolean) => string | null };
  const norm = await import("../../packages/commercial/src/http/proxy/boxCacheAnnotations.js") as {
    stripBoxCcbToolBudgetTail: (body: ProxyBody) => ProxyBody };
  const results = captured.bodies.map((body, index) => {
    let code: string | null = null;
    let error: string | null = null;
    try { code = gate.validateBoxRequest(body, true); }
    catch (err) { error = err instanceof Error ? err.message : "gate-threw"; }
    let strippedRoles: string[] | null = null;
    try {
      const stripped = norm.stripBoxCcbToolBudgetTail(body);
      strippedRoles = (stripped.messages ?? []).map((message) => {
        const item = message as { role?: string };
        return item.role ?? "<missing>";
      });
    } catch (err) { error = err instanceof Error ? err.message : "strip-threw"; }
    return { index, code, error, strippedRoles, shape: blockShape(body) };
  });
  process.stdout.write(`${JSON.stringify({ gate: results }, null, 2)}\n`);
  const red = results.filter((item) => item.code === "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  if (red.length === 0) process.exitCode = 2;
}

function sse(res: import("node:http").ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function capture(): Promise<void> {
  assertVersion();
  mkdirSync(FIXTURE, { recursive: true, mode: 0o700 });
  writeFileSync(SED_FILE, "ocv5-294-sed-line\n", { mode: 0o600 });
  writeFileSync(ALLOW, `${JSON.stringify({ echo: ECHO, sed: SED })}\n`, { mode: 0o600 });
  const config = resolve(FIXTURE, "claude-config");
  rmSync(config, { recursive: true, force: true });
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(resolve(config, "settings.json"), `${JSON.stringify({
    hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command",
      command: `${process.execPath} ${GUARD}`, timeout: 8 }] }] },
  })}\n`, { mode: 0o600 });
  const bodies: ProxyBody[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") {
      res.writeHead(404); res.end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProxyBody;
    bodies.push(body);
    const n = bodies.length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, "message_start", { type: "message_start", message: {
      id: `msg_ocv5_294_${n}`, type: "message", role: "assistant",
      model: "claude-opus-5-5", content: [], usage: { input_tokens: 3, output_tokens: 0 } } });
    if (n === 1 || n === 2) {
      const command = n === 1 ? ECHO : SED;
      const id = n === 1 ? "toolu_ocv5_294_echo" : "toolu_ocv5_294_sed";
      sse(res, "content_block_start", { type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id, name: "Bash", input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 12 } });
    } else {
      sse(res, "content_block_start", { type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "ocv5-294-final" } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 } });
    }
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LISTEN_FAILED");
  const env = { ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_AUTH_TOKEN: "synthetic-only",
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_MAX_RETRIES: "0",
    OCV5_294_ALLOWLIST: ALLOW,
    OCV5_294_EFFICIENCY_RUNNER: RUNNER,
    NO_PROXY: "127.0.0.1,localhost" };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const child = spawn("/usr/local/bin/claude", ["-p",
    "Call Bash twice and then stop. First command must be exactly: "
      + `${ECHO}. Second command must be exactly: ${SED}. Do not use any other tool.`,
    "--model", "box-api-claude-opus-5-5",
    "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
  { cwd: FIXTURE, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-1500); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
  let exitCode = 1;
  try {
    exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  const record = { claudeVersion: "2.1.280", exitCode, requests: bodies.length,
    echo: ECHO, sed: SED, runner: RUNNER, featureEnv: featureEnv(),
    shapes: bodies.map(blockShape),
    bodySha256: bodies.map((body) => createHash("sha256").update(JSON.stringify(body)).digest("hex")),
    stderrTail: stderr.replace(/synthetic-only/g, "[redacted]"),
    bodies };
  writeFileSync(CAPTURE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const pub = "/home/agent/.openclaude/generated/ocv5-294-captured-wire.json";
  writeFileSync(pub, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ captured: bodies.length, exitCode, capture: CAPTURE, pub })}\n`);
}

const gateFlag = process.argv.indexOf("--gate");
if (gateFlag >= 0) {
  await runGate(process.argv[gateFlag + 1] ?? CAPTURE);
} else {
  await capture();
}
