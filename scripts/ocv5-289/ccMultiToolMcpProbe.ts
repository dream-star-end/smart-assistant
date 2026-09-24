/** Offline real CC 2.1.280 -> generic virtual MCP -> synthetic Messages API.
 * Two identical tool calls must bind results to distinct model tool_use IDs.
 * No Box account, user data, or paid model is involved. */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync,
  unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBoxToolCatalog } from "../../packages/commercial/src/http/proxy/boxToolCatalog.js";

const version = execFileSync("/usr/local/bin/claude", ["--version"],
  { encoding: "utf8", timeout: 5000 }).trim();
if (version !== "2.1.280 (Claude Code)") throw new Error("CC_VERSION_UNEXPECTED");
const syntheticTurnKey = "b".repeat(64);
const directory = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
mkdirSync(directory, { mode: 0o700 });
const catalog = compileBoxToolCatalog([{ name: "local_echo",
  description: "Synthetic OpenClaude-local echo; Box must not execute it.",
  input_schema: { type: "object", properties: { value: { type: "string" } },
    required: ["value"] } }]);
writeFileSync(join(directory, "tool-catalog.json"), catalog.json, { mode: 0o600 });
const sidecar = fileURLToPath(new URL("./box_virtual_mcp.py", import.meta.url));
const mcpConfig = JSON.stringify({ mcpServers: { ocbridge: { type: "stdio",
  command: "/usr/bin/python3", args: [sidecar, directory, catalog.sha256, "20"] } } });
const toolName = "mcp__ocbridge__t0";
const ids = ["toolu_multi_a", "toolu_multi_b"];
const results = [`local-${randomBytes(8).toString("hex")}`,
  `local-${randomBytes(8).toString("hex")}`];
let requests = 0, responseExact = false, advertised = false;
const headerShapes: Array<Record<string, string>> = [];
const bodyHashes: string[] = [];
const turnKeyMatches: boolean[] = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") {
    res.writeHead(404).end(); return;
  }
  requests++;
  bodyHashes.push(createHash("sha256").update(raw).digest("hex"));
  headerShapes.push(Object.fromEntries(Object.entries(req.headers)
    .filter(([key]) => /request|session|trace|stainless|id/i.test(key)
      && !/authorization|cookie|token|key/i.test(key))
    .map(([key, value]) => [key, createHash("sha256")
      .update(JSON.stringify(value)).digest("hex").slice(0, 12)])));
  const body = JSON.parse(raw) as Record<string, unknown>;
  const userMeta = (body.metadata as { user_id?: unknown } | undefined)?.user_id;
  let parsedMeta: Record<string, unknown> = {};
  try { if (typeof userMeta === "string") parsedMeta = JSON.parse(userMeta); }
  catch { /* fail summary below */ }
  turnKeyMatches.push(parsedMeta.oc_turn_key === syntheticTurnKey);
  const toolDefs = body.tools as Array<{ name?: string }> | undefined;
  advertised ||= toolDefs?.some((tool) => tool.name === toolName) === true;
  if (requests === 2) {
    const messages = body.messages as Array<{ role?: string; content?: Array<{
      type?: string; tool_use_id?: string; content?: string | Array<{ type?: string; text?: string }> }> }>;
    const found = messages.flatMap((message) => message.role === "user"
      && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "tool_result") : []);
    responseExact = ids.every((id, index) => {
      const item = found.find((block) => block.tool_use_id === id);
      const content = item?.content;
      const text = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter((block) => block.type === "text")
          .map((block) => block.text).join("") : null;
      return text === results[index];
    }) && found.length === 2;
  }
  const event = (name: string, data: unknown): void => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  event("message_start", { type: "message_start", message: {
    id: `msg_multi_${requests}`, type: "message", role: "assistant", model: body.model,
    content: [], usage: { input_tokens: 5, output_tokens: 0 } } });
  if (requests === 1) {
    ids.forEach((id, index) => {
      event("content_block_start", { type: "content_block_start", index,
        content_block: { type: "tool_use", id, name: toolName, input: {} } });
      event("content_block_delta", { type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: '{"value":"same"}' } });
      event("content_block_stop", { type: "content_block_stop", index });
    });
  } else {
    event("content_block_start", { type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" } });
    event("content_block_delta", { type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: responseExact ? "done" : "rejected" } });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  event("message_delta", { type: "message_delta",
    delta: { stop_reason: requests === 1 ? "tool_use" : "end_turn" },
    usage: { output_tokens: 8 } });
  event("message_stop", { type: "message_stop" });
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("LOOPBACK_INVALID");
const child = spawn("/usr/local/bin/claude", ["-p", "Call local_echo twice with value same, then answer.",
  "--model", "claude-opus-5-5", "--output-format", "stream-json", "--verbose",
  "--include-partial-messages",
  "--tools", "", "--strict-mcp-config", "--mcp-config", mcpConfig,
  "--allowedTools", toolName, "--setting-sources", "", "--disable-slash-commands",
  "--no-session-persistence"], { cwd: directory,
  env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, "config"),
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_AUTH_TOKEN: "synthetic-only", CLAUDE_CODE_MAX_RETRIES: "0",
    CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: syntheticTurnKey }),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_PROXY: "127.0.0.1,localhost" },
  stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderrBytes = 0;
