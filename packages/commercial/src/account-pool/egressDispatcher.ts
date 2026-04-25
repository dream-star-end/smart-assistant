/**
 * 账号专属出口 dispatcher 工厂。两种 egress 模式:
 *
 *   1. **Plain HTTP(S) proxy**(`egress_proxy`,admin 手填)
 *      - 0010 migration 引入。format `http(s)://[user:pass@]host[:port]`
 *      - 适用:第三方 HTTP 代理服务,不需要 mTLS
 *      - 走 undici `ProxyAgent({uri})`,与原 HIGH#5 实现等价
 *
 *   2. **mTLS forward proxy on node-agent**(`EgressTarget`,自动分配)
 *      - 0038 migration 引入。每台 compute_host 上的 node-agent 监听 :9444 ——
 *        master mTLS + Bearer PSK 鉴权后做 CONNECT api.anthropic.com:443 转发
 *      - 适用:platform 自家虚机池,稳定 IP 不依赖第三方代理
 *      - 走 undici `ProxyAgent({uri, proxyTls, headers})`,proxyTls 出示 master leaf
 *        + sync `checkServerIdentity` 校验 host leaf 的 sha256 指纹与 SPIFFE SAN
 *
 * 优先级(scheduler 决定):**plain 优先**。admin 手填 `egress_proxy` 视作显式覆盖,
 * 不论是否分配了 host(EgressTarget),都走 plain。EgressTarget 仅在 plain 缺时启用。
 *
 * cache key 设计:
 *   - plain: `${accountId}|plain:${proxyUrl}`
 *   - mtls : `${accountId}|mtls:${hostUuid}|fp:${hostFp}|cv:${certVersion}`
 *     `certVersion` = master leaf cert 内容 hash;cert 续期 → 新 entry,旧 entry 被
 *     evictByAccount 清理(同一 account 同一时刻只持一份)
 *
 * cache 大小 LRU 上限 64;单 deployment 活跃账号通常 < 20。
 *
 * 缓存内 PSK 处理:mTLS entry 解密 PSK 后**长期**留在 entry.pskBuf 里(供 ProxyAgent
 * 重连复用 Authorization 头)。evict 时 `.fill(0)` 清零并 `dispatcher.close()`。
 * 这是密码学纪律的弱化(明文 PSK 长期驻留),但短期清零会让每个新连接都要异步
 * 解密 → 性能不可接受。tradeoff:接受长期持有,evict 时必清零。
 *
 * 安全:
 *   - plain 路径:proxy 看到的是 TLS 密文(CONNECT 隧道);代理本身泄露不会暴露 OAuth
 *   - mtls 路径:外部主动伪装 master 需要(a)拿到 master 私钥(b)拿到 host PSK
 *     双因子防护;两者都驻留 master 进程内存
 *   - 不在 log 里打 raw proxyUrl(可能含密码),只打 host
 */

import { ProxyAgent, type Dispatcher } from "undici";
import { timingSafeEqual, type X509Certificate } from "node:crypto";

import { rootLogger } from "../logging/logger.js";
import {
  decryptAgentPsk,
  isSelfPlaceholder,
} from "../compute-pool/crypto.js";
import { getMasterTlsForEgress } from "../compute-pool/nodeAgentClient.js";
import { hostSpiffeUri } from "../compute-pool/certAuthority.js";

/** LRU 上限。一个商用部署的活跃账号一般 < 20 个,64 留余量。 */
export const EGRESS_DISPATCHER_CACHE_MAX = 64;

/** close ProxyAgent 的超时。SSE 持流时 close 会等到流结束;超时丢资源。 */
export const EGRESS_DISPATCHER_CLOSE_TIMEOUT_MS = 5_000;

/**
 * mTLS forward proxy 的目标:account 已分配的 compute_host。
 * 字段全部由 scheduler.getTokenForUse 的 JOIN SQL 取出,callers 不再回查 DB。
 *
 * 加密 PSK 字段(nonce + ct)随结构体传输,在 dispatcher cache miss 时才解密一次。
 * 解密后的 plaintext PSK 仅 cache entry 持有,不二次外传。
 */
