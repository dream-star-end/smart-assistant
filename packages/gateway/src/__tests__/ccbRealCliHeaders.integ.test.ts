/**
 * Real claude-code-best consumption of runner control lines.
 * The node -e adapter in ccbAuthorityHeaders.test.ts is not this CLI.
 * Source under test is this checkout's claude-code-best. Third-party
 * packages come from this directory's bun install --ignore-scripts and are
 * not committed. The launch pattern was ported from the fresh-wt probe;
 * that tree is not executed.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { SubprocessRunner, type TurnModelAuthority } from "../subprocessRunner.js";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "../../../..");
const CCB = join(ROOT, "claude-code-best");
const CLI = join(CCB, "src/entrypoints/cli.tsx");
const CLIENT = join(CCB, "src/services/api/client.ts");
const MODULE_INSTALL = join(CCB, "node_modules");
const TOOL_MARK = "OCV5296_CCB_TOOL_OK";
const MAX_HTTP = 6;
const BOX = {
  canonicalModel: "box-api-claude-opus-5-5",
  contextWindow: 200_000,
  capabilityZero: false,
  supportsThinking: true,
  supportsVision: false,
  supportedEfforts: [] as string[],
  contextOwner: "box-native-v1" as const,
};

async function runnerLines(): Promise<{ first: string[]; renew: string; cleared: string[] }> {
  const runner = new SubprocessRunner({
    sessionKey: "ccb-real",
    agentId: "ccb-real",
    agentBaseDir: "/tmp",
    model: BOX.canonicalModel,
    harness: "ccb",
    config: {},
  } as never);
  const writes: string[] = [];
  ;(runner as unknown as { proc: unknown }).proc = {
    stdin: {
      write(chunk: string, callback?: (err?: Error | null) => void) {
        writes.push(chunk);
        queueMicrotask(() => callback?.(null));
        return true;
      },
      destroy() {},
    },
    kill() {},
  };
  ;(runner as unknown as { spawnedExecutionDescriptor: unknown }).spawnedExecutionDescriptor = BOX;
  const authority: TurnModelAuthority = {
    authorityEnvelope: "BOXAUTH",
    leaseEnvelope: "BOXLEASE1",
    executionDescriptor: BOX,
  };
  await runner.submit("printf once", "req-real", authority);
  const first = writes.slice();
  await runner.updateTurnLease("BOXLEASE2");
  const renew = writes[first.length]!;
  ;(runner as unknown as { spawnedExecutionDescriptor: unknown }).spawnedExecutionDescriptor = undefined;
  await runner.submit("next");
  return { first, renew, cleared: writes.slice(first.length + 1) };
}

function sse(res: ServerResponse, events: Array<[string, unknown]>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function toolEvents(id: string): Array<[string, unknown]> {
  const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 };
  return [
    ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: BOX.canonicalModel, content: [], stop_reason: null, usage } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${id}`, name: "Bash", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{"command":"printf ${TOOL_MARK}"}` } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage }],
    ["message_stop", { type: "message_stop" }],
  ];
}

function textEvents(id: string): Array<[string, unknown]> {
  const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 };
  return [
    ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: BOX.canonicalModel, content: [], stop_reason: null, usage } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }],
    ["message_stop", { type: "message_stop" }],
  ];
}

function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

test("claude-code-best consumes runner Box control lines on loopback", { timeout: 150_000 }, async () => {
  assert.equal(readFileSync(CLI, "utf8").length > 0, true);
  const lines = await runnerLines();
  assert.equal(existsSync(MODULE_INSTALL), true, "claude-code-best/node_modules missing; bun install --ignore-scripts in that directory first");
  const bun = process.env.BUN_BIN ?? "/usr/bin/bun";
  const targetIdentity = process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : {};
  const version = spawnSync(bun, ["--version"], { ...targetIdentity, encoding: "utf8", timeout: 10_000 });
  assert.equal(version.status, 0, `Bun must execute under actual CLI uid: ${version.error ?? version.stderr}`);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  const home = mkdtempSync(join(tmpdir(), "ocv5-296-ccb-"));
  // Host tsx is root, and /var/lib/docker is mode 750, so uid 1000 cannot open the
  // checkout path. This CLI aborts --dangerously-skip-permissions at euid 0 (setup.ts).
  // Bind-mount the same checkout where others can traverse, then drop to uid 1000.
  const dropRoot = process.getuid?.() === 0;
  let view: string | undefined;
  if (dropRoot) {
    chownSync(home, 1000, 1000);
    view = join(tmpdir(), `ocv5-296-ccb-view-${randomBytes(3).toString("hex")}`);
    mkdirSync(view);
    const mounted = spawnSync("mount", ["--bind", CCB, view], { encoding: "utf8" });
    if (mounted.status !== 0) throw new Error(`bind mount failed: ${mounted.stderr}`);
  }
  const runtimeTree = view ?? CCB;
  const cliPath = join(runtimeTree, "src/entrypoints/cli.tsx");

  const hits: Array<{ authority?: string; lease?: string; hasToolMark: boolean; bytes: number }> = [];
  const decisions: Array<(kind: "tool" | "text") => void> = [];
  let http = 0;
  let stdout = "";
  let stderr = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (!req.url?.includes("/v1/messages")) {
      res.writeHead(404);
      res.end();
      return;
    }
    http += 1;
    const raw = Buffer.concat(chunks).toString("utf8");
    hits.push({
      authority: req.headers["x-oc-model-authority"] as string | undefined,
      lease: req.headers["x-oc-turn-lease"] as string | undefined,
      hasToolMark: raw.includes(TOOL_MARK),
      bytes: raw.length,
    });
    if (http > MAX_HTTP) {
      res.writeHead(429);
      res.end();
      return;
    }
    const kind = await new Promise<"tool" | "text">((resolve) => { decisions.push(resolve); });
    const id = `msg_real_${http}`;
    sse(res, kind === "tool" ? toolEvents(id) : textEvents(id));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const { DEFAULT_BUILD_FEATURES, getMacroDefines } = await import(pathToFileURL(join(CCB, "scripts/defines.ts")).href);
  const defines = getMacroDefines();
  const args = [
    "run",
    ...Object.entries(defines).flatMap(([key, value]) => ["-d", `${key}:${value}`]),
    ...DEFAULT_BUILD_FEATURES.flatMap((feature: string) => ["--feature", feature]),
    cliPath,
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", BOX.canonicalModel,
    "--tools", "Bash",
    "--permission-mode", "bypassPermissions",
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", "{\"mcpServers\":{}}",
    "--disable-slash-commands",
    "--system-prompt", "Credential seam probe.",
  ];
  const child = spawn(bun, args, {
    cwd: home,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(dropRoot ? { uid: 1000, gid: 1000 } : {}),
    env: {
      HOME: home,
      TMPDIR: home,
      XDG_CACHE_HOME: home,
      CLAUDE_CONFIG_DIR: home,
      PATH: "/usr/bin:/bin:/usr/local/bin",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: "fixture-only-not-a-real-key",
      CLAUDE_CODE_MAX_RETRIES: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
  });
  child.stdout.on("data", (buf) => { stdout += buf.toString("utf8"); if (stdout.length > 1_500_000) stdout = stdout.slice(-400_000); });
  child.stderr.on("data", (buf) => { stderr += buf.toString("utf8"); if (stderr.length > 200_000) stderr = stderr.slice(-50_000); });
  const waitHit = async (n: number) => {
    const start = Date.now();
    while (hits.length < n) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`cli exited code=${child.exitCode} signal=${child.signalCode} before HTTP ${n}; stderr=${stderr.slice(-800)}`);
      }
      if (Date.now() - start > 70_000) throw new Error(`timed out waiting for HTTP ${n}; stderr=${stderr.slice(-800)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return hits[n - 1]!;
  };
  let outcome: string | undefined;
  try {
    for (const line of lines.first) child.stdin.write(line);
    const first = await waitHit(1);
    assert.equal(first.authority, "BOXAUTH");
    assert.equal(first.lease, "BOXLEASE1");
    decisions[0]!("tool");
    const tool = await waitHit(2);
    assert.equal(tool.authority, "BOXAUTH");
    assert.equal(tool.lease, "BOXLEASE1");
    assert.equal(tool.hasToolMark, true);
    child.stdin.write(lines.renew);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.write(lines.first[1]!);
    decisions[1]!("text");
    const renewed = await waitHit(3);
    assert.equal(renewed.authority, "BOXAUTH");
    assert.equal(renewed.lease, "BOXLEASE2");
    decisions[2]!("text");
    for (const line of lines.cleared) child.stdin.write(line);
    const cleared = await waitHit(4);
    assert.equal(cleared.authority, undefined);
    assert.equal(cleared.lease, undefined);
    decisions[3]!("text");
    outcome = "pass";
  } finally {
    try { child.stdin.end(); } catch { /* closed */ }
    const closed = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
      else child.once("close", resolve);
    });
    const timer = setTimeout(() => killGroup(child), 5_000);
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 7_000))]);
    clearTimeout(timer);
    killGroup(child);
    server.closeAllConnections?.();
    await Promise.race([
      new Promise((resolve) => server.close(() => resolve(undefined))),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    rmSync(home, { recursive: true, force: true });
    if (view) {
      const unmounted = spawnSync("umount", [view]);
      if (unmounted.status === 0) rmSync(view, { recursive: true, force: true });
    }
    const raw = {
      source: CCB,
      cli: CLI,
      runtimeTree,
      cliLaunched: cliPath,
      clientModule: CLIENT,
      clientSha256: createHash("sha256").update(readFileSync(CLIENT)).digest("hex"),
      command: [bun, ...args],
      descriptor: BOX,
      moduleInstall: MODULE_INSTALL,
      moduleInstallNote: "Third-party packages are this checkout's claude-code-best/node_modules from bun install --ignore-scripts. Not committed. CLI source is this checkout.",
      droppedToUid: dropRoot ? 1000 : null,
      bindReason: dropRoot ? "/var/lib/docker is mode 750; uid 1000 cannot open the checkout path, so the same tree is bind-mounted under /tmp" : null,
      http,
      hits,
      outcome,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr.slice(-1500),
    };
    const report = process.env.OC_V5_296_CCB_RAW
      ?? join(tmpdir(), `ocv5-296-ccb-real-${randomBytes(3).toString("hex")}.json`);
    writeFileSync(report, JSON.stringify(raw, null, 2));
    console.log(JSON.stringify({ event: "ocv5-296-ccb-real", report, http, outcome }));
  }
});
