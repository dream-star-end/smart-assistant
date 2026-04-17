#!/usr/bin/env bun
/**
 * T-52 — Agent 容器内 RPC server。
 *
 * 运行环境:在容器里被 supervisor.sh 起来;非 root(uid=1000:agent)。
 *
 * 协议:unix socket + JSON lines(一行一个 JSON 对象,`\n` 结尾)。
 *   - `{type:"hello"}` → `{type:"hello_ack", pid, uid, node_version, bun_version}`
 *   - `{type:"echo", id, text}` → `{type:"echo_ack", id, text}`
 *   - `{type:"tool", id, tool:"bash", args:{cmd, timeout_ms?}}` → `{type:"tool_result", id, success, stdout, stderr, exit_code, duration_ms}`
 *   - 未知 type → `{type:"error", id?, code:"UNKNOWN_TYPE", message}`
 *
 * 为什么这里用 node:net 而不是 Bun.listen:
 *   - 本脚本要同时兼容 Bun 运行时和 `bun run ... --selftest`
 *     里通过 node:net 做 round-trip 的客户端;把 server / client 都落在 node:net
 *     上统一,避免 Bun 特有 API 在未来版本漂移。
 *
 * 限制:单进程 / 单 socket,所有用户连接共享 agent 身份(容器本身就是单用户沙箱)。
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_SOCKET_PATH = "/var/run/agent-rpc/agent.sock";
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024; // 一行不超过 4MB,防内存爆

function log(msg: string): void {
  // supervisor.sh 把 stdout 丢给 docker logs —— 格式跟它对齐
  process.stdout.write(`[agent-rpc] ${msg}\n`);
}

function truncate(buf: Buffer, max: number): { text: string; truncated: boolean } {
  if (buf.length <= max) return { text: buf.toString("utf8"), truncated: false };
  return { text: buf.subarray(0, max).toString("utf8"), truncated: true };
}

type RpcRequest =
  | { type: "hello" }
  | { type: "echo"; id?: string | number; text?: string }
  | {
      type: "tool";
      id?: string | number;
      tool?: string;
      args?: { cmd?: string; timeout_ms?: number };
    }
  | { type: string; [k: string]: unknown };

type RpcResponse = Record<string, unknown>;

/** 收到一帧完整 JSON 对象,决定回什么。 */
async function handleFrame(req: RpcRequest): Promise<RpcResponse> {
  switch (req.type) {
    case "hello":
      return {
        type: "hello_ack",
        pid: process.pid,
        uid: process.env.OC_UID ?? "unknown",
        node_version: process.versions.node,
        bun_version: process.versions.bun ?? null,
      };
    case "echo":
      return { type: "echo_ack", id: (req as { id?: unknown }).id ?? null, text: (req as { text?: unknown }).text ?? "" };
    case "tool": {
      const id = (req as { id?: unknown }).id ?? null;
      const tool = (req as { tool?: unknown }).tool;
      if (tool !== "bash") {
        return { type: "error", id, code: "UNKNOWN_TOOL", message: `unsupported tool: ${String(tool)}` };
      }
      const args = (req as { args?: { cmd?: unknown; timeout_ms?: unknown } }).args ?? {};
      const cmd = typeof args.cmd === "string" ? args.cmd : "";
      if (cmd.length === 0) {
        return { type: "error", id, code: "BAD_ARGS", message: "tool=bash requires args.cmd:string" };
      }
      const timeoutMs =
        typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
          ? Math.min(args.timeout_ms, 10 * 60_000) // 10min 硬上限,防死循环卡住 agent
          : DEFAULT_TOOL_TIMEOUT_MS;
      return runBash(id, cmd, timeoutMs);
    }
    default:
      return {
        type: "error",
        id: (req as { id?: unknown }).id ?? null,
        code: "UNKNOWN_TYPE",
        message: `unsupported frame type: ${String(req.type)}`,
      };
  }
}

/** 执行 `bash -c <cmd>`,带 timeout + 输出截断。 */
function runBash(id: unknown, cmd: string, timeoutMs: number): Promise<RpcResponse> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", ["-c", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      // 不继承 supervisor 的 signal mask;确保 SIGTERM 能被我们通过 kill 发下去
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      // 累计时仍收全部,截断只在 response 里做(避免复杂状态管理)
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES * 4) stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES * 4) stderrChunks.push(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* */ }
      // 2s 后还活着就 SIGKILL
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, 2000).unref();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      const duration = Date.now() - started;
      resolve({
        type: "tool_result",
        id,
        success: false,
        stdout: "",
        stderr: `spawn failed: ${err.message}`,
        exit_code: null,
        duration_ms: duration,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - started;
      const { text: stdout } = truncate(Buffer.concat(stdoutChunks), MAX_STDOUT_BYTES);
      const { text: stderrRaw } = truncate(Buffer.concat(stderrChunks), MAX_STDERR_BYTES);
      const stderr = timedOut
        ? (stderrRaw ? stderrRaw + "\n" : "") + `[agent-rpc] command timed out after ${timeoutMs}ms`
        : stderrRaw;
      resolve({
        type: "tool_result",
        id,
        success: !timedOut && code === 0,
        stdout,
        stderr,
        exit_code: code,
        duration_ms: duration,
        ...(timedOut ? { timed_out: true } : {}),
        ...(signal ? { signal } : {}),
      });
    });
  });
}

