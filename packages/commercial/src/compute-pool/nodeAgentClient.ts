/**
 * master → node-agent 的 mTLS HTTPS 客户端。
 *
 * 两类流量:
 *   1. RPC(JSON request/response):run/stop/remove/inspect/list/health/bootstrap-verify/renew-cert
 *   2. Tunnel(method-agnostic,含 WS upgrade):GET/POST/… /tunnel/containers/:cid/…
 *      — userChatBridge 的 WS 代理 + v3readiness HTTP/WS 探活 经由这条
 *
 * mTLS 约束(与 Plan v2 + Codex v2 review 一致):
 *   - client 出示 master leaf(SAN URI `spiffe://openclaude/master`)
 *   - server 出示 host leaf,client 验 (a) 链到本地 CA (b) SAN URI 解出的 host_uuid
 *     == 本连接对应 host.id (c) 指纹 == `compute_hosts.agent_cert_fingerprint_sha256`
 *   - 再加 Bearer psk 头作应用层第二因子(TLS 身份失守后仍挡住 app 层)
 *
 * M1 设计:
 *   - 每请求新建 TLS connection(不池化 keep-alive)— 本 master 单实例,请求量可控;
 *     HTTP/2 + multiplex 推迟
 *   - 单请求超时 30s;caller 需要更长超时(WS tunnel)自己不用这个 wrapper,
 *     改用 `dialTunnelSocket` 直拿 socket
 *   - 错误类型化:AgentUnreachableError(网络/TLS 握手失败)、CertVerifyError(指纹不符)、
 *     AgentAuthError(HTTP 401/403)、AgentAppError(其他 HTTP >=400)
 */

