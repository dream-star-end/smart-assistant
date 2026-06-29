/**
 * /v3/research/* — 容器 → master 科研能力 proxy(Phase 1:oc-lit + oc-cite)。
 *
 * 拓扑同 literatureProxy:container CLI → master 18791/18443 → dispatchInternal
 * → verifyContainerIdentity 双因子 → 配额闸 → master 侧执行(查 OpenAlex/Crossref/
 * arXiv;读 research_config 的 mailto/secrets)→ JSON 回容器。
 *
 * 路由:
 *   POST /v3/research/lit/search   {query, sources?, size?, yearMin?, lang?} → {sources, warnings}
 *   POST /v3/research/cite/verify  {identifiers: string[]} → {verdicts}
 *   POST /v3/research/cite/format  {identifier, style} → {verdict}
 *
 * 不变量:平台 secret(S2/Unpaywall 等)留 master,不进容器;enabled=false → 503;
 * 免费源无 key,降级时单源失败进 warnings(见 litSearch)。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { EvidenceManifest } from "@openclaude/protocol/research";
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from "../auth/containerIdentity.js";
import { ensureRequestId, REQUEST_ID_HEADER, setSecurityHeaders } from "../http/util.js";
import {
  type ResearchConfigPublic,
  type ResearchSecrets,
  getResearchConfigPublic,
  getResearchSecrets,
} from "../admin/researchConfig.js";
import {
  getBlob as storeGetBlob,
  getDocument as storeGetDocument,
  putBlob as storePutBlob,
  putDocument as storePutDocument,
} from "./store.js";
import { ingestBlob, litragQuery, runCheck, runCiteFix } from "./researchHandlers.js";
import { queryDocuments } from "./litrag.js";
import type { FetchLike } from "./sources.js";
import { type LitSourceName, searchMultiSource } from "./litSearch.js";
import { formatRecord, verifyIdentifier, verifyIdentifiers } from "./cite.js";

/** master-owned blob 暂存目录(ingest 输入字节;仅 master worker 读)。 */
function defaultBlobDir(): string {
  return process.env.OC_RESEARCH_BLOB_DIR?.trim() || path.join(os.tmpdir(), "oc-research-blobs");
}

const MAX_BLOB_BYTES = 25 * 1024 * 1024; // 25 MiB ingest 输入上限

export const RESEARCH_PREFIX = "/v3/research/";

const MAX_BODY_BYTES = 16 * 1024;

/** 最小 redis 接口(只用 EVAL),同 literatureProxy。 */
export interface ResearchRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

// ─── per-container 限流(进程内滑窗;辅助闸,重启清零) ──────────────────
const PER_CONTAINER_WINDOW_MS = 60_000;
const PER_CONTAINER_MAX = 30; // 30 req/min/容器
const LRU_SIZE = 10_000;

interface Bucket {
  ts: number[];
  lastSeen: number;
}

export interface PerContainerLimiter {
  check(containerId: number, now: number): boolean;
}

export function makePerContainerLimiter(
  windowMs = PER_CONTAINER_WINDOW_MS,
  max = PER_CONTAINER_MAX,
): PerContainerLimiter {
  const buckets = new Map<number, Bucket>();
  return {
    check(containerId, now) {
      let b = buckets.get(containerId);
      if (!b) {
        b = { ts: [], lastSeen: now };
        buckets.set(containerId, b);
        if (buckets.size > LRU_SIZE) {
          // 淘汰最久未用
          let oldestK = -1;
          let oldestT = Number.POSITIVE_INFINITY;
          for (const [k, v] of buckets) {
            if (v.lastSeen < oldestT) {
              oldestT = v.lastSeen;
              oldestK = k;
            }
          }
          if (oldestK >= 0) buckets.delete(oldestK);
        }
      }
      b.lastSeen = now;
      const cutoff = now - windowMs;
      b.ts = b.ts.filter((t) => t > cutoff);
      if (b.ts.length >= max) return false;
      b.ts.push(now);
      return true;
    },
  };
}