child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
const finished = new Promise<number | null>((resolve) => child.once("close", resolve));
const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
let concurrentObserved = false;
try {
  const pending = (id: string): string => join(directory, `pending.${id}.json`);
  const waitFile = async (path: string, maxMs = 7000): Promise<boolean> => {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      try { readFileSync(path); return true; } catch { /* not yet published */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  if (!await waitFile(pending(ids[0]!))) throw new Error("FIRST_TOOL_PENDING_MISSING");
  concurrentObserved = await waitFile(pending(ids[1]!), 1500);
  const publish = (index: number): void => {
    const id = ids[index]!;
    const item = JSON.parse(readFileSync(pending(id), "utf8")) as {
      modelToolUseId: string; mcpRequestId: string | number;
      name: string; arguments: { value: string } };
    if (item.modelToolUseId !== id || item.name !== "t0"
      || item.arguments.value !== "same") throw new Error("PENDING_IDENTITY_INVALID");
    const raw = JSON.stringify({ version: 1, modelToolUseId: id,
      mcpRequestId: item.mcpRequestId, content: [{ type: "text", text: results[index] }],
      isError: false });
    const dest = join(directory, `result.${id}.json`);
    const temp = `${dest}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      linkSync(temp, dest);
      const dirFd = openSync(directory, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } finally { unlinkSync(temp); }
  };
  if (concurrentObserved) { publish(1); publish(0); }
  else {
    publish(0);
    if (!await waitFile(pending(ids[1]!))) throw new Error("SECOND_TOOL_PENDING_MISSING");
    publish(1);
  }
  const exit = await finished;
  const records = stdout.split(/\r?\n/).flatMap((line) => {
    try { return line ? [JSON.parse(line) as Record<string, unknown>] : []; }
    catch { return []; }
  });
  const final = records.findLast((record) => record.type === "result") as {
    is_error?: unknown; result?: unknown } | undefined;
  if (exit !== 0 || requests !== 2 || !advertised || !responseExact
    || final?.is_error !== false || final.result !== "done"
    || !turnKeyMatches.every(Boolean) || bodyHashes[0] === bodyHashes[1]) {
    throw new Error("GENERIC_MCP_REAL_CC_CONTRACT_FAILED");
  }
  process.stdout.write(JSON.stringify({ version, synthetic: true,
    requests, advertised, twoResultsExact: responseExact, concurrentObserved,
    finalSuccess: true, stderrBytes,
    recordTypes: records.slice(0, 48).map((record) => record.type),
    streamEventTypes: records.filter((record) => record.type === "stream_event")
      .slice(0, 48).map((record) => (record.event as { type?: string } | undefined)?.type),
    headerShapes,
    sameTurnKeyAcrossModelCalls: turnKeyMatches.every(Boolean),
    modelRequestBodiesDistinct: bodyHashes[0] !== bodyHashes[1],
  }) + "\n");
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 2000))]);
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