import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { request as httpsRequest } from "node:https";
import type { OutgoingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";

import { rootLogger } from "../logging/logger.js";
import {
  ensureCa,
  ensureMasterLeaf,
  certFingerprintSha256,
  extractSpiffeUris,
  MASTER_SPIFFE_URI,
  hostSpiffeUri,
  CaError,
} from "./certAuthority.js";
import {
  AgentUnreachableError,
  CertVerifyError,
  COMPUTE_POOL_ERR,
  type AgentContainerInspect,
  type AgentHealthResponse,
  type AgentImageInspect,
  type AgentRunContainerRequest,
  type AgentRunContainerResponse,
  type ComputeHostRow,
} from "./types.js";
import { decryptAgentPsk, isSelfPlaceholder } from "./crypto.js";
import { promises as fs } from "node:fs";
import {
  TRACE_ID_HEADER,
  newTraceId,
  parseTraceIdCandidate,
} from "@openclaude/protocol";

const log = rootLogger.child({ subsys: "node-agent-client" });

/**
 * CG3 helper — 把 opts.traceId 解成将要写到 `x-openclaude-trace-id` 头上的最终 trace id。
 *
 * 行为表:
 * | opts.traceId        | 返回                  | 副作用                |
 * | ------------------- | --------------------- | --------------------- |
 * | undefined           | newTraceId() ephemeral | (无)                  |
 * | 合法 string         | opts.traceId 原样     | (无)                  |
 * | 非法(非 string / 长度越界 / 字符集错) | newTraceId() ephemeral | console.warn(不打 raw) |
 *
 * 设计动机:
 * - 非 turn-bound caller(cert renew、baseline poller)不持 turn 上下文 → undefined 不算
 *   错误,ephemeral 即可;不发 warn 避免噪音。
 * - 非法值是 programmer error 或上游被污染数据 → 必须告警,但**不**带 raw 值入日志
 *   (攻击者可能控制该字符串,防 log injection / 撑大字段)。issue 枚举来自
 *   `parseTraceIdCandidate`,与 Go ParseTraceIDCandidate 共享 fixture(CG10)。
 *
 * 用 `console.warn` 而非 logger.warn:这是 client 模块的低频 programmer-error 路径,
 * 引入 module-level logger 注入会让 pure RPC client 变得复杂,不划算。事件名稳定
 * 字符串 "trace-id-invalid" 便于 grep / Loki 告警。
 *
 * 导出供单测使用(`_` 前缀 = 模块内部 seam,业务代码不应直接调用)。
 */
export function _resolveEffectiveTraceId(
  rawTraceId: string | undefined,
  hostId: string,
  path: string,
): string {
  if (rawTraceId === undefined) return newTraceId();
  const parsed = parseTraceIdCandidate(rawTraceId);
  if (parsed.ok) return parsed.traceId;
  const fresh = newTraceId();
  console.warn("node-agent-client: invalid trace id, regenerated", {
    event: "trace-id-invalid",
    hostId,
    path,
    issue: parsed.issue,
    // 故意不打 raw 值;不打 fresh 以避免 log 污染语义(fresh 是 ephemeral,无追溯意义)
  });
  return fresh;
}

/** 单请求默认超时,秒。tunnel socket 不走这条路径,不受限。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** TLS 握手单独超时。 */
const TLS_HANDSHAKE_TIMEOUT_MS = 10_000;

// ─── Master TLS material 缓存 ─────────────────────────────────────────

interface MasterTlsMaterial {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
  notAfter: Date;
  /**
   * cert PEM 字节的 sha256 前 16 hex(64-bit 熵足够区分续期版本)。
   * 用作 egressDispatcher cache key 的一部分:master leaf 续期 → version 变 → 旧 ProxyAgent
   * 自动失效,避免新连接继续出示老 cert(节点 :9444 端会基于 SAN 拒绝)。
   * 用 PEM 而非 DER 算:省一步 PEM→DER 转换;PEM 与 DER 一一对应,版本变化检测等价。
   */
  version: string;
}

let cachedMaster: MasterTlsMaterial | null = null;
let cachedMasterLoadedAt = 0;
const MASTER_RELOAD_CHECK_MS = 60_000; // 1 分钟看一次是否要续期

async function getMasterTls(): Promise<MasterTlsMaterial> {
  const now = Date.now();
  if (cachedMaster && now - cachedMasterLoadedAt < MASTER_RELOAD_CHECK_MS) {
    return cachedMaster;
  }
  const leaf = await ensureMasterLeaf();
  const ca = await ensureCa();
  const [key, cert, caBuf] = await Promise.all([
    fs.readFile(leaf.keyPath),
    fs.readFile(leaf.certPath),
    fs.readFile(ca.caCertPath),
  ]);
  const version = createHash("sha256").update(cert).digest("hex").slice(0, 16);
  cachedMaster = { key, cert, ca: caBuf, notAfter: leaf.notAfter, version };
  cachedMasterLoadedAt = now;
  return cachedMaster;
}

/** 测试 / 续期后调用清缓存。 */
export function invalidateMasterTlsCache(): void {
  cachedMaster = null;
  cachedMasterLoadedAt = 0;
}

/**
 * Master TLS material + 版本 hash,供 egressDispatcher 构造 mTLS ProxyAgent。
 *
 * 版本来源:cert PEM 字节的 sha256 前 16 hex。master leaf 续期 → version 变 →
 * dispatcher cache key 变 → 旧 ProxyAgent 自动失效,新连接以新 cert 出口。
 *
 * 1 分钟内多次调用复用同一 material;cert renewal 周期(月级)远长于此,
 * 实际不会有"续期完仍用旧 cert"的窗口。
 */
export async function getMasterTlsForEgress(): Promise<{
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
  version: string;
}> {
  const m = await getMasterTls();
  return { key: m.key, cert: m.cert, ca: m.ca, version: m.version };
}

// ─── Cert 指纹 pinning ────────────────────────────────────────────────

async function verifyServerCert(
  socket: TLSSocket,
  expectedHostUuid: string,
  expectedFingerprint: string | null,
): Promise<void> {
  const peerCert = socket.getPeerCertificate(true);
  if (!peerCert || Object.keys(peerCert).length === 0) {
    throw new CertVerifyError("server presented no certificate");
  }
  // 链验证已由 tls.connect(ca, rejectUnauthorized=true) 完成;这里只做:
  // 1. SAN URI 解出 expected host_uuid
  // 2. 指纹对比(若 pin 存在)
  const certDer = peerCert.raw;
  if (!certDer) {
    throw new CertVerifyError("server cert has no raw DER");
  }
  // node 返的指纹是 colon-separated uppercase;统一 lowercase 无 colon
  const fpNode =
    typeof peerCert.fingerprint256 === "string"
      ? peerCert.fingerprint256.replace(/:/g, "").toLowerCase()
      : null;

  if (!fpNode) {
    throw new CertVerifyError("server cert fingerprint unavailable");
  }

  if (expectedFingerprint) {
    // timing-safe compare hex 字符串
    const a = Buffer.from(fpNode, "hex");
    const b = Buffer.from(expectedFingerprint.toLowerCase(), "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new CertVerifyError(
        `server cert fingerprint mismatch: expected ${expectedFingerprint}, got ${fpNode}`,
      );
    }
  }

  // 解 SAN URI(通过 PEM 走 openssl,避免跟 node cert obj 的 tls.peer
  // 结构做字符串拼接)
  const pem = derToPem(certDer, "CERTIFICATE");
  let uris: string[];
  try {
    uris = await extractSpiffeUris(pem);
  } catch (e) {
    throw new CertVerifyError("cannot extract SAN URIs from server cert");
  }
  const expected = hostSpiffeUri(expectedHostUuid);
  if (!uris.includes(expected)) {
    throw new CertVerifyError(
      `server cert SAN URI mismatch: expected ${expected}, got [${uris.join(",")}]`,
    );
  }
}

function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// ─── Client ───────────────────────────────────────────────────────────

export interface NodeAgentTarget {
  hostId: string;
  host: string;
  agentPort: number;
  expectedFingerprint: string | null;
  /** 已解密的 psk(调用方负责清零);self host 是 null。 */
  psk: Buffer | null;
}

/**
 * 从 ComputeHostRow 解密 psk 并组装 target。
 * 调用方用完 target.psk 后应 `.fill(0)` 清零。
 */
