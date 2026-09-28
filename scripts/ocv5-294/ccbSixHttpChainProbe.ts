/** Native CCB 2.1.280, one strict MCP tool, six scripted HTTP rounds.
 * Round 6 text is parsed from the fifth tool_result. It does not close over the nonce. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { constants, closeSync, fsyncSync, mkdirSync, openSync, readFileSync,
  writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFinalFromFifthResult, decideRun, toolResultText } from "./sixHttpBuilder.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = "/home/agent/.local/bin/host";
const HOST_WT = "/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-294-wire-wt";
const TOOL = "mcp__ocv5six__read_link";
const NONCE_FILE = /^[0-9a-f]{32}$/;

type Sent = { id: string; name: string; input: { path: string } };
type Body = { model?: unknown; messages?: Array<{ role?: string; content?: unknown }>;
  tools?: unknown; tool_choice?: unknown; [key: string]: unknown };
type McpRow = { ok?: boolean; seq?: number; path?: string; sha256?: string; reason?: string };

function exclusiveWrite(path: string, text: string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function assertFresh(path: string): void {
  if (path.endsWith("ocv5-294-captured-wire.json") || path.includes("/fixture/captured-wire.json")) {
    throw new Error("REFUSING_CAPTURE_OVERWRITE");
  }
}
function hostText(command: string): string {
  const result = spawnSync(HOST, [command], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("HOST_COMMAND_FAILED");
  return result.stdout.trim();
}
function lastToolResult(body: Body): string {
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const block = message.content.find((item) => item && typeof item === "object"
      && (item as { type?: string }).type === "tool_result") as { content?: unknown } | undefined;
    if (block) return toolResultText(block.content);
  }
  throw new Error("TOOL_RESULT_MISSING");
}
function firstPath(body: Body): string {
  const message = (body.messages ?? []).find((item) => item.role === "user");
  const content = message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map((block) => (block as { text?: string }).text ?? "").join("\n") : "";
  const found = text.match(/\/tmp\/ocv5-six-[0-9a-f]{16}\/f1-[0-9a-f]{8}\.txt/);
  if (!found) throw new Error("FIRST_PATH_MISSING");
  return found[0];
}
function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function toolSse(res: ServerResponse, id: string, path: string, model: string): void {
  sse(res, "message_start", { type: "message_start", message: { id: `msg_${id}`,
    type: "message", role: "assistant", model, content: [],
    usage: { input_tokens: 3, output_tokens: 0 } } });
  sse(res, "content_block_start", { type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id, name: TOOL, input: {} } });
  sse(res, "content_block_delta", { type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ path }) } });
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 8 } });
  sse(res, "message_stop", { type: "message_stop" });
}
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  const timer = setTimeout(() => {
    try { if (child.exitCode === null && child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); }
    catch { /* already gone */ }
  }, 2000);
  timer.unref();
}
function cliToolNames(stdout: string): string[] | null {
  const names = new Set<string>();
  let saw = false;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    let record: { type?: string; subtype?: string; tools?: unknown };
    try { record = JSON.parse(line); }
    catch { continue; }
    if (record.type !== "system" || record.subtype !== "init" || !Array.isArray(record.tools)) continue;
    saw = true;
    for (const item of record.tools) {
      if (typeof item === "string") names.add(item);
      else if (item && typeof item === "object" && typeof (item as { name?: string }).name === "string") {
        names.add((item as { name: string }).name);
      }
    }
  }
  return saw ? [...names] : null;
}

