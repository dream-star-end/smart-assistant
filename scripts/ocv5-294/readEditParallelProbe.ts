/** Native CCB 2.1.280: scripted Read, then two Edits in one assistant message.
 * Loopback only. Does not call Box, Anthropic, or a private handler. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, mkdirSync, openSync, readFileSync,
  writeFileSync, writeSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function reapOwnedGroup(pgid: number, termMs: number): Promise<void> {
  const alive = (): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
  if (!alive()) return;
  try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + termMs;
  while (alive() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 40));
  if (alive()) { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } }
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = "/home/agent/.local/bin/host";
const HOST_WT = "/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-294-parallel-repro-wt";
const FIXED = "74b42e09cd6404b230b4d86aa5cb813f383cebb7";
const RUNNER = "/opt/openclaude/packages/gateway/dist/efficiencyHookRunner.cjs";
const ALPHA_OLD = "ALPHA_OLD_TOKEN";
const BETA_OLD = "BETA_OLD_TOKEN";
const ALPHA_NEW = "ALPHA_NEW_TOKEN";
const BETA_NEW = "BETA_NEW_TOKEN";

type Sent = { id: string; name: string; input: Record<string, unknown> };
type Body = { model?: unknown; messages?: unknown; stream?: unknown; tools?: unknown };

function exclusiveWrite(path: string, text: string): void {
  if (path.includes("captured-wire") || path.includes("bcaf4fba7bcf111c")
    || path.includes("db8eb665")) throw new Error("REFUSING_SEALED_EVIDENCE");
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function hostText(command: string): string {
  const result = spawnSync(HOST, [command], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error("HOST_COMMAND_FAILED");
  return result.stdout.trim();
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function toolBlock(res: ServerResponse, index: number, id: string, name: string,
  input: Record<string, unknown>): void {
  sse(res, "content_block_start", { type: "content_block_start", index,
    content_block: { type: "tool_use", id, name, input: {} } });
  sse(res, "content_block_delta", { type: "content_block_delta", index,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  sse(res, "content_block_stop", { type: "content_block_stop", index });
}

function openMessage(res: ServerResponse, id: string, model: string): void {
  sse(res, "message_start", { type: "message_start", message: {
    id, type: "message", role: "assistant", model, content: [],
    usage: { input_tokens: 3, output_tokens: 0 } } });
}

function closeTools(res: ServerResponse): void {
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 8 } });
  sse(res, "message_stop", { type: "message_stop" });
}

function armGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.pid <= 1) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
}

async function main(): Promise<void> {
  const version = spawnSync("/usr/local/bin/claude", ["--version"], { encoding: "utf8" }).stdout.trim();
  if (version !== "2.1.280 (Claude Code)") throw new Error("CC_VERSION_UNEXPECTED");
  const sha = hostText(`git -c safe.directory=${HOST_WT} -C ${HOST_WT} rev-parse HEAD`);
  if (sha !== FIXED) throw new Error("SHA_NOT_FIXED");
  const run = randomBytes(8).toString("hex");
  const dir = join(tmpdir(), `ocv5-parallel-${run}`);
  const home = join(dir, "home");
  const config = join(dir, "config");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const target = join(dir, "sample.txt");
  writeFileSync(target, `${ALPHA_OLD}\n${BETA_OLD}\nGAMMA_KEEP_LINE\n`, { mode: 0o600 });
  const readInput = { file_path: target, limit: 3 };
  const editA = { file_path: target, old_string: ALPHA_OLD, new_string: ALPHA_NEW, replace_all: false };
  const editB = { file_path: target, old_string: BETA_OLD, new_string: BETA_NEW, replace_all: false };
  const allow = { tuples: [
    { name: "Read", input: readInput },
    { name: "Edit", input: editA },
    { name: "Edit", input: editB },
  ] };
  const allowPath = join(dir, "allow.json");
  writeFileSync(allowPath, JSON.stringify(allow), { mode: 0o600 });
  const guard = join(ROOT, "fixture/readEditGuard.mjs");
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: ".*", hooks: [{ type: "command",
          command: `${process.execPath} ${JSON.stringify(guard)} ${JSON.stringify(allowPath)}`,
          timeout: 4 }] },
        { matcher: "Bash|Shell", hooks: [{ type: "command",
          command: `${process.execPath} ${JSON.stringify(RUNNER)} --protocol=ccb --mode=warn`,
          timeout: 4 }] },
      ],
    },
  };
  writeFileSync(join(config, "settings.json"), `${JSON.stringify(settings)}\n`, { mode: 0o600 });
  const nonce = randomBytes(16).toString("hex");
  const prompt = "Read the sample, then apply both prepared edits. Do not open any other path.";
  if (readFileSync(target, "utf8").includes(nonce) || prompt.includes(nonce)) throw new Error("NONCE_LEAKED");
  const wireContainer = `/home/agent/.openclaude/generated/ocv5-294-parallel-wire-${run}.json`;
  const offlineContainer = `/home/agent/.openclaude/generated/ocv5-294-parallel-offline-${run}.json`;
  const outPath = `/home/agent/.openclaude/generated/ocv5-294-parallel-receipt-${run}.json`;
  const raws: string[] = [];
  const bodies: Body[] = [];
  const sent: Sent[] = [];
  let firstFailure: string | null = null;
  const fail = (message: string): void => { firstFailure ??= message; };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      res.writeHead(404); res.end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    raws.push(raw);
    let body: Body;
    try { body = JSON.parse(raw) as Body; }
    catch { fail("HTTP_JSON"); res.writeHead(400); res.end(); return; }
    bodies.push(body);
    const round = bodies.length;
    const model = typeof body.model === "string" ? body.model : "claude-opus-5-5";
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (round === 1) {
      const id = `toolu_re_${run}_read`;
      sent.push({ id, name: "Read", input: readInput });
      openMessage(res, `msg_re_${run}_1`, model);
      toolBlock(res, 0, id, "Read", readInput);
      closeTools(res);
    } else if (round === 2) {
      const idA = `toolu_re_${run}_ed1`;
      const idB = `toolu_re_${run}_ed2`;
      sent.push({ id: idA, name: "Edit", input: editA }, { id: idB, name: "Edit", input: editB });
      openMessage(res, `msg_re_${run}_2`, model);
      toolBlock(res, 0, idA, "Edit", editA);
      toolBlock(res, 1, idB, "Edit", editB);
      closeTools(res);
    } else if (round === 3) {
      const text = `PARALLEL_NONCE:${nonce}`;
      openMessage(res, `msg_re_${run}_3`, model);
      sse(res, "content_block_start", { type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 } });
      sse(res, "message_stop", { type: "message_stop" });
    } else fail(`EXTRA_HTTP_${round}`);
    res.end();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LISTEN_FAILED");
  const child = spawn("/usr/local/bin/claude", ["-p", prompt, "--model", "box-api-claude-opus-5-5",
    "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--permission-prompt-tool", "stdio", "--setting-sources", "user"], {
    cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: home, TMPDIR: dir,
      CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_AUTH_TOKEN: "synthetic-only", NO_PROXY: "127.0.0.1,localhost",
      CLAUDE_CODE_MAX_RETRIES: "0",
    },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const timer = setTimeout(() => { fail("TIMEOUT"); armGroup(child); }, 90_000);
  let exitCode = 1;
  try {
    exitCode = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => done(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
    if (child.pid !== undefined && child.pid > 1) await reapOwnedGroup(child.pid, 400);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  const edited = readFileSync(target, "utf8");
  const fileOk = edited.includes(ALPHA_NEW) && edited.includes(BETA_NEW)
    && !edited.includes(ALPHA_OLD) && !edited.includes(BETA_OLD);
  if (!fileOk) fail("EDIT_FILE_NOT_BOTH");
  if (!stdout.includes(`PARALLEL_NONCE:${nonce}`)) fail("NONCE_MISSING");
  const hostWire = `/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/ocv5-294-parallel-wire-${run}.json`;
  const hostOffline = `/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/ocv5-294-parallel-offline-${run}.json`;
  exclusiveWrite(wireContainer, `${JSON.stringify({
    labeled: "native-ccb-loopback", sha, run, raws,
    rawSha256: raws.map((raw) => createHash("sha256").update(raw).digest("hex")),
    bodies, sent,
  })}\n`);
  const verified = spawnSync(HOST, [
    `cd ${HOST_WT} && NODE_PATH=/opt/openclaude/openclaude-v5-selfhost/node_modules /usr/bin/tsx scripts/ocv5-294/readEditParallelOffline.ts --wire ${hostWire}`,
  ], { encoding: "utf8", timeout: 60_000 });
  if (verified.status !== 0) fail("OFFLINE_FAILED");
  exclusiveWrite(offlineContainer, verified.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1) ?? "{}\n");
  const receipt = {
    success: firstFailure === null && exitCode === 0, sha, version, run, exitCode, firstFailure,
    http: bodies.length, sent: sent.map((item) => ({ id: item.id, name: item.name,
      inputKeys: Object.keys(item.input).sort() })),
    fileOk, wireContainer, offlineContainer, hostWire, hostOffline,
    configDelta: {
      liveWeb: "subprocessRunner writes settings with only PreToolUse Bash|Shell efficiency hook; permissionMode comes from the agent and may include bypass. This probe did not read that live value.",
      probe: "isolated CLAUDE_CONFIG_DIR keeps that Bash|Shell hook and adds a matcher .* guard. No --allowedTools, no --dangerously-skip-permissions, no real user.md.",
    },
    stderrTail: stderr.slice(-500),
  };
  exclusiveWrite(outPath, `${JSON.stringify(receipt)}\n`);
  process.stdout.write(`${JSON.stringify({ success: receipt.success, sha, run, exitCode,
    firstFailure, http: bodies.length, outPath, wireContainer, offlineContainer })}\n`);
  process.exit(receipt.success ? 0 : 2);
}

if ((process.argv[1] ?? "").includes("readEditParallelProbe")) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : "FAILED"}\n`);
    process.exit(1);
  });
}