export function hostRowToTarget(row: ComputeHostRow): NodeAgentTarget {
  let psk: Buffer | null = null;
  if (!isSelfPlaceholder(row.agent_psk_nonce, row.agent_psk_ct)) {
    psk = decryptAgentPsk(row.id, row.agent_psk_nonce, row.agent_psk_ct);
  }
  return {
    hostId: row.id,
    host: row.host,
    agentPort: row.agent_port,
    expectedFingerprint: row.agent_cert_fingerprint_sha256,
    psk,
  };
}

// ─── 基础 RPC ────────────────────────────────────────────────────────

export class AgentAuthError extends Error {
  readonly code = COMPUTE_POOL_ERR.AGENT_AUTH;
  constructor(
    readonly hostId: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentAuthError";
  }
}

export class AgentAppError extends Error {
  readonly code = "AGENT_APP_ERROR" as const;
  constructor(
    readonly hostId: string,
    readonly httpStatus: number,
    readonly agentErrCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AgentAppError";
  }
}

interface RpcOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** 原始 body(互斥于 body);用于 PUT /files 上传二进制。 */
  rawBody?: Buffer;
  /** rawBody 的 MIME 类型,默认 application/octet-stream。 */
  rawContentType?: string;
  /** 覆盖默认 30s。 */
  timeoutMs?: number;
  /**
   * CG3: 透传给 node-agent 的 trace id。
   *
   * - 合法(parseTraceIdCandidate ok)→ 原样写到 `x-openclaude-trace-id` 头
   * - 非法或缺失 → rpcCall 内生成 ephemeral trace(newTraceId)+ console.warn
   *
   * 调用方契约:caller 应该传 turn-level 或 connection-level canonical traceId;
   * undefined 在控制平面里通常是 "non-turn-bound" 路径(certRenew / baseline poller)
   * — 这些 caller 不持有 turn 上下文,接受 ephemeral fallback 即可,不算错误。
   */
  traceId?: string;
}

async function rpcCall<T>(target: NodeAgentTarget, opts: RpcOptions): Promise<T> {
  const master = await getMasterTls();
  if (opts.body !== undefined && opts.rawBody !== undefined) {
    throw new Error("rpcCall: body and rawBody are mutually exclusive");
  }
  let bodyBuf: Buffer | null = null;
  let bodyContentType: string | null = null;
  if (opts.rawBody !== undefined) {
    bodyBuf = opts.rawBody;
    bodyContentType = opts.rawContentType ?? "application/octet-stream";
  } else if (opts.body !== undefined) {
    bodyBuf = Buffer.from(JSON.stringify(opts.body), "utf8");
    bodyContentType = "application/json";
  }

  const headers: OutgoingHttpHeaders = {
    accept: "application/json",
  };
  if (bodyBuf) {
    headers["content-type"] = bodyContentType!;
    headers["content-length"] = bodyBuf.length;
  }
  // CG3: trace id 头注入,跨 master → node-agent 边界。详见 _resolveEffectiveTraceId。
  headers[TRACE_ID_HEADER] = _resolveEffectiveTraceId(opts.traceId, target.hostId, opts.path);
  if (target.psk) {
    headers["authorization"] = `Bearer ${target.psk.toString("hex")}`;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (err: Error | null, val?: T): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val as T);
    };

    const req = httpsRequest(
      {
        host: target.host,
        port: target.agentPort,
        method: opts.method ?? (bodyBuf ? "POST" : "GET"),
        path: opts.path,
        headers,
        ca: master.ca,
        cert: master.cert,
        key: master.key,
        rejectUnauthorized: true,
        // CA 链仍由 Node 验;身份(SPIFFE URI + fingerprint pin)交给 verifyServerCert。
        // cert 没 DNS/IP SAN,默认 checkServerIdentity 必定失败,需要 bypass。
        checkServerIdentity: () => undefined,
        servername: "node-agent", // SNI(server 侧按需校验)
        timeout: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
        // TLS 握手本身也要快,否则 settle timeout
        // Node 20 的 https.globalAgent 默认 keepAlive:true;本 RPC 文件头 L16 约定
        // "每请求新建 TLS connection(不池化)"。若走 globalAgent,pooled TLSSocket
        // 在并发轮询下会让 getPeerCertificate() 返回空 cert,cert pinning 误触发
        // "server presented no certificate"。`agent: false` 把实现拉回设计意图。
        agent: false,
      },
      (res) => {
        // 握手刚完成时 res.socket 必定指向当前 TLSSocket;闭包抓住,避免 end 事件
        // 后被 keep-alive 回池或 Node 内部置空导致 getPeerCertificate 报 null。
        const sock = res.socket as TLSSocket | null;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", async () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          // mTLS cert 已经通过 ca+rejectUnauthorized 验了链;还要验 SAN URI + pin
          if (!sock) {
            settle(new CertVerifyError(`tls socket unavailable at response for ${target.hostId}`));
            return;
          }
          try {
            await verifyServerCert(sock, target.hostId, target.expectedFingerprint);
          } catch (e) {
            settle(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          if (status === 401 || status === 403) {
            settle(new AgentAuthError(target.hostId, status, `agent auth failed: ${raw.slice(0, 200)}`));
            return;
          }
          if (status >= 400) {
            let agentCode: string | null = null;
            try {
              const parsed = JSON.parse(raw) as { code?: string; error?: string };
              if (parsed && typeof parsed.code === "string") agentCode = parsed.code;
            } catch { /* raw stays */ }
            settle(new AgentAppError(
              target.hostId,
              status,
              agentCode,
              // 4000 字符 cap:docker daemon 报错(VOL_CREATE_FAIL / RUN_FAIL 等)
              // 通常 < 500 字符,4000 留余量看完整 stack;1.0.10 之前的 400 cap
              // 让 v1.0.8/9 排查时关键栈被截断。
              `agent returned ${status}: ${raw.slice(0, 4000)}`,
            ));
            return;
          }
          if (raw.length === 0) {
            settle(null, undefined as T);
            return;
          }
          try {
            settle(null, JSON.parse(raw) as T);
          } catch (e) {
            settle(new AgentAppError(
              target.hostId,
              status,
              null,
              `agent returned non-JSON body: ${raw.slice(0, 2000)}`,
            ));
          }
        });
        res.on("error", (e) => settle(e));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      settle(new AgentUnreachableError(target.hostId, `request timeout to ${target.host}:${target.agentPort}${opts.path}`));
    });
    req.on("error", (err) => {
      settle(new AgentUnreachableError(
        target.hostId,
        `request to ${target.host}:${target.agentPort}${opts.path} failed: ${err.message}`,
      ));
    });
    if (bodyBuf) req.end(bodyBuf);
    else req.end();
  });
}