export interface EgressTargetMtls {
  kind: "mtls";
  /** compute_hosts.id —— cache key + SPIFFE SAN 校验对照 */
  hostUuid: string;
  /** node-agent IP / hostname */
  host: string;
  /** node-agent forward proxy 端口(典型 9444) */
  port: number;
  /** 期望的 host leaf cert sha256 fingerprint(lowercase hex,无 colon) */
  fingerprint: string;
  /** AEAD nonce(crypto.decryptAgentPsk 入参) */
  pskNonce: Buffer;
  /** AEAD ciphertext */
  pskCt: Buffer;
}

export type EgressTarget = EgressTargetMtls;

interface PlainCacheEntry {
  key: string;
  kind: "plain";
  proxyUrl: string;
  dispatcher: Dispatcher;
  lastUsed: number;
}

interface MtlsCacheEntry {
  key: string;
  kind: "mtls";
  hostUuid: string;
  fingerprint: string;
  certVersion: string;
  /**
   * 解密后的 PSK 明文。entry 销毁时必 `.fill(0)`。
   * 长期驻留是 perf tradeoff(每连接都解密太重)。
   */
  pskBuf: Buffer;
  dispatcher: Dispatcher;
  lastUsed: number;
}

type CacheEntry = PlainCacheEntry | MtlsCacheEntry;

const _cache = new Map<string, CacheEntry>();

const log = rootLogger.child({ subsys: "egressDispatcher" });

function _plainCacheKey(accountId: bigint | string, proxyUrl: string): string {
  return `${String(accountId)}|plain:${proxyUrl}`;
}

function _mtlsCacheKey(
  accountId: bigint | string,
  hostUuid: string,
  fingerprint: string,
  certVersion: string,
): string {
  return `${String(accountId)}|mtls:${hostUuid}|fp:${fingerprint}|cv:${certVersion}`;
}

/** 仅暴露 host(去 userinfo + path),用于 log,不打密码。 */
function _proxyHostForLog(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch {
    return "<malformed>";
  }
}

/**
 * 取/建账号专属出口 dispatcher。
 *
 *   - **plain 优先**:`egressProxy` 非空 → 走 plain(忽略 egressTarget,admin 手填覆盖)
 *   - 否则 `egressTarget` 非空 → 走 mTLS forward proxy
 *   - 都空 → undefined(走 master 默认出口)
 *
 * 命中 cache 复用;同 account 任何参数变化(切 URL / 换 host / cert 续期)都会 evict
 * 旧 entry 后建新 entry。
 *
 * 失败(URL 解析挂 / PSK 解密挂 / master TLS 加载挂)→ 返 undefined 并 warn。
 * **不抛**:chat 路径不应因为出口配置烂直接 502;退化到默认出口让请求过,Anthropic
 * 看到异常 IP 自然会触发 health 扣分,运维感知后修。
 */
export async function getDispatcherForAccount(
  accountId: bigint | string,
  egressProxy: string | null | undefined,
  egressTarget: EgressTarget | null | undefined,
): Promise<Dispatcher | undefined> {
  // plain 路径优先
  if (egressProxy != null && egressProxy.length > 0) {
    return _getPlainDispatcher(accountId, egressProxy);
  }
  if (egressTarget != null && egressTarget.kind === "mtls") {
    return _getMtlsDispatcher(accountId, egressTarget);
  }
  // 都空 → 切回默认出口,清掉旧 entry 防漏 FD
  _evictByAccount(accountId);
  return undefined;
}

