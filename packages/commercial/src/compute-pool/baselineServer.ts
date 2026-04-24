/**
 * baselineServer — master 侧内部 mTLS HTTP server,为远程 node-agent
 * 提供 CCB baseline 的 version + tarball 同步端点。
 *
 * 监听:默认 127.0.0.1:18792(仅 loopback;远程 node-agent 通过 Caddy
 * 反向代理或由 node-bootstrap 阶段注入的 master 内网 URL 访问)。
 *
 * 认证(双因子):
 *   1. mTLS 客户端证书校验(Node 内置,chain to ensureCa())
 *   2. SAN URI 必须形如 spiffe://openclaude/host/<uuid>
 *   3. Bearer PSK 与该 host 在 compute_hosts.agent_psk_* 解出的明文 timingSafeEqual
 *
 * 路由:
 *   GET /internal/v3/baseline-version  →  {"version":"sha256:..."}
 *   GET /internal/v3/baseline-tarball  →  application/gzip, X-Baseline-Version 头
 *
 * Tarball 构建:
 *   `tar -C <baselineDir> --sort=name --mtime=@0 --owner=0 --group=0
 *        --numeric-owner -czf - CLAUDE.md skills`
 *   (reproducible:内容不变则 bytes 不变 → sha256 不变 → node-agent 不重复 pull)
 *
 * 定期 rebuild(默认 5min)— boss 改 baseline 目录内容后最长 5min + 60s poll
 * 收敛到所有 host。
 */

import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { rootLogger } from "../logging/logger.js";
import * as queries from "./queries.js";
import { decryptAgentPsk, isSelfPlaceholder } from "./crypto.js";
import {
  ensureCa,
  ensureMasterLeaf,
  extractHostUuidFromSpiffe,
} from "./certAuthority.js";
import { resolveCcbBaselineMounts } from "../agent-sandbox/v3supervisor.js";

export const DEFAULT_BASELINE_SERVER_BIND = "127.0.0.1";
export const DEFAULT_BASELINE_SERVER_PORT = 18792;
const DEFAULT_REBUILD_INTERVAL_MS = 5 * 60_000;
const SAN_URI_PREFIX = "URI:";
const SPIFFE_HOST_PREFIX = "spiffe://openclaude/host/";
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;

export interface BaselineServerOpts {
  bind?: string;
  port?: number;
  /** 已通过 resolveCcbBaselineMounts 校验过的 baseline 绝对路径。 */
  baselineDir: string;
  rebuildIntervalMs?: number;
}

export class BaselineServer {
  private server: HttpsServer | null = null;
  private tarball: Buffer = Buffer.alloc(0);
  private version = "";
  private buildInFlight = false;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private readonly log = rootLogger.child({ subsys: "baseline-server" });

  constructor(private readonly opts: BaselineServerOpts) {}