/**
 * rpcCallBinary — rpcCall 的二进制响应变体。
 *
 * 与 rpcCall 共享一切(mTLS/CA pinning/SPIFFE 验/auth/超时/trace 头),只在
 * 成功响应路径返回 raw Buffer 而非 JSON.parse。错误路径仍尝试把 body 当 JSON
 * 解出 agent code(node-agent 错误响应固定 application/json {code,error}),
 * 与 JSON RPC 的 AgentAppError 体验对齐。
 *
 * 设计:为 GET /files binary 流量量身定制。复制 rpcCall 主体而非加 flag,
 * 是为了把"JSON RPC"和"byte RPC"的契约钉死在函数边界 — 类型签名 Buffer
 * 而非 unknown,调用者编译期 type-safe;未来加 streaming RPC 不会污染 JSON 路径。
 *
 * 受限 RpcOptions:
 *   - body / rawBody 仍互斥(GET 通常无 body,允许 caller 自由)
 *   - 不接受 expectBinary 等额外配置(就一个"返 Buffer"用途,无配置面)
 */
async function rpcCallBinary(target: NodeAgentTarget, opts: RpcOptions): Promise<Buffer> {
  const master = await getMasterTls();
  if (opts.body !== undefined && opts.rawBody !== undefined) {
    throw new Error("rpcCallBinary: body and rawBody are mutually exclusive");
  }
  let bodyBuf: Buffer | null = null;
  let bodyContentType: string | null = null;
  if (opts.rawBody !== undefined) {
    bodyBuf = opts.rawBody;
    bodyContentType = opts.rawContentType ?? "application/octet-stream";
  } else if (opts.body !== undefined) {
    bodyBuf = Buffer.from(JSON.stringify(opts.body), "utf8");
    bodyContentType = "application/json";
  }

  const headers: OutgoingHttpHeaders = {
    // 关键差异:这里期望 binary body,告诉 server 偏好 octet-stream
    accept: "application/octet-stream",
  };
  if (bodyBuf) {
    headers["content-type"] = bodyContentType!;
    headers["content-length"] = bodyBuf.length;
  }
  headers[TRACE_ID_HEADER] = _resolveEffectiveTraceId(opts.traceId, target.hostId, opts.path);
  if (target.psk) {
    headers["authorization"] = `Bearer ${target.psk.toString("hex")}`;
  }

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const settle = (err: Error | null, val?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val as Buffer);
    };

    const req = httpsRequest(
      {
        host: target.host,
        port: target.agentPort,
        method: opts.method ?? (bodyBuf ? "POST" : "GET"),
        path: opts.path,
        headers,
        ca: master.ca,
        cert: master.cert,
        key: master.key,
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        servername: "node-agent",
        timeout: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
        agent: false,
      },
      (res) => {
        const sock = res.socket as TLSSocket | null;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", async () => {
          const status = res.statusCode ?? 0;
          if (!sock) {
            settle(new CertVerifyError(`tls socket unavailable at response for ${target.hostId}`));
            return;
          }
          try {
            await verifyServerCert(sock, target.hostId, target.expectedFingerprint);
          } catch (e) {
            settle(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          if (status === 401 || status === 403) {
            const raw = Buffer.concat(chunks).toString("utf8");
            settle(new AgentAuthError(target.hostId, status, `agent auth failed: ${raw.slice(0, 200)}`));
            return;
          }
          if (status >= 400) {
            const raw = Buffer.concat(chunks).toString("utf8");
            let agentCode: string | null = null;
            try {
              const parsed = JSON.parse(raw) as { code?: string; error?: string };
              if (parsed && typeof parsed.code === "string") agentCode = parsed.code;
            } catch { /* raw stays */ }
            settle(new AgentAppError(
              target.hostId,
              status,
              agentCode,
              `agent returned ${status}: ${raw.slice(0, 4000)}`,
            ));
            return;
          }
          settle(null, Buffer.concat(chunks));
        });
        res.on("error", (e) => settle(e));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      settle(new AgentUnreachableError(target.hostId, `request timeout to ${target.host}:${target.agentPort}${opts.path}`));
    });
    req.on("error", (err) => {
      settle(new AgentUnreachableError(
        target.hostId,
        `request to ${target.host}:${target.agentPort}${opts.path} failed: ${err.message}`,
      ));
    });
    if (bodyBuf) req.end(bodyBuf);
    else req.end();
  });
}

