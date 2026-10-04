/** Zero-paid current user-container Claude Code -> local MCP -> synthetic API.
 * Proves the local fixture produces a second HTTP tool_result before blaming
 * Box transport. Does not touch Box, a wallet, or the live proxy. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { constants, closeSync, fsyncSync, openSync, readFileSync,
  unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBoxRequest } from
  "../../packages/commercial/src/http/proxy/boxRequestGate.js";
import { deriveBoxContextHash, hashBoxAssistantContent } from
  "../../packages/commercial/src/http/proxy/boxCallFingerprint.js";
import { matchBoxToolResults } from
  "../../packages/commercial/src/http/proxy/boxToolResultMatcher.js";
import { normalizeBoxSemanticBody } from
  "../../packages/commercial/src/http/proxy/boxCacheAnnotations.js";
import type { ProxyBody } from
  "../../packages/commercial/src/http/proxy/shared.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = fileURLToPath(new URL("./ccb_local_probe_mcp.py", import.meta.url));
const nonce = randomBytes(12).toString("hex");
const marker = `ocv5-289-local-${randomBytes(12).toString("hex")}`;
const fixture = `${ROOT}/.ocv5-289-read-${nonce}.txt`;
const used = fixture + ".used";
const toolName = "mcp__ocv5probe__read_secret";
const toolId = `toolu_local_${nonce}`;
let first = 0, second = 0, resultMatched = false;
const requestModels: string[] = [];
const replyModel = process.env.OCV5_289_SYNTHETIC_REPLY_MODEL;
const syntheticThinking = process.env.OCV5_289_SYNTHETIC_THINKING === "1";
let firstBody: ProxyBody | null = null;
let continuation: Record<string, unknown> | null = null;
const server = createServer(async (req, res) => {
  if (req.method !== "POST"
    || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") {
    res.writeHead(404); res.end(); return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk); bytes += part.length;
    if (bytes > 2_000_000) { res.writeHead(413); res.end(); return; }
    chunks.push(part);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    model?: string; messages?: Array<{ role?: string; content?: unknown }> };
  const proxyBody = body as ProxyBody;
  requestModels.push(String(body.model ?? "<missing>"));
  if (first === 0) { first++; firstBody = proxyBody; }
  else {
    second++;
    const roles = (body.messages ?? []).map((message) => message.role ?? "<missing>");
    let prefixMatch = false, matcher = "ok";
    try { prefixMatch = !!firstBody
      && deriveBoxContextHash(proxyBody, true) === deriveBoxContextHash(firstBody); }
    catch (error) { matcher = error instanceof Error ? error.message : "context-error"; }
    try { matchBoxToolResults(proxyBody, [{ id: toolId, clientName: toolName,
      boxName: "mcp__ocbridge__t0", input: {} }]); }
    catch (error) { matcher = error instanceof Error ? error.message : "match-error"; }
    const tail = (body.messages ?? []).at(-1) as Record<string, unknown> | undefined;
    const assistant = normalizeBoxSemanticBody(proxyBody).messages.at(-2) as
      Record<string, unknown> | undefined;
    const assistantContent = Array.isArray(assistant?.content) ? assistant.content : [];
    const priorSystem = firstBody?.messages.at(-1) as Record<string, unknown> | undefined;
    continuation = { roles, lastIsToolResultUser: roles.at(-1) === "user",
      gate: validateBoxRequest(proxyBody, true), prefixMatch, matcher,
       assistantShape: assistantContent.map((part) => {
         if (!part || typeof part !== "object" || Array.isArray(part)) {
           return { type: "<other>", keys: [], unknownKeys: 0 };
         }
         const obj = part as Record<string, unknown>;
         const allowed = new Set(["type", "thinking", "signature", "data",
           "text", "id", "name", "input", "cache_control"]);
         const keys = Object.keys(obj);
         return { type: typeof obj.type === "string"
           && ["thinking", "redacted_thinking", "text", "tool_use"].includes(obj.type)
             ? obj.type : "<other>",
           keys: keys.filter((key) => allowed.has(key)).sort(),
           unknownKeys: keys.filter((key) => !allowed.has(key)).length };
       }),
       assistantHash: assistantContent.length ? hashBoxAssistantContent(assistantContent) : null,
       trailingSystem: tail?.role === "system" ? {
        keys: Object.keys(tail).sort(), contentEmpty: tail.content === ""
          || Array.isArray(tail.content) && tail.content.length === 0,
        contentKind: typeof tail.content,
        contentBytes: Buffer.byteLength(JSON.stringify(tail.content)),
        sameAsPriorSystem: JSON.stringify(tail.content) === JSON.stringify(priorSystem?.content),
        effort: typeof (tail.output_config as { effort?: unknown } | undefined)?.effort === "string"
          ? (tail.output_config as { effort: string }).effort : null } : null };
    const results = (body.messages ?? []).flatMap((message) => message.role === "user"
      && Array.isArray(message.content) ? message.content.filter((block) =>
        block && typeof block === "object" && block.type === "tool_result") : []);
    resultMatched = results.length === 1 && results[0]?.tool_use_id === toolId
      && (typeof results[0]?.content === "string" ? results[0].content
        : Array.isArray(results[0]?.content) ? results[0].content.map((x: { text?: string }) =>
          x.text ?? "").join("") : null) === marker;
  }
  const event = (name: string, data: unknown): void => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  event("message_start", { type: "message_start", message: {
    id: `msg_local_${first + second}`, type: "message", role: "assistant",
    model: replyModel ?? body.model, content: [],
    usage: { input_tokens: 5, output_tokens: 0 } } });
  if (second === 0) {
    if (syntheticThinking) {
      event("content_block_start", { type: "content_block_start", index: 0,
        content_block: { type: "thinking", thinking: "" } });
      event("content_block_delta", { type: "content_block_delta", index: 0,
        delta: { type: "thinking_delta", thinking: "Synthetic private reasoning." } });
      event("content_block_delta", { type: "content_block_delta", index: 0,
        delta: { type: "signature_delta", signature: "synthetic-signature" } });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
    }
    const toolIndex = syntheticThinking ? 1 : 0;
    event("content_block_start", { type: "content_block_start", index: toolIndex,
       content_block: { type: "tool_use", id: toolId, name: toolName, input: {} } });
    event("content_block_delta", { type: "content_block_delta", index: toolIndex,
       delta: { type: "input_json_delta", partial_json: "{}" } });
    event("content_block_stop", { type: "content_block_stop", index: toolIndex });
  } else {
    event("content_block_start", { type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" } });
    event("content_block_delta", { type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: resultMatched ? marker : "mismatch" } });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  event("message_delta", { type: "message_delta",
    delta: { stop_reason: second === 0 ? "tool_use" : "end_turn" },
    usage: { output_tokens: 8 } });
  event("message_stop", { type: "message_stop" });
  res.end();
});

async function main(): Promise<void> {
  const fd = openSync(fixture, constants.O_WRONLY | constants.O_CREAT
    | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, marker + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_CCB_LISTENER_INVALID");
  const config = JSON.stringify({ mcpServers: { ocv5probe: { type: "stdio",
    command: "/usr/bin/python3", args: ["-I", SERVER, fixture] } } });
  const env = { ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_AUTH_TOKEN: "synthetic-only",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: "a".repeat(64) }),
    NO_PROXY: "127.0.0.1,localhost", CLAUDE_CODE_MAX_RETRIES: "0" };
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const child = spawn("/usr/local/bin/claude", ["-p",
    "Use the local read_secret tool exactly once and reply with its result only.",
    "--model", "box-api-claude-opus-5-5", "--mcp-config", config,
    "--strict-mcp-config", "--tools", "", "--allowedTools", toolName,
    "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
  { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  let bytes = 0, stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length;
    if (bytes <= 2_000_000) out.push(Buffer.from(chunk)); else child.kill("SIGTERM"); });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length;
    if (stderrBytes > 500_000) child.kill("SIGTERM"); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
  try {
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolvePromise(code ?? 1));
    });
    const records = Buffer.concat(out).toString("utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const final = records.filter((item) => item.type === "result");
    const usedContent = readFileSync(used, "utf8");
    if (exitCode !== 0 || first !== 1 || second !== 1 || !resultMatched
      || usedContent !== "1\n" || final.length !== 1
      || final[0]?.is_error !== false || final[0]?.result !== marker
      || continuation?.gate !== null || continuation.prefixMatch !== true
      || continuation.matcher !== "ok") {
      throw new Error("CCB_LOCAL_MCP_LOOP_FAILED");
    }
     process.stdout.write(JSON.stringify({ ccbUserContainer: true, paidCalls: 0,
       syntheticThinking,
       expectedAssistantHash: hashBoxAssistantContent(syntheticThinking
         ? [{ type: "thinking", thinking: "Synthetic private reasoning.",
           signature: "synthetic-signature" },
           { type: "tool_use", id: toolId, name: toolName, input: {} }]
         : [{ type: "tool_use", id: toolId, name: toolName, input: {} }]),
      firstRequests: first, secondRequests: second, localToolUsedOnce: true,
      toolResultExact: true, finalExact: true, stderrBytes,
      requestModels, replyModel: replyModel ?? requestModels[0],
      continuation,
      eventTypes: records.map((item) => item.type).slice(0, 20) }) + "\n");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    for (const path of [used, fixture]) {
      try { unlinkSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
    ? error.message : "CCB_LOCAL_MCP_LOOP_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