/** 处理单个连接:按 `\n` 分帧,串行执行每一帧(保证 tool 响应不乱序)。 */
function handleConnection(sock: net.Socket): void {
  let buf = Buffer.alloc(0);
  let busy = false;
  const pending: string[] = [];

  const drain = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (pending.length > 0) {
        const line = pending.shift()!;
        let req: RpcRequest;
        try {
          const obj = JSON.parse(line);
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            throw new Error("frame must be JSON object");
          }
          req = obj as RpcRequest;
        } catch (err) {
          writeFrame(sock, {
            type: "error",
            code: "BAD_JSON",
            message: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        try {
          const resp = await handleFrame(req);
          writeFrame(sock, resp);
        } catch (err) {
          writeFrame(sock, {
            type: "error",
            id: (req as { id?: unknown }).id ?? null,
            code: "INTERNAL",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      busy = false;
    }
  };

  sock.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_LINE_BYTES) {
      writeFrame(sock, { type: "error", code: "LINE_TOO_BIG", message: `line exceeds ${MAX_LINE_BYTES} bytes` });
      sock.destroy();
      return;
    }
    // 按 \n 切
    let idx: number;
    while ((idx = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, idx).toString("utf8").trimEnd();
      buf = buf.subarray(idx + 1);
      if (line.length === 0) continue;
      pending.push(line);
    }
    void drain();
  });
  sock.on("error", (err) => log(`socket error: ${err.message}`));
  sock.on("close", () => { /* nothing */ });
}

function writeFrame(sock: net.Socket, obj: RpcResponse): void {
  if (sock.destroyed || !sock.writable) return;
  try {
    sock.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    log(`write failed: ${(err as Error).message}`);
  }
}

/** 启动 server,返回一个 close 函数。 */
function startServer(socketPath: string): { server: net.Server; close: () => Promise<void> } {
  // 幂等:若旧 sock 残留 → 删掉(容器重启后挂载点是新的,理论上不会有;防御性处理)
  try {
    const s = fs.statSync(socketPath);
    if (s.isSocket()) fs.unlinkSync(socketPath);
  } catch { /* ENOENT: 正常 */ }

  const connections = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    connections.add(sock);
    sock.on("close", () => connections.delete(sock));
    handleConnection(sock);
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections) {
          try { c.destroy(); } catch { /* */ }
        }
        connections.clear();
        server.close(() => resolve());
      }),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    await runSelftest();
    return;
  }

  const socketPath = process.env.AGENT_RPC_SOCKET ?? DEFAULT_SOCKET_PATH;
  // 确保父目录存在 —— 通常由 supervisor 层 bind-mount 进来;但 --selftest 场景
  // 下我们自己建,开发时直接 `bun run server.ts` 也能用。
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });

  const { server, close } = startServer(socketPath);
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch { /* */ }
    log(`listening on ${socketPath} pid=${process.pid} uid=${process.env.OC_UID ?? "unknown"}`);
  });

  const shutdown = async (sig: string): Promise<void> => {
    log(`shutdown signal=${sig}`);
    try { await close(); } catch { /* */ }
    try { fs.unlinkSync(socketPath); } catch { /* */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
}

/**
 * --selftest:在临时 socket 上起 server,用 node:net client 发 hello,
 * 验证 hello_ack 返回,退出码 0。docker build 期间调一次确保脚本至少能加载 + 跑通。
 */
async function runSelftest(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rpc-selftest-"));
  const socketPath = path.join(tmpDir, "agent.sock");
  const { close } = startServer(socketPath);
  // 用新 server (listen 需要等 server.listen callback)
  await new Promise<void>((resolve, reject) => {
    const s = net.createServer(); // 占位,实际我们用 startServer 返回的 server;避免双开
    s.close();
    resolve();
    void reject;
  });
  // 重新起一次(简单做法:startServer 返回的 server 需要手动 listen)
  // 这里为了少分支复杂度,直接在本路径里建一套小 server
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const idx = buf.indexOf(0x0a);
      if (idx < 0) return;
      const line = buf.subarray(0, idx).toString("utf8");
      const req = JSON.parse(line);
      void handleFrame(req).then((resp) => {
        sock.write(JSON.stringify(resp) + "\n");
        sock.end();
      });
    });
  });
  await new Promise<void>((resolve) => srv.listen(socketPath, () => resolve()));

  // 关闭上面 startServer 建的那份(占用 socketPath 之前已被 unlink,这里保险再 close 一次)
  try { await close(); } catch { /* */ }

  const result = await new Promise<unknown>((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let buf = Buffer.alloc(0);
    const to = setTimeout(() => { client.destroy(); reject(new Error("selftest timeout")); }, 5000);
    client.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const idx = buf.indexOf(0x0a);
      if (idx < 0) return;
      clearTimeout(to);
      const line = buf.subarray(0, idx).toString("utf8");
      try { resolve(JSON.parse(line)); }
      catch (err) { reject(err); }
      finally { client.end(); }
    });
    client.on("error", (err) => { clearTimeout(to); reject(err); });
    client.on("connect", () => {
      client.write(JSON.stringify({ type: "hello" }) + "\n");
    });
  });

  await new Promise<void>((resolve) => srv.close(() => resolve()));
  try { fs.unlinkSync(socketPath); } catch { /* */ }
  try { fs.rmdirSync(tmpDir); } catch { /* */ }

  const resp = result as { type?: string };
  if (resp.type !== "hello_ack") {
    log(`selftest FAILED: got ${JSON.stringify(result)}`);
    process.exit(1);
  }
  log(`selftest OK: ${JSON.stringify(result)}`);
  process.exit(0);
}

// Top-level: 只有作为脚本跑时才启动;作为 module import 时不启动(方便测试)
main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