// ─── 高层 API ────────────────────────────────────────────────────────

export async function runContainer(
  target: NodeAgentTarget,
  spec: AgentRunContainerRequest,
  opts?: { traceId?: string },
): Promise<AgentRunContainerResponse> {
  return rpcCall<AgentRunContainerResponse>(target, {
    path: "/containers/run",
    method: "POST",
    body: spec,
    // 启容器包含 docker pull 等可能变慢,拉长到 120s
    timeoutMs: 120_000,
    traceId: opts?.traceId,
  });
}

export async function stopContainer(
  target: NodeAgentTarget,
  containerInternalId: string,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall(target, {
    path: `/containers/${encodeURIComponent(containerInternalId)}/stop`,
    method: "POST",
    timeoutMs: 60_000,
    traceId: opts?.traceId,
  });
}

export async function removeContainer(
  target: NodeAgentTarget,
  containerInternalId: string,
  force = true,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall(target, {
    path: `/containers/${encodeURIComponent(containerInternalId)}/remove?force=${force ? 1 : 0}`,
    method: "POST",
    timeoutMs: 60_000,
    traceId: opts?.traceId,
  });
}

export async function inspectContainer(
  target: NodeAgentTarget,
  containerInternalId: string,
  opts?: { traceId?: string },
): Promise<AgentContainerInspect> {
  return rpcCall<AgentContainerInspect>(target, {
    path: `/containers/${encodeURIComponent(containerInternalId)}/inspect`,
    method: "GET",
    traceId: opts?.traceId,
  });
}

/**
 * POST /image/inspect — host 上 docker image inspect by tag。
 *
 * Stage 3+9 v3-sink 能力守门用:caller 拿到 (id, repoTags, labels) 后比对
 * `oc.runtime.features` / `oc.runtime.git_sha` 与 desired image Id。
 *
 * 错误形状(rpcCall 已统一处理,不在本函数内特殊化):
 *   - 200 → AgentImageInspect
 *   - 404 with body `{"code":"IMAGE_NOT_FOUND",...}` → AgentAppError(httpStatus=404,
 *     agentErrCode="IMAGE_NOT_FOUND") — caller 区分"image absent" vs "route absent
 *     /版本未升级"。注意旧 nodeAgent 没这条 handler 时,Go 默认 mux 404 是 plain
 *     text,JSON.parse 失败 → agentErrCode === null,需要 caller 拒绝转 null。
 *   - 其它非 2xx → AgentAppError;网络/TLS → AgentUnreachableError/CertVerifyError
 */
export async function inspectImage(
  target: NodeAgentTarget,
  tag: string,
  opts?: { traceId?: string },
): Promise<AgentImageInspect> {
  return rpcCall<AgentImageInspect>(target, {
    path: "/image/inspect",
    method: "POST",
    body: { tag },
    timeoutMs: 15_000,
    traceId: opts?.traceId,
  });
}

export async function listContainers(
  target: NodeAgentTarget,
  opts?: { traceId?: string },
): Promise<AgentContainerInspect[]> {
  return rpcCall<AgentContainerInspect[]>(target, {
    path: "/containers",
    method: "GET",
    traceId: opts?.traceId,
  });
}

export async function healthCheck(
  target: NodeAgentTarget,
  opts?: { traceId?: string },
): Promise<AgentHealthResponse> {
  return rpcCall<AgentHealthResponse>(target, {
    path: "/health",
    method: "GET",
    timeoutMs: 5_000,
    traceId: opts?.traceId,
  });
}

export async function bootstrapVerify(
  target: NodeAgentTarget,
  opts?: { traceId?: string },
): Promise<{ ok: boolean; checks: Record<string, boolean>; message?: string }> {
  return rpcCall(target, {
    path: "/bootstrap/verify",
    method: "POST",
    timeoutMs: 20_000,
    traceId: opts?.traceId,
  });
}