function _getPlainDispatcher(
  accountId: bigint | string,
  proxyUrl: string,
): Dispatcher | undefined {
  const key = _plainCacheKey(accountId, proxyUrl);
  const hit = _cache.get(key);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.dispatcher;
  }
  // 同 account 任何旧 entry(plain 切 URL / 切到 mtls 又切回)→ evict
  _evictByAccount(accountId);

  // 显式 URL 校验:undici ProxyAgent 不在 ctor 时验 URL,只在第一次 dispatch 失败,
  // 那时已无法 fail-fast 退化默认出口。我们在这里挡掉。
  try {
    const u = new URL(proxyUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new TypeError(`unsupported scheme: ${u.protocol}`);
    }
    if (!u.hostname) throw new TypeError("missing host");
  } catch (err) {
    log.warn("egress_proxy_invalid_url", {
      accountId: String(accountId),
      proxyHost: _proxyHostForLog(proxyUrl),
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  let dispatcher: Dispatcher;
  try {
    dispatcher = new ProxyAgent({ uri: proxyUrl });
  } catch (err) {
    log.warn("egress_proxy_invalid", {
      accountId: String(accountId),
      proxyHost: _proxyHostForLog(proxyUrl),
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const entry: PlainCacheEntry = {
    key,
    kind: "plain",
    proxyUrl,
    dispatcher,
    lastUsed: Date.now(),
  };
  _cache.set(key, entry);
  if (_cache.size > EGRESS_DISPATCHER_CACHE_MAX) _evictLruOnce();
  return dispatcher;
}

async function _getMtlsDispatcher(
  accountId: bigint | string,
  target: EgressTargetMtls,
): Promise<Dispatcher | undefined> {
  // master TLS material 必须先拿到才能算 cache key(certVersion 是 key 的一部分)
  let master: Awaited<ReturnType<typeof getMasterTlsForEgress>>;
  try {
    master = await getMasterTlsForEgress();
  } catch (err) {
    log.warn("egress_mtls_master_unavailable", {
      accountId: String(accountId),
      hostUuid: target.hostUuid,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const key = _mtlsCacheKey(accountId, target.hostUuid, target.fingerprint, master.version);
  const hit = _cache.get(key);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.dispatcher;
  }
  _evictByAccount(accountId);

  // 解密 PSK
  if (isSelfPlaceholder(target.pskNonce, target.pskCt)) {
    // self host 不应该作为 egress target(自机出口跟"不走 proxy"等价)
    log.warn("egress_mtls_self_placeholder", {
      accountId: String(accountId),
      hostUuid: target.hostUuid,
    });
    return undefined;
  }
  let pskBuf: Buffer;
  try {
    pskBuf = decryptAgentPsk(target.hostUuid, target.pskNonce, target.pskCt);
  } catch (err) {
    log.warn("egress_mtls_psk_decrypt_failed", {
      accountId: String(accountId),
      hostUuid: target.hostUuid,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  const expectedFp = target.fingerprint.toLowerCase();
  const expectedSpiffe = hostSpiffeUri(target.hostUuid);
  const hostId = target.hostUuid;

  let dispatcher: Dispatcher;
  try {
    dispatcher = new ProxyAgent({
      uri: `https://${target.host}:${target.port}`,
      // proxyTls = 跟 forward proxy 之间的 TLS(我方 client 出示 master leaf,验对方 host leaf)
      // requestTls 由 undici 自动用于 CONNECT 后的 upstream(api.anthropic.com)TLS,不在此覆盖
      proxyTls: {
        ca: master.ca,
        cert: master.cert,
        key: master.key,
        rejectUnauthorized: true,
        servername: "node-agent", // SNI(server 侧不强校)
        // sync hook:与 nodeAgentClient.verifyServerCert 等价但不依赖 openssl 子进程
        checkServerIdentity: (_servername, peerCert) => {
          return _verifyMtlsPeerSync(peerCert, expectedFp, expectedSpiffe, hostId);
        },
      },
      // PSK 第二因子,Bearer hex —— 与 nodeAgentClient rpcCall 同格式
      // 注:每个新 socket undici 都会带这个 header(ProxyAgent 把 headers 注入 CONNECT 请求)
      headers: {
        authorization: `Bearer ${pskBuf.toString("hex")}`,
      },
    });
  } catch (err) {
    pskBuf.fill(0);
    log.warn("egress_mtls_proxy_agent_construct_failed", {
      accountId: String(accountId),
      hostUuid: target.hostUuid,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  const entry: MtlsCacheEntry = {
    key,
    kind: "mtls",
    hostUuid: target.hostUuid,
    fingerprint: expectedFp,
    certVersion: master.version,
    pskBuf,
    dispatcher,
    lastUsed: Date.now(),
  };
  _cache.set(key, entry);
  if (_cache.size > EGRESS_DISPATCHER_CACHE_MAX) _evictLruOnce();
  return dispatcher;
}

/**
 * sync `checkServerIdentity` 实现:
 *   1. peerCert.fingerprint256 == 期望(timing-safe)
 *   2. peerCert.subjectaltname 含 `URI:spiffe://openclaude/host/<uuid>`
 *
 * 返 undefined 通过;返 Error 失败(undici 会拒连)。
 *
 * peerCert 字段说明(node:tls):
 *   - fingerprint256: "AA:BB:CC:..." colon-separated uppercase
 *   - subjectaltname: "DNS:..., URI:spiffe://..., IP Address:..."
 */
function _verifyMtlsPeerSync(
  peerCert: { fingerprint256?: string; subjectaltname?: string } | X509Certificate,
  expectedFp: string,
  expectedSpiffe: string,
  hostId: string,
): Error | undefined {
  // checkServerIdentity 的 peerCert 形参类型是 PeerCertificate(对象,非 X509Certificate)
  const cert = peerCert as { fingerprint256?: string; subjectaltname?: string };

  if (typeof cert.fingerprint256 !== "string" || cert.fingerprint256.length === 0) {
    return new Error(`mtls peer ${hostId}: cert fingerprint unavailable`);
  }
  const fpNorm = cert.fingerprint256.replace(/:/g, "").toLowerCase();
  // timing-safe hex compare
  let fpA: Buffer;
  let fpB: Buffer;
  try {
    fpA = Buffer.from(fpNorm, "hex");
    fpB = Buffer.from(expectedFp, "hex");
  } catch {
    return new Error(`mtls peer ${hostId}: malformed fingerprint hex`);
  }
  if (fpA.length === 0 || fpA.length !== fpB.length || !timingSafeEqual(fpA, fpB)) {
    return new Error(
      `mtls peer ${hostId}: cert fingerprint mismatch (expected ${expectedFp}, got ${fpNorm})`,
    );
  }

  if (typeof cert.subjectaltname !== "string" || cert.subjectaltname.length === 0) {
    return new Error(`mtls peer ${hostId}: cert has no subjectaltname`);
  }
  // SAN 形如 "URI:spiffe://openclaude/host/<uuid>, DNS:..." —— 拆,trim,找 URI: 段
  const uris = cert.subjectaltname
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("URI:"))
    .map((s) => s.slice("URI:".length));
  if (!uris.includes(expectedSpiffe)) {
    return new Error(
      `mtls peer ${hostId}: SAN URI mismatch (expected ${expectedSpiffe}, got [${uris.join(",")}])`,
    );
  }
  return undefined;
}

/** 同 account 任一 entry 都干掉。close 异步 fire-and-forget;mtls entry 顺手清零 PSK。 */
function _evictByAccount(accountId: bigint | string): void {
  const prefix = `${String(accountId)}|`;
  for (const [k, entry] of _cache) {
    if (k.startsWith(prefix)) {
      _cache.delete(k);
      _scheduleClose(entry);
    }
  }
}

function _evictLruOnce(): void {
  let oldestKey: string | null = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [k, entry] of _cache) {
    if (entry.lastUsed < oldestTs) {
      oldestTs = entry.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey == null) return;
  const evicted = _cache.get(oldestKey)!;
  _cache.delete(oldestKey);
  _scheduleClose(evicted);
}

function _scheduleClose(entry: CacheEntry): void {
  // 立即清零 PSK(mtls only)。dispatcher.close() 异步处理 in-flight requests
  if (entry.kind === "mtls") {
    try {
      entry.pskBuf.fill(0);
    } catch {
      /* ignore */
    }
  }
  const closePromise = (async () => {
    try {
      await entry.dispatcher.close();
    } catch {
      /* ignore — 已 closed / errored */
    }
  })();
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, EGRESS_DISPATCHER_CLOSE_TIMEOUT_MS).unref();
  });
  void Promise.race([closePromise, timeoutPromise]);
}

/** gateway shutdown 时调:把所有 dispatcher 都关掉 + 清缓存 + 清零所有 PSK。 */
export async function closeAllEgressDispatchers(): Promise<void> {
  const entries = [..._cache.values()];
  _cache.clear();
  for (const entry of entries) {
    if (entry.kind === "mtls") {
      try {
        entry.pskBuf.fill(0);
      } catch {
        /* ignore */
      }
    }
  }
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await Promise.race([
          entry.dispatcher.close(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, EGRESS_DISPATCHER_CLOSE_TIMEOUT_MS).unref(),
          ),
        ]);
      } catch {
        /* ignore */
      }
    }),
  );
}

/** 仅供测试:不 close,直接清 cache。 */
export function _clearEgressDispatcherCacheForTest(): void {
  for (const entry of _cache.values()) {
    if (entry.kind === "mtls") {
      try {
        entry.pskBuf.fill(0);
      } catch {
        /* ignore */
      }
    }
  }
  _cache.clear();
}

/** 仅供测试:cache 大小。 */
export function _egressDispatcherCacheSizeForTest(): number {
  return _cache.size;
}