async function main(): Promise<void> {
  const version = spawnSync("/usr/local/bin/claude", ["--version"], { encoding: "utf8" }).stdout.trim();
  if (version !== "2.1.280 (Claude Code)") throw new Error("CC_VERSION_UNEXPECTED");
  const sha = hostText(`git -C ${HOST_WT} rev-parse HEAD`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("SHA_UNAVAILABLE");
  const dirty = hostText(`git -C ${HOST_WT} status --porcelain -- packages/commercial/src/http/proxy/boxCacheAnnotations.ts packages/commercial/src/http/proxy/boxRequestGate.ts packages/commercial/src/http/proxy/boxToolResultMatcher.ts`);
  if (dirty !== "") throw new Error("CANDIDATE_DIRTY");
  const run = randomBytes(8).toString("hex");
  const dir = join(tmpdir(), `ocv5-six-${run}`);
  mkdirSync(dir, { mode: 0o700 });
  const home = join(dir, "home");
  const config = join(dir, "config");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, "settings.json"), "{}\n", { mode: 0o600 });
  const nonce = randomBytes(16).toString("hex");
  const paths = [1, 2, 3, 4, 5].map((n) => join(dir, `f${n}-${randomBytes(4).toString("hex")}.txt`));
  writeFileSync(paths[0]!, paths[1]!, { mode: 0o600 });
  writeFileSync(paths[1]!, paths[2]!, { mode: 0o600 });
  writeFileSync(paths[2]!, paths[3]!, { mode: 0o600 });
  writeFileSync(paths[3]!, paths[4]!, { mode: 0o600 });
  writeFileSync(paths[4]!, nonce, { mode: 0o600 });
  const prompt = `Use read_link on this exact path and follow each returned path: ${paths[0]}`;
  const earlier = [prompt, readFileSync(paths[0]!, "utf8"), readFileSync(paths[1]!, "utf8"),
    readFileSync(paths[2]!, "utf8"), readFileSync(paths[3]!, "utf8"),
    readFileSync(join(ROOT, "sixHttpBuilder.ts"), "utf8")].join("\n");
  if (earlier.includes(nonce) || !NONCE_FILE.test(nonce)) throw new Error("NONCE_LEAKED");
  const allow = join(dir, "allow.json");
  const mcpLog = join(dir, "mcp.jsonl");
  writeFileSync(allow, JSON.stringify({ paths }));
  writeFileSync(mcpLog, "");
  const mcp = JSON.stringify({ mcpServers: { ocv5six: { type: "stdio",
    command: process.execPath, args: [join(ROOT, "readLinkMcp.mjs"), allow, mcpLog] } } });
  const outFlag = process.argv.indexOf("--out");
  const outPath = outFlag >= 0 ? resolve(process.argv[outFlag + 1]!)
    : `/home/agent/.openclaude/generated/ocv5-294-six-http-${run}.json`;
  const wireContainer = `/home/agent/.openclaude/generated/ocv5-294-six-http-wire-${run}.json`;
  const verifyContainer = `/home/agent/.openclaude/generated/ocv5-294-six-http-verify-${run}.json`;
  for (const path of [outPath, wireContainer, verifyContainer]) assertFresh(path);
  const raws: string[] = [];
  const bodies: Body[] = [];
  const sent: Sent[] = [];
  let firstFailure: string | null = null;
  const fail = (message: string): void => { firstFailure ??= message; };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/messages") {
      res.writeHead(404); res.end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 8_000_000) {
        fail("HTTP_TOO_LARGE"); res.writeHead(413); res.end(); return;
      }
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    raws.push(raw);
    let body: Body;
    try { body = JSON.parse(raw) as Body; }
    catch { fail("HTTP_JSON"); res.writeHead(400); res.end(); return; }
    bodies.push(body);
    const round = bodies.length;
    const model = typeof body.model === "string" ? body.model : "claude-opus-5-5";
    const choice = body.tool_choice;
    if (choice && typeof choice === "object") {
      const picked = choice as { type?: string; name?: string };
      if (picked.type === "none" || (picked.type === "tool" && picked.name !== TOOL)) fail(`TOOL_CHOICE_${round}`);
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    try {
      if (round >= 1 && round <= 5) {
        const path = round === 1 ? firstPath(body) : lastToolResult(body);
        if (path !== paths[round - 1]) fail(`PATH_CHAIN_${round}`);
        const id = `toolu_six_${run}_${round}`;
        sent.push({ id, name: TOOL, input: { path } });
        toolSse(res, id, path, model);
      } else if (round === 6) {
        const finalText = buildFinalFromFifthResult(lastToolResult(body));
        sse(res, "message_start", { type: "message_start", message: { id: `msg_final_${run}`,
          type: "message", role: "assistant", model, content: [],
          usage: { input_tokens: 3, output_tokens: 0 } } });
        sse(res, "content_block_start", { type: "content_block_start", index: 0,
          content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0,
          delta: { type: "text_delta", text: finalText } });
        sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
        sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 4 } });
        sse(res, "message_stop", { type: "message_stop" });
      } else { fail(`EXTRA_HTTP_${round}`); }
    } catch (err) { fail(err instanceof Error ? err.message : "RESPONSE_FAILED"); }
    res.end();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LISTEN_FAILED");
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8", HOME: home, TMPDIR: dir, CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_AUTH_TOKEN: "synthetic-only",
    NO_PROXY: "127.0.0.1,localhost", CLAUDE_CODE_MAX_RETRIES: "0",
  };
  const child = spawn("/usr/local/bin/claude", ["-p", prompt, "--model", "box-api-claude-opus-5-5",
    "--mcp-config", mcp, "--strict-mcp-config", "--tools", "",
    "--allowedTools", TOOL, "--setting-sources", "",
    "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
  { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.length > 2_000_000) { fail("STDOUT_CAP"); killGroup(child); }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 500_000) { fail("STDERR_CAP"); killGroup(child); }
  });
  const timer = setTimeout(() => { fail("TIMEOUT"); killGroup(child); }, 150_000);
  let exitCode = 1;
  try {
    exitCode = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) => done(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
    killGroup(child);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  await new Promise((done) => setTimeout(done, 400));
  const reaped = spawnSync("pgrep", ["-f", `readLinkMcp.mjs ${allow}`], { encoding: "utf8" });
  if (reaped.error || (reaped.status !== 0 && reaped.status !== 1)) fail("MCP_REAP_UNAVAILABLE");
  else if (reaped.status === 0) {
    for (const line of reaped.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    fail("MCP_LEFTOVER");
  }
  const results = stdout.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) as { type?: string; subtype?: string; result?: unknown; is_error?: boolean }; }
    catch { return null; }
  }).filter((item) => item?.type === "result");
  const cliFinal = results.length === 1 && results[0]?.subtype === "success"
    && results[0].is_error === false && typeof results[0].result === "string"
    ? results[0].result : null;
  const tools = cliToolNames(stdout);
  const mcpRows = readFileSync(mcpLog, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as McpRow);
  const mcpOk = mcpRows.filter((row) => row.ok === true);
  const fifth = mcpOk.find((row) => row.seq === 5);
  const expectedNonce = fifth ? readFileSync(paths[4]!, "utf8") : "";
  if (!fifth || createHash("sha256").update(expectedNonce).digest("hex") !== fifth.sha256) fail("MCP_FIFTH");
  const hostWire = `/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/ocv5-294-six-http-wire-${run}.json`;
  const wire = { sha, raws,
    rawSha256: raws.map((raw) => createHash("sha256").update(raw).digest("hex")),
    bodies, sent, mcp: mcpRows };
  exclusiveWrite(wireContainer, `${JSON.stringify(wire)}\n`);
  const verified = spawnSync(HOST, [
    `cd ${HOST_WT} && /usr/bin/tsx scripts/ocv5-294/sixHttpVerify.ts --wire ${hostWire}`,
  ], { encoding: "utf8" });
  let verify: { firstError?: string | null } | null = null;
  const verifyLine = verified.stdout.trim().split("\n").filter((item) => item.startsWith("{")).at(-1) ?? "";
  try { verify = JSON.parse(verifyLine) as { firstError?: string | null }; }
  catch { fail("VERIFY_OUTPUT"); }
  exclusiveWrite(verifyContainer, `${JSON.stringify(verify ?? { firstError: "VERIFY_OUTPUT",
    stderr: verified.stderr.slice(-800) })}\n`);
  const decision = decideRun({
    http: bodies.length, toolUses: sent.length, mcpOk: mcpOk.length,
    mcpRejected: mcpRows.some((row) => row.ok === false),
    cliExit: exitCode, cliFinal, expectedNonce,
    verifyStatus: verified.status ?? 1,
    toolsExact: tools?.length === 1 && tools[0] === TOOL,
  });
  if (decision) fail(decision);
  const success = firstFailure === null;
  const receipt = { success, scope: "native-ccb-six-http-only", sha, run, outPath,
    wire: hostWire, wireContainer, verifyReport: verifyContainer,
    http: bodies.length, toolUseIds: sent.map((item) => item.id),
    mcp: mcpOk.length, cliTools: tools, cliFinal, expectedNonce, firstFailure,
    exitCode, verifyStatus: verified.status, verify, stderrTail: stderr.slice(-800) };
  exclusiveWrite(outPath, `${JSON.stringify(receipt)}\n`);
  process.stdout.write(`${JSON.stringify({ success, sha, run, outPath, wire: hostWire,
    firstFailure, http: bodies.length, mcp: mcpOk.length, exitCode })}\n`);
  process.exit(success ? 0 : 2);
}

if ((process.argv[1] ?? "").includes("ccbSixHttpChainProbe")) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : "FAILED"}\n`);
    process.exit(1);
  });
}