/**
 * 续期流程:agent 本地生成 CSR,master 签,agent 热重载。
 * master 这端负责:(1) 发送 renew 请求 with nonce (2) 接收 CSR (3) 调 signHostLeafCsr
 * (4) PUT 新 cert。具体编排在 certAuthority 之外的 service 层做,这里只提供 raw RPC。
 */
export async function requestRenewCert(
  target: NodeAgentTarget,
  nonce: string,
  opts?: { traceId?: string },
): Promise<{ csrPem: string }> {
  return rpcCall(target, {
    path: "/renew-cert",
    method: "POST",
    body: { nonce },
    timeoutMs: 20_000,
    traceId: opts?.traceId,
  });
}

export async function deliverRenewedCert(
  target: NodeAgentTarget,
  nonce: string,
  certPem: string,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall(target, {
    path: "/renew-cert/deliver",
    method: "POST",
    body: { nonce, certPem },
    timeoutMs: 15_000,
    traceId: opts?.traceId,
  });
}

// ─── Volume RPC ──────────────────────────────────────────────────────

/** POST /volumes/create  {name}  → 204。节点侧幂等,已存在同名同 label 卷视为成功。 */
export async function createVolume(
  target: NodeAgentTarget,
  name: string,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall<void>(target, {
    path: "/volumes/create",
    method: "POST",
    body: { name },
    timeoutMs: 30_000,
    traceId: opts?.traceId,
  });
}

/** DELETE /volumes/{name} → 204。节点侧幂等,不存在返 204,非 openclaude.v3 卷拒删。 */
export async function removeVolume(
  target: NodeAgentTarget,
  name: string,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall<void>(target, {
    path: `/volumes/${encodeURIComponent(name)}`,
    method: "DELETE",
    timeoutMs: 30_000,
    traceId: opts?.traceId,
  });
}

export interface AgentVolumeInspect {
  exists: boolean;
  mountpoint?: string;
}

/** GET /volumes/{name} → {exists, mountpoint?} */
export async function inspectVolume(
  target: NodeAgentTarget,
  name: string,
  opts?: { traceId?: string },
): Promise<AgentVolumeInspect> {
  return rpcCall<AgentVolumeInspect>(target, {
    path: `/volumes/${encodeURIComponent(name)}`,
    method: "GET",
    timeoutMs: 15_000,
    traceId: opts?.traceId,
  });
}

// ─── File RPC ────────────────────────────────────────────────────────

/**
 * PUT /files?path=<abs>&mode=<octal>[&owner_uid=N&owner_gid=N] body=二进制
 * server 端写到 AllowedRoots 下的 abs 路径;tmp + fsync + (可选 chown) + chmod
 * + rename 原子替换。
 * 超过 16 MiB 返 413;路径不在 AllowedRoots 下返 400。
 *
 * **owner_uid/owner_gid 严格成对**(v1.0.72,需 node-agent ≥ v1.0.72):
 * - 同时省略 → server 端不 chown(向后兼容老调用方)
 * - 同时提供 → server 端在 chmod 之前 chown 到指定 uid/gid(用于让远端容器
 *   内 codex CLI uid 1000 能读 0o400 的 auth.json)
 * - 只提供一个或负数 → server 返 400 BAD_OWNER(避免 chown(-1) 隐式语义)
 *
 * caller 不传 ownerUid/ownerGid 时 query 不拼 owner_*,与老 server (v1.0.71-)
 * 完全等价行为 — rollback 安全。
 */
export async function putFile(
  target: NodeAgentTarget,
  remotePath: string,
  content: Buffer,
  mode: number = 0o600,
  ownerUid?: number,
  ownerGid?: number,
  opts?: { traceId?: string },
): Promise<void> {
  let qs =
    "?path=" +
    encodeURIComponent(remotePath) +
    "&mode=" +
    encodeURIComponent(mode.toString(8));
  // 严格:两者必须同时传或同时不传(与 server 端一致)
  const uidGiven = ownerUid !== undefined;
  const gidGiven = ownerGid !== undefined;
  if (uidGiven !== gidGiven) {
    throw new Error(
      `putFile: ownerUid and ownerGid must both be set or both omitted (got uid=${ownerUid} gid=${ownerGid})`,
    );
  }
  if (uidGiven) {
    qs +=
      "&owner_uid=" +
      encodeURIComponent(String(ownerUid)) +
      "&owner_gid=" +
      encodeURIComponent(String(ownerGid));
  }
  await rpcCall<void>(target, {
    path: "/files" + qs,
    method: "PUT",
    rawBody: content,
    rawContentType: "application/octet-stream",
    timeoutMs: 60_000,
    traceId: opts?.traceId,
  });
}

/** DELETE /files?path=<abs>。不存在视为成功(幂等)。 */
export async function deleteFile(
  target: NodeAgentTarget,
  remotePath: string,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall<void>(target, {
    path: "/files?path=" + encodeURIComponent(remotePath),
    method: "DELETE",
    timeoutMs: 15_000,
    traceId: opts?.traceId,
  });
}