const DAILY_CAP_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
if v >= cap then return -1 end
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
return n
`;
const DAILY_KEY_TTL_SEC = 48 * 3600;

function utcDayKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `research:daily:${y}${m}${d}`;
}

// ─── handler ─────────────────────────────────────────────────────────

/** store/fs 注入点(ingest/litrag/check 用;默认真实实现,测试注入内存版)。 */
export interface ResearchStoreDeps {
  putBlob: typeof storePutBlob;
  getBlob: typeof storeGetBlob;
  putDocument: typeof storePutDocument;
  getDocument: typeof storeGetDocument;
  readBlobBytes: (storagePath: string) => Promise<Buffer>;
  writeBlobBytes: (storagePath: string, bytes: Buffer) => Promise<void>;
  blobDir: string;
}

export interface ResearchProxyDeps {
  identityRepo: ContainerIdentityRepo;
  redis?: ResearchRedis | null;
  // 测试 hooks
  readConfig?: () => Promise<ResearchConfigPublic>;
  readSecrets?: () => Promise<ResearchSecrets>;
  fetchImpl?: FetchLike;
  limiter?: PerContainerLimiter;
  now?: () => number;
  log?: (level: "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
  /** ingest/litrag/check 的 store/fs;默认真实实现。 */
  store?: Partial<ResearchStoreDeps>;
}

function resolveStore(s?: Partial<ResearchStoreDeps>): ResearchStoreDeps {
  const blobDir = s?.blobDir ?? defaultBlobDir();
  return {
    putBlob: s?.putBlob ?? storePutBlob,
    getBlob: s?.getBlob ?? storeGetBlob,
    putDocument: s?.putDocument ?? storePutDocument,
    getDocument: s?.getDocument ?? storeGetDocument,
    readBlobBytes: s?.readBlobBytes ?? ((p: string) => readFile(p)),
    writeBlobBytes:
      s?.writeBlobBytes ??
      (async (p: string, bytes: Buffer) => {
        await mkdir(path.dirname(p), { recursive: true });
        await writeFile(p, bytes, { mode: 0o600 });
      }),
    blobDir,
  };
}

export interface ResearchProxyHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export type ResearchProxyHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ResearchProxyHandlerCtx,
) => Promise<void>;

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (total === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(json);
}

function sendErr(res: ServerResponse, status: number, code: string, message: string, requestId: string): void {
  sendJson(res, status, { error: { code, message }, request_id: requestId }, requestId);
}

export function makeResearchProxyHandler(deps: ResearchProxyDeps): ResearchProxyHandler {
  const limiter = deps.limiter ?? makePerContainerLimiter();
  const readConfig = deps.readConfig ?? getResearchConfigPublic;
  const readSecrets = deps.readSecrets ?? getResearchSecrets;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const store = resolveStore(deps.store);

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    if (req.method !== "POST") {
      sendErr(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }

    // 1) 身份双因子
    let identity: { containerId: number; userId: number };
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        sendErr(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }

    // 2) 配置闸
    let cfg: ResearchConfigPublic;
    try {
      cfg = await readConfig();
    } catch (err) {
      log("error", "config_read_failed", { err: String(err) });
      sendErr(res, 500, "INTERNAL", "config read failed", requestId);
      return;
    }
    if (!cfg.enabled) {
      sendErr(res, 503, "SERVICE_DISABLED", "research capability disabled", requestId);
      return;
    }

    // 3) per-container 限流
    if (!limiter.check(identity.containerId, now())) {
      res.setHeader("Retry-After", "10");
      sendErr(res, 429, "RATE_LIMITED", "too many requests for this container", requestId);
      return;
    }

    // 4) daily cap(可选:redis + config.limits.dailyCap)
    const dailyCap = cfg.config.limits.dailyCap;
    if (deps.redis && typeof dailyCap === "number" && dailyCap > 0) {
      try {
        const n = (await deps.redis.eval(
          DAILY_CAP_SCRIPT,
          1,
          utcDayKey(new Date(now())),
          dailyCap,
          DAILY_KEY_TTL_SEC,
        )) as number;
        if (n === -1) {
          sendErr(res, 429, "DAILY_CAP_EXCEEDED", "platform daily research cap reached", requestId);
          return;
        }
      } catch (err) {
        // redis 抖动不阻断(daily cap 是软上限),记日志放行
        log("warn", "daily_cap_redis_error", { err: String(err) });
      }
    }

    // 5) 路由
    const reqPath = (req.url ?? "/").split("?")[0];

    // blob 上传走原始字节(非 JSON);其余路由读 JSON。
    if (reqPath === `${RESEARCH_PREFIX}blob`) {
      try {
        await handleBlobUpload(res, req, identity.userId, store, requestId);
      } catch (err) {
        log("error", "blob_upload_failed", { err: String(err) });
        sendErr(res, 500, "INTERNAL", "blob upload failed", requestId);
      }
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = await readBoundedJson(req, MAX_BODY_BYTES);
      body = (parsed ?? {}) as Record<string, unknown>;
    } catch (err) {
      const tooBig = err instanceof Error && err.message === "body_too_large";
      sendErr(res, tooBig ? 413 : 400, tooBig ? "BODY_TOO_LARGE" : "BAD_REQUEST", "invalid request body", requestId);
      return;
    }

    const citeDeps = { mailto: cfg.config.litSources.crossrefMailto, fetchImpl: deps.fetchImpl };
    try {
      if (reqPath === `${RESEARCH_PREFIX}lit/search`) {
        await handleLitSearch(res, body, cfg, readSecrets, deps.fetchImpl, requestId);
        return;
      }
      if (reqPath === `${RESEARCH_PREFIX}cite/verify`) {
        await handleCiteVerify(res, body, cfg, deps.fetchImpl, requestId);
        return;
      }
      if (reqPath === `${RESEARCH_PREFIX}cite/format`) {
        await handleCiteFormat(res, body, cfg, deps.fetchImpl, requestId);
        return;
      }
      if (reqPath === `${RESEARCH_PREFIX}ingest/parse`) {
        await handleIngest(res, body, cfg, identity.userId, store, requestId);
        return;
      }
      if (reqPath === `${RESEARCH_PREFIX}litrag/query`) {
        await handleLitragQuery(res, body, identity.userId, store, requestId);
        return;
      }
      if (reqPath === `${RESEARCH_PREFIX}cite/check`) {
        await handleCiteCheck(res, body, cfg, identity.userId, store, citeDeps, requestId);
        return;
      }
      if (reqPath === `${RESEARCH_PREFIX}cite/fix`) {
        await handleCiteFix(res, body, cfg, identity.userId, store, citeDeps, requestId);
        return;
      }
      sendErr(res, 404, "NOT_FOUND", `unknown research route ${reqPath}`, requestId);
    } catch (err) {
      log("error", "research_handler_failed", { path: reqPath, err: String(err) });
      sendErr(res, 500, "INTERNAL", "research op failed", requestId);
    }
  };
}

// ── blob 上传(原始字节) ─────────────────────────────────────────────

async function readBoundedBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleBlobUpload(
  res: ServerResponse,
  req: IncomingMessage,
  userId: number,
  store: ResearchStoreDeps,
  requestId: string,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedBytes(req, MAX_BLOB_BYTES);
  } catch (err) {
    const tooBig = err instanceof Error && err.message === "body_too_large";
    sendErr(res, tooBig ? 413 : 400, tooBig ? "BLOB_TOO_LARGE" : "BAD_REQUEST", "invalid blob body", requestId);
    return;
  }
  if (bytes.length === 0) {
    sendErr(res, 400, "BAD_REQUEST", "empty blob", requestId);
    return;
  }
  const blobId = randomUUID();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
  const storagePath = path.join(store.blobDir, `${userId}-${blobId}`);
  await store.writeBlobBytes(storagePath, bytes);
  await store.putBlob({ blobId, userId, sha256, sizeBytes: bytes.length, storagePath, mime });
  sendJson(res, 200, { blobId, sha256, sizeBytes: bytes.length }, requestId);
}

const VALID_SOURCES: LitSourceName[] = ["openalex", "crossref", "arxiv"];

async function handleLitSearch(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  readSecrets: () => Promise<ResearchSecrets>,
  fetchImpl: FetchLike | undefined,
  requestId: string,
): Promise<void> {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    sendErr(res, 400, "BAD_REQUEST", "query required", requestId);
    return;
  }
  const sources = Array.isArray(body.sources)
    ? (body.sources.filter((s) => VALID_SOURCES.includes(s as LitSourceName)) as LitSourceName[])
    : undefined;
  const size = typeof body.size === "number" ? body.size : undefined;
  const yearMin = typeof body.yearMin === "number" ? body.yearMin : undefined;
  const lang = body.lang === "zh" || body.lang === "en" ? body.lang : undefined;

  // secrets 仅在需要(目前 unpaywall email 在 config 非密;S2 key 是 secret,Phase 1 未接 S2 源)
  await readSecrets().catch(() => ({}));

  const result = await searchMultiSource(
    { query, sources, size, yearMin, lang },
    {
      mailto: cfg.config.litSources.crossrefMailto ?? cfg.config.litSources.openalexMailto,
      unpaywallEmail: cfg.config.litSources.unpaywallEmail,
      fetchImpl,
    },
  );
  sendJson(res, 200, result, requestId);
}

async function handleCiteVerify(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  fetchImpl: FetchLike | undefined,
  requestId: string,
): Promise<void> {
  const ids = Array.isArray(body.identifiers)
    ? body.identifiers.filter((x): x is string => typeof x === "string").slice(0, 50)
    : [];
  if (ids.length === 0) {
    sendErr(res, 400, "BAD_REQUEST", "identifiers[] required", requestId);
    return;
  }
  const verdicts = await verifyIdentifiers(ids, {
    mailto: cfg.config.litSources.crossrefMailto,
    fetchImpl,
  });
  sendJson(res, 200, { verdicts }, requestId);
}

async function handleCiteFormat(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  fetchImpl: FetchLike | undefined,
  requestId: string,
): Promise<void> {
  const identifier = typeof body.identifier === "string" ? body.identifier : "";
  const style =
    body.style === "bibtex" || body.style === "apa" || body.style === "gb-t-7714-2015"
      ? body.style
      : "gb-t-7714-2015";
  if (!identifier) {
    sendErr(res, 400, "BAD_REQUEST", "identifier required", requestId);
    return;
  }
  const verdict = await verifyIdentifier(identifier, { mailto: cfg.config.litSources.crossrefMailto, fetchImpl });
  if (!verdict.resolved || !verdict.record) {
    sendJson(res, 200, { verdict }, requestId);
    return;
  }
  sendJson(res, 200, { verdict: { ...verdict, formatted: formatRecord(verdict.record, style) } }, requestId);
}

async function handleIngest(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  userId: number,
  store: ResearchStoreDeps,
  requestId: string,
): Promise<void> {
  const blobId = typeof body.blobId === "string" ? body.blobId : "";
  if (!blobId) {
    sendErr(res, 400, "BAD_REQUEST", "blobId required", requestId);
    return;
  }
  const filename = typeof body.filename === "string" ? body.filename : undefined;
  const outcome = await ingestBlob(
    { userId, blobId, filename, engine: cfg.config.ingest.engine },
    {
      getBlob: async (uid, bid) => {
        const b = await store.getBlob(uid, bid);
        return b ? { storagePath: b.storagePath, mime: b.mime } : null;
      },
      readBlobBytes: store.readBlobBytes,
      putDocument: (uid, doc) => store.putDocument({ userId: uid, doc }),
    },
  );
  if (!outcome.ok) {
    if (outcome.needsOcr) {
      sendJson(res, 200, { needsOcr: true, reason: outcome.reason }, requestId);
      return;
    }
    sendErr(res, 400, "INGEST_FAILED", outcome.reason, requestId);
    return;
  }
  sendJson(res, 200, outcome.outline, requestId);
}

async function handleLitragQuery(
  res: ServerResponse,
  body: Record<string, unknown>,
  userId: number,
  store: ResearchStoreDeps,
  requestId: string,
): Promise<void> {
  const docIds = Array.isArray(body.docIds)
    ? body.docIds.filter((x): x is string => typeof x === "string").slice(0, 50)
    : [];
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || docIds.length === 0) {
    sendErr(res, 400, "BAD_REQUEST", "query and docIds[] required", requestId);
    return;
  }
  const topK = typeof body.topK === "number" ? body.topK : undefined;
  const result = await litragQuery(userId, docIds, query, { topK }, { getDocument: store.getDocument });
  sendJson(res, 200, result, requestId);
}

async function handleCiteCheck(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  userId: number,
  store: ResearchStoreDeps,
  citeDeps: { mailto?: string; fetchImpl?: FetchLike },
  requestId: string,
): Promise<void> {
  const raw = (body.manifest ?? body) as Partial<EvidenceManifest>;
  // 只要 quotes/claims 是数组即可受理;sources 一律忽略(master 自建)。coverage/gates 重算。
  if (!Array.isArray(raw.claims) || !Array.isArray(raw.quotes)) {
    sendErr(res, 400, "BAD_REQUEST", "manifest{quotes,claims} arrays required", requestId);
    return;
  }
  if (raw.quotes.length > 2000 || raw.claims.length > 2000) {
    sendErr(res, 413, "MANIFEST_TOO_LARGE", "too many quotes/claims", requestId);
    return;
  }
  // 容器/LLM 提交的 sources/coverage/gates 不可信:sources 由 master 从权威文档自建,
  // coverage/gates 由 checkManifest 重算铸造。这里只透传 quotes/claims(仍逐条权威校验)。
  const manifest: EvidenceManifest = {
    sources: [],
    quotes: raw.quotes,
    claims: raw.claims,
    coverage: { verifiedClaims: 0, totalClaims: 0 },
    gates: {
      quoteFirst: { passed: true, checked: 0, failed: 0 },
      claimBound: { passed: true, checked: 0, failed: 0 },
      identifier: { passed: true, checked: 0, failed: 0 },
      retraction: { passed: true, checked: 0, failed: 0 },
    },
  };
  const mc = cfg.config.minicheck;
  const entail = mc?.backend === "http" && mc.endpoint ? makeEntail(mc.endpoint, citeDeps.fetchImpl) : undefined;
  const result = await runCheck(userId, manifest, {
    getDocument: store.getDocument,
    verifyIdentifier: (id) => verifyIdentifier(id, citeDeps),
    strictDomains: cfg.config.cite.strictDomains,
    entail,
    entailThreshold: mc?.threshold,
    strictEntail: mc?.strict,
  });
  sendJson(res, 200, result, requestId);
}

async function handleCiteFix(
  res: ServerResponse,
  body: Record<string, unknown>,
  cfg: ResearchConfigPublic,
  userId: number,
  store: ResearchStoreDeps,
  citeDeps: { mailto?: string; fetchImpl?: FetchLike },
  requestId: string,
): Promise<void> {
  const raw = (body.manifest ?? body) as Partial<EvidenceManifest>;
  if (!Array.isArray(raw.claims) || !Array.isArray(raw.quotes)) {
    sendErr(res, 400, "BAD_REQUEST", "manifest{quotes,claims} arrays required", requestId);
    return;
  }
  const docIds = Array.isArray(body.docIds)
    ? body.docIds.filter((x): x is string => typeof x === "string").slice(0, 50)
    : [];
  if (docIds.length === 0) {
    sendErr(res, 400, "BAD_REQUEST", "docIds[] required (用于重检索的权威文档)", requestId);
    return;
  }
  if (raw.quotes.length > 2000 || raw.claims.length > 2000) {
    sendErr(res, 413, "MANIFEST_TOO_LARGE", "too many quotes/claims", requestId);
    return;
  }
  const manifest: EvidenceManifest = {
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    quotes: raw.quotes,
    claims: raw.claims,
    coverage: { verifiedClaims: 0, totalClaims: 0 },
    gates: {
      quoteFirst: { passed: true, checked: 0, failed: 0 },
      claimBound: { passed: true, checked: 0, failed: 0 },
      identifier: { passed: true, checked: 0, failed: 0 },
      retraction: { passed: true, checked: 0, failed: 0 },
    },
  };
  const mc = cfg.config.minicheck;
  const entail = mc?.backend === "http" && mc.endpoint ? makeEntail(mc.endpoint, citeDeps.fetchImpl) : undefined;
  // docs 预加载一次(避免每 claim 重读 DB);query 在内存权威 docs 上跑 master litrag。
  const docs = (await Promise.all(docIds.map((id) => store.getDocument(userId, id)))).filter(
    (d): d is NonNullable<typeof d> => d != null,
  );
  const result = await runCiteFix(userId, manifest, docs.length > 0, {
    getDocument: store.getDocument,
    verifyIdentifier: (id) => verifyIdentifier(id, citeDeps),
    strictDomains: cfg.config.cite.strictDomains,
    entail,
    entailThreshold: mc?.threshold,
    strictEntail: mc?.strict,
    // 逐字取权威 span 铸造 quote;要求一定召回分,避免硬塞弱来源
    query: async (claimText) => queryDocuments(docs, claimText, { topK: 3 }),
    fixMinScore: 0.5,
  });
  sendJson(res, 200, result, requestId);
}

/**
 * 闸⑤ MiniCheck 蕴含 adapter:POST endpoint {claim, quotes} → {score:0~1}。
 * 失败/超时/解析不出 → 返 null(checkManifest 据此跳过该 claim 蕴含判定,不降级)。
 * endpoint 是 admin 配置的可信内网地址(非用户输入)。
 */
function makeEntail(
  endpoint: string,
  fetchImpl: FetchLike | undefined,
): (claimText: string, quoteTexts: string[]) => Promise<number | null> {
  const fetchFn = fetchImpl ?? fetch;
  return async (claimText, quoteTexts) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: claimText, quotes: quoteTexts }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { score?: unknown };
      const s = typeof j.score === "number" ? j.score : null;
      return s != null && s >= 0 && s <= 1 ? s : null;
    } catch {
      return null;
    } finally {
      clearTimeout(to);
    }
  };
}
