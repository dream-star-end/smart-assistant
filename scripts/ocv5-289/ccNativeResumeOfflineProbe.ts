/** No Box credential or paid upstream. Proves pinned Claude CLI native session
 * persistence and completed-turn --resume before attempting the real Box. */
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const claude = "/usr/local/bin/claude";
if (execFileSync(claude, ["--version"], { encoding: "utf8" }).trim()
  !== "2.1.280 (Claude Code)") throw new Error("CLI_VERSION_NOT_PINNED");
const root = `/tmp/ocv5-291-native-${randomBytes(12).toString("hex")}`;
const cwd = join(root, "stable-cwd"), config = join(root, "config");
const sessionId = randomUUID();
const secret = `native-${randomBytes(12).toString("hex")}`;
const system = "Synthetic native resume test. No external tools or user data.";
const firstPrompt = `Remember this marker, then reply READY only: ${secret}`;
const secondPrompt = "Recall the prior marker exactly, no other words.";
mkdirSync(cwd, { recursive: true, mode: 0o700 });
mkdirSync(config, { recursive: true, mode: 0o700 });
let requests = 0, secondHistoryExact = false;
function visibleText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((block) => !block || typeof block !== "object"
    || (block as { type?: unknown }).type !== "text"
    || typeof (block as { text?: unknown }).text !== "string")) return null;
  return content.map((block) => (block as { text: string }).text).join("");
}
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") {
    res.writeHead(404); res.end(); return;
  }
  requests++;
  const sent = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  const history = (sent.messages ?? []).filter((message) => message.role !== "system"
    && !(process.env.OCV5_291_NEGATIVE_DROP_ASSISTANT === "1"
      && message.role === "assistant"));
  if (requests === 2) secondHistoryExact = history.length === 3
    && history[0]?.role === "user" && visibleText(history[0].content) === firstPrompt
    && history[1]?.role === "assistant" && visibleText(history[1].content) === "READY"
    && history[2]?.role === "user" && visibleText(history[2].content) === secondPrompt;
  const reply = requests === 1 ? "READY" : secondHistoryExact ? secret : "HISTORY_MISSING";
  const event = (type: string, data: unknown) => res.write(
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  event("message_start", { type: "message_start", message: { id: `msg_native_${requests}`,
    type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
  event("content_block_start", { type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } });
  event("content_block_delta", { type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: reply } });
  event("content_block_stop", { type: "content_block_stop", index: 0 });
  event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 12, output_tokens: 4 } });
  event("message_stop", { type: "message_stop" });
  res.end();
});

async function round(port: number, number: 1 | 2): Promise<{
  exit: number | null; result: string; reportedSessionId: string | null;
}> {
  const stdin = join(root, `round-${number}.jsonl`);
  writeFileSync(stdin, JSON.stringify({ type: "user", message: { role: "user",
    content: [{ type: "text", text: number === 1 ? firstPrompt : secondPrompt }] } }) + "\n",
  { flag: "wx", mode: 0o600 });
  const argv = ["-p", number === 1 ? "--session-id" : "--resume", sessionId,
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--include-partial-messages", "--verbose", "--model", "claude-opus-5-5",
    "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "", "--disable-slash-commands",
    "--system-prompt", system];
  const child = spawn(claude, argv, { cwd, env: { HOME: root, CLAUDE_CONFIG_DIR: config,
    PATH: "/usr/local/bin:/usr/bin:/bin", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: "fixture-only", CLAUDE_CODE_MAX_RETRIES: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTO_COMPACT: "1",
    NO_PROXY: "127.0.0.1,localhost" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (part: Buffer) => { stdout += part.toString("utf8"); });
  child.stderr.on("data", (part: Buffer) => { stderr += part.toString("utf8"); });
  child.stdin.end(readFileSync(stdin));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  const records = stdout.split(/\r?\n/).flatMap((line) => {
    try { return line ? [JSON.parse(line) as { type?: string; result?: string;
      session_id?: string }] : []; }
    catch { return []; }
  });
  const final = records.findLast((record) => record.type === "result");
  const result = final?.result ?? "";
  if (exit !== 0) throw new Error(`CLI_ROUND_${number}_FAILED:${stderr.slice(0, 160)}`);
  return { exit, result, reportedSessionId: final?.session_id ?? null };
}

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const port = (server.address() as { port: number }).port;
  const first = await round(port, 1);
  const transcript = join(config, "projects", cwd.replaceAll("/", "-"), `${sessionId}.jsonl`);
  const persistedAfterFirst = existsSync(transcript);
  const firstBytes = persistedAfterFirst ? readFileSync(transcript).length : 0;
  const second = persistedAfterFirst && first.result === "READY"
    ? await round(port, 2) : null;
  const secondBytes = second ? readFileSync(transcript).length : 0;
  const good = requests === 2 && secondHistoryExact && persistedAfterFirst
    && first.result === "READY" && second?.result === secret && secondBytes > firstBytes
    && first.reportedSessionId === sessionId && second?.reportedSessionId === sessionId;
  process.stdout.write(JSON.stringify({ cli: "2.1.280", requests, persistedAfterFirst,
    firstBytes, secondBytes, nativeSessionReused: secondBytes > firstBytes,
    secondHistoryExact, sessionIdsExact: first.reportedSessionId === sessionId
      && second?.reportedSessionId === sessionId,
    finalExact: second?.result === secret, success: good }) + "\n");
  if (!good) process.exitCode = 1;
} finally {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