export interface AgentFileStat {
  exists: boolean;
  size?: number;
  mtime?: string;
  sha256?: string;
}

/** GET /files/stat?path=<abs> → {exists, size?, mtime?, sha256?} */
export async function statFile(
  target: NodeAgentTarget,
  remotePath: string,
  opts?: { traceId?: string },
): Promise<AgentFileStat> {
  return rpcCall<AgentFileStat>(target, {
    path: "/files/stat?path=" + encodeURIComponent(remotePath),
    method: "GET",
    timeoutMs: 15_000,
    traceId: opts?.traceId,
  });
}

/**
 * GET /files?path=<abs> → 二进制文件 body(application/octet-stream)。
 * 2026-05-16 hotfix:remote-host 用户场景下 master 读取远端 user docker volume
 * 的 uploads/generated 文件(写镜像 = putFile)。
 *
 * 错误语义:
 *   - 远端 200 + body → 返 Buffer(可能为空文件 = 0 长)
 *   - 远端 404 NOT_FOUND → 返 null(caller 据此 fallback 到另一 dir 或 404 给前端)
 *   - 其他失败(网络/握手/auth/413/parent 防御命中等)→ throw,caller 转 502/500
 *
 * 选 rpcCallBinary 而不是 rpcCall<Buffer> + expectBinary flag:协议契约清晰,
 * 调用者 type-safe;mTLS/cert verify/auth/超时等核心逻辑通过共享 helper 复用。
 *
 * 200MB Buffer 一次性加载到内存与 putFile 的 readFile(tmpPath)对称 — Phase 2 内
 * 不做 streaming 重构,留作后续观察项(p95 / 内存峰值)。
 */
export async function getFile(
  target: NodeAgentTarget,
  remotePath: string,
  opts?: { traceId?: string },
): Promise<Buffer | null> {
  try {
    return await rpcCallBinary(target, {
      path: "/files?path=" + encodeURIComponent(remotePath),
      method: "GET",
      timeoutMs: 60_000,
      traceId: opts?.traceId,
    });
  } catch (err) {
    if (err instanceof AgentAppError && err.httpStatus === 404) {
      return null;
    }
    throw err;
  }
}

// ─── SSH ControlMaster RPC (C.1 stub → C.2 impl) ────────────────────

/**
 * POST /sshmux/start body。远端 node-agent 在本机启 ssh -M -N ControlMaster,
 * sock 落在 `/run/ccb-ssh/u<uid>/h<hid>/ctl.sock`。
 *
 * C.1 本批:仅提供 client 侧 wrapper。endpoint 在 node-agent 里未实现 — 真实调用
 * 目前会拿到 404 / AgentAppError。C.2 把 server 端补齐,C.3 由 scheduler 在容器
 * spawn 前触发。
 *
 * 密码安全边界:password 以 base64 字符串过线,TLS 外层加密。master 这端无法把
 * 中间 JSON 字符串清零(String 不可变),相较本机 fd3 + .fill(0) 的纪律是弱化的
 * — 跨机传输的固有成本。
 */
export interface SshMuxStartArgs {
  uid: number;
  hid: string;
  host: string;
  port: number;
  user: string;
  /** base64(password)。节点侧用完即清零;过线靠 TLS 保护。 */
  passwordB64: string;
  // known_hosts 不在这里传 —— master 先走 /files PUT 写到
  // /run/ccb-ssh/u<uid>/h<hid>/known_hosts(权威通道),start handler
  // 仅校验文件存在并修正权属。避免同一数据两条路径造成不一致。
}

export async function startSshControlMaster(
  target: NodeAgentTarget,
  args: SshMuxStartArgs,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall<void>(target, {
    method: "POST",
    path: "/sshmux/start",
    body: args,
    timeoutMs: 30_000,
    traceId: opts?.traceId,
  });
}

export async function stopSshControlMaster(
  target: NodeAgentTarget,
  uid: number,
  hid: string,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall<void>(target, {
    method: "POST",
    path: "/sshmux/stop",
    body: { uid, hid },
    timeoutMs: 15_000,
    traceId: opts?.traceId,
  });
}

// ─── Baseline RPC ────────────────────────────────────────────────────

/**
 * POST /baseline/refresh → 204。显式触发节点从 master 拉 baseline;
 * 若节点未配置 master_baseline_base_url,返 503(AgentAppError, agentErrCode=BASELINE_DISABLED)。
 */
export async function triggerBaselineRefresh(
  target: NodeAgentTarget,
  opts?: { traceId?: string },
): Promise<void> {
  await rpcCall<void>(target, {
    path: "/baseline/refresh",
    method: "POST",
    // 节点 ForceRefresh 内部 2min 预算,master 侧给 150s 富余
    timeoutMs: 150_000,
    traceId: opts?.traceId,
  });
}

/**
 * GET /baseline/version → {version}。poller 禁用时返 503。
 * opts.timeoutMs 可覆盖默认 10s;admin 聚合查询用更短 timeout 防慢 host 拖累响应。
 * opts.traceId 透传 trace id 头(CG3)。
 */