  async start(): Promise<void> {
    const leaf = await ensureMasterLeaf();
    const ca = await ensureCa();
    const [key, cert, caPem] = await Promise.all([
      readFile(leaf.keyPath),
      readFile(leaf.certPath),
      readFile(ca.caCertPath),
    ]);

    // 启动前必须能成功构一次 tarball;否则拒绝启动(fail-closed)。
    await this.rebuildTarball();

    this.rebuildTimer = setInterval(() => {
      this.rebuildTarball().catch((e) =>
        this.log.warn("tarball rebuild failed", {
          err: e instanceof Error ? e.message : String(e),
        }),
      );
    }, this.opts.rebuildIntervalMs ?? DEFAULT_REBUILD_INTERVAL_MS);
    // unref 让 setInterval 不阻挡 process exit
    this.rebuildTimer.unref?.();

    this.server = createHttpsServer(
      {
        key,
        cert,
        ca: caPem,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
      (req, res) => {
        this.handle(req, res).catch((e) => {
          this.log.error("handler error", {
            err: e instanceof Error ? e.message : String(e),
          });
          try {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
            }
            res.end(JSON.stringify({ code: "HANDLER_FAIL" }));
          } catch {
            // ignore
          }
        });
      },
    );

    const bind = this.opts.bind ?? DEFAULT_BASELINE_SERVER_BIND;
    const port = this.opts.port ?? DEFAULT_BASELINE_SERVER_PORT;
    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      srv.once("error", reject);
      srv.listen(port, bind, () => {
        srv.off("error", reject);
        resolve();
      });
    });
    this.log.info("baseline server listening", {
      bind,
      port,
      version: this.version,
      bytes: this.tarball.length,
    });
  }

  async stop(): Promise<void> {
    if (this.rebuildTimer) {
      clearInterval(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  /** 外部(测试 / admin API)触发强制重建。 */
  async rebuildNow(): Promise<string> {
    await this.rebuildTarball();
    return this.version;
  }

  getVersion(): string {
    return this.version;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "METHOD_NOT_ALLOWED" }));
      return;
    }
    const url = req.url || "";
    const auth = await this.authenticate(req);
    if (!auth.ok) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "UNAUTHORIZED", reason: auth.reason }));
      return;
    }
    if (url === "/internal/v3/baseline-version") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ version: this.version }));
      return;
    }
    if (url === "/internal/v3/baseline-tarball") {
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "X-Baseline-Version": this.version,
        "Content-Length": String(this.tarball.length),
        "Cache-Control": "no-store",
      });
      res.end(this.tarball);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "NOT_FOUND" }));
  }

  private async authenticate(
    req: IncomingMessage,
  ): Promise<{ ok: true; hostUuid: string } | { ok: false; reason: string }> {
    const sock = req.socket as TLSSocket;
    if (!sock || sock.authorized !== true) {
      return { ok: false, reason: "tls_not_authorized" };
    }
    const peer = sock.getPeerCertificate();
    if (!peer || !peer.subjectaltname) {
      return { ok: false, reason: "no_san" };
    }
    const uriSan = peer.subjectaltname
      .split(",")
      .map((s) => s.trim())
      .find((s) => s.startsWith(SAN_URI_PREFIX));
    if (!uriSan) return { ok: false, reason: "no_uri_san" };
    const uri = uriSan.slice(SAN_URI_PREFIX.length);
    if (!uri.startsWith(SPIFFE_HOST_PREFIX)) {
      return { ok: false, reason: "not_host_spiffe" };
    }
    const hostUuid = extractHostUuidFromSpiffe(uri);
    if (!hostUuid) return { ok: false, reason: "malformed_spiffe" };

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return { ok: false, reason: "no_bearer" };
    }
    const presented = Buffer.from(authHeader.slice("Bearer ".length).trim(), "utf8");

    const row = await queries.getHostById(hostUuid);
    if (!row) return { ok: false, reason: "host_not_found" };
    if (isSelfPlaceholder(row.agent_psk_nonce, row.agent_psk_ct)) {
      // self host 不应通过 baselineServer 拉自己的 baseline
      return { ok: false, reason: "self_host_no_psk" };
    }
    const expectedRaw = decryptAgentPsk(row.id, row.agent_psk_nonce, row.agent_psk_ct);
    // 线上/磁盘用 hex 文本传输,这里对齐比较格式。
    const expected = Buffer.from(expectedRaw.toString("hex"), "utf8");
    expectedRaw.fill(0);
    try {
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      ) {
        return { ok: false, reason: "psk_mismatch" };
      }
    } finally {
      expected.fill(0);
      presented.fill(0);
    }
    return { ok: true, hostUuid };
  }

  private async rebuildTarball(): Promise<void> {
    if (this.buildInFlight) return;
    this.buildInFlight = true;
    try {
      const mounts = resolveCcbBaselineMounts(this.opts.baselineDir);
      if (!mounts) {
        throw new Error(
          `baseline dir invalid or failed security validation: ${this.opts.baselineDir}`,
        );
      }

      // reproducible tar:内容不变 → bytes 不变 → sha256 不变
      const args = [
        "-C",
        this.opts.baselineDir,
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        "-",
        "CLAUDE.md",
        "skills",
      ];
      const buf = await new Promise<Buffer>((resolve, reject) => {
        const p = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        const errs: Buffer[] = [];
        let total = 0;
        p.stdout.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_TARBALL_BYTES) {
            p.kill("SIGKILL");
            reject(new Error(`tarball exceeds ${MAX_TARBALL_BYTES} bytes`));
            return;
          }
          chunks.push(c);
        });
        p.stderr.on("data", (c: Buffer) => errs.push(c));
        p.on("error", reject);
        p.on("close", (code) => {
          if (code !== 0) {
            return reject(
              new Error(
                `tar exit ${code}: ${Buffer.concat(errs).toString("utf8").slice(0, 500)}`,
              ),
            );
          }
          resolve(Buffer.concat(chunks));
        });
      });
      const version = "sha256:" + createHash("sha256").update(buf).digest("hex");
      if (version === this.version && this.tarball.length === buf.length) {
        // 无变化,跳过
        return;
      }
      this.tarball = buf;
      this.version = version;
      this.log.info("baseline tarball rebuilt", {
        version,
        bytes: buf.length,
      });
    } finally {
      this.buildInFlight = false;
    }
  }
}

let _singleton: BaselineServer | null = null;

/** 单例初始化(调用方在 master 启动阶段调 start)。 */
export function getBaselineServer(opts?: BaselineServerOpts): BaselineServer {
  if (!_singleton) {
    if (!opts) {
      throw new Error("baseline server not initialized; pass opts on first call");
    }
    _singleton = new BaselineServer(opts);
  }
  return _singleton;
}

/** 测试用:重置单例。 */
export function _resetBaselineServer(): void {
  _singleton = null;
}