export async function getBaselineVersion(
  target: NodeAgentTarget,
  opts?: { timeoutMs?: number; traceId?: string },
): Promise<string> {
  const r = await rpcCall<{ version: string }>(target, {
    path: "/baseline/version",
    method: "GET",
    timeoutMs: opts?.timeoutMs ?? 10_000,
    traceId: opts?.traceId,
  });
  return r.version ?? "";
}

// ─── Tunnel(method-agnostic + WS upgrade) ───────────────────────────

export interface TunnelDialOptions {
  target: NodeAgentTarget;
  method: string;
  containerInternalId: string;
  pathAndQuery: string; // 含前导 /,例如 "/healthz" 或 "/chat/sess-x/ws?token=..."
  headers?: Record<string, string>;
  /** 连接超时(握手完成到拿到 socket) */
  connectTimeoutMs?: number;
  /** 若是 WS upgrade 请求,设 true;client 会带 Upgrade: websocket 头并期望 101 响应 */
  upgradeWebSocket?: boolean;
}

/**
 * 建立到 node-agent 的 mTLS+pin TLS socket,**不**写任何 HTTP request line。
 *
 * 用途:bridge tunnel WS factory(`createTunnelContainerSocket`)需要把 socket
 * 交给 ws@8.20 client,让 ws 库自己组 `GET /tunnel/.../ws ... HTTP/1.1` + WS
 * upgrade headers。我们只负责"安全建链"那一段:CA 链 + SPIFFE URI + 指纹 pin
 * 全部通过后才返回。pre-dial 完成,后续 PSK Authorization 头才会上线 — 避免
 * 在 cert 校验未完成时把 PSK 写出去的 TOCTOU。
 *
 * 失败路径:任一阶段 reject 都会先清 listener 并 destroy socket(不留半开链)。
 */
export async function dialNodeAgentVerifiedTls(
  target: NodeAgentTarget,
): Promise<TLSSocket> {
  const master = await getMasterTls();

  const socket: TLSSocket = await new Promise((resolve, reject) => {
    const s = tlsConnect({
      host: target.host,
      port: target.agentPort,
      ca: master.ca,
      cert: master.cert,
      key: master.key,
      rejectUnauthorized: true,
      // 同 request 入口:CA 链验证保留,hostname 匹配交给 verifyServerCert 做 SPIFFE URI + pin
      checkServerIdentity: () => undefined,
      servername: "node-agent",
    });
    let settled = false;
    const cleanup = (): void => {
      s.removeListener("secureConnect", onConnect);
      s.removeListener("error", onError);
      clearTimeout(handshakeTimer);
    };
    const onConnect = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(s);
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try { s.destroy(); } catch { /* */ }
      reject(new AgentUnreachableError(target.hostId, `tls connect failed: ${err.message}`));
    };
    const handshakeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try { s.destroy(); } catch { /* */ }
      reject(new AgentUnreachableError(target.hostId, "tls handshake timeout"));
    }, TLS_HANDSHAKE_TIMEOUT_MS);
    s.once("secureConnect", onConnect);
    s.once("error", onError);
  });

  try {
    await verifyServerCert(socket, target.hostId, target.expectedFingerprint);
  } catch (e) {
    try { socket.destroy(); } catch { /* */ }
    throw e;
  }

  return socket;
}

/**
 * 建立到 node-agent 的 TLS socket,发原始 HTTP 请求,**不 hydrate body**。
 * 专给 readiness 探活用(状态行直接读返回,不走 ws 库帧解析)。
 *
 * TLS 握手 + cert SAN + fingerprint 校验复用 `dialNodeAgentVerifiedTls`;
 * 本函数只在其上多写一段 HTTP/1.1 起始行 + headers。
 *
 * 生命周期:返回的 socket 关闭由调用方负责。出错路径 caller 可捕获后自行决定。
 */
export async function dialTunnelSocket(
  opts: TunnelDialOptions,
): Promise<TLSSocket> {
  const t = opts.target;
  const socket = await dialNodeAgentVerifiedTls(t);

  // 发 HTTP 请求起始行 + headers
  const target = `/tunnel/containers/${encodeURIComponent(opts.containerInternalId)}${opts.pathAndQuery}`;
  const lines: string[] = [
    `${opts.method.toUpperCase()} ${target} HTTP/1.1`,
    `Host: ${t.host}:${t.agentPort}`,
  ];
  if (t.psk) {
    lines.push(`Authorization: Bearer ${t.psk.toString("hex")}`);
  }
  if (opts.upgradeWebSocket) {
    lines.push("Connection: Upgrade");
    lines.push("Upgrade: websocket");
  }
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      // 基础 CRLF 注入防御:header value 不允许含 \r 或 \n
      if (/[\r\n]/.test(v)) {
        socket.destroy();
        throw new Error(`invalid header value for ${k}: contains CR/LF`);
      }
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("", ""); // end of headers
  socket.write(lines.join("\r\n"));

  return socket;
}
