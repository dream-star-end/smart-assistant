# v3 商用版:容器→用户文件下载通道设计方案 (rev 6 — 回应 codex R5)

## 0. 迭代追踪

| Rev | 审核级别 | 主要变更 |
|-----|----------|----------|
| r1  | BLOCKING | 初稿:PROXY 替换 BLOCKED,TRUST_BRIDGE_IP 扩 HTTP |
| r2  | BLOCKING | 保留 BLOCKED,PROXY 前置;realpath;DB 双检;cookie 握手;SSRF 白名单;Cache-Control no-store;AbortController 三段 timer;per-uid 并发;capability probe |
| r3  | BLOCKING | +容器身份 ID 绑定 bypass;+fd-based open(O_NOFOLLOW + fstatSync);cleanup 幂等;Accept-Encoding identity;header timer 延后启动;IP 校验 `net.isIPv4`;/api/media filename 修正;cookie TTL `min(jwt.exp, cap)`;部署 B+C 合并门槛 |
| r4  | FIXES REQUIRED | +post-open `/proc/self/fd/<n>` realpath 二次校验(闭中间目录 symlink race);httpRequest `agent:false`;+HMAC bridge nonce;cache 401 → invalidate + reprobe;decodeURIComponent try/catch 400;C-E 非 identity → 502;auth 语义 no-JWT → 401 vs banned → 403;RFC 5987 |
| r5  | FIXES REQUIRED | 容器只发 `OC_BRIDGE_NONCE = HMAC(secret, containerId)`,不持 root secret;capability require 补 `'bridge-nonce'`;secret 放 `CommercialHttpDeps`;nonce hex 正则 + byte-length 双重校验;secret 文件 O_CREAT\|O_EXCL\|O_NOFOLLOW + lstat;首屏 `_ensureSessionCookie()` |
| **r6**  | 回应 R5 | **部署 4 阶段拆分**(feature flag `FILE_PROXY_ENABLED`);secret 文件并发 `EEXIST` catch + reread;dir/file owner+mode 严格校验(uid + 0o022/0o077);`/healthz` capability **动态**(nonce env 缺失则不 advertise);前端指纹 `jti` 代替 `slice(-16)`;401 自动 clear `_sessionCookieMintedFor` + remint;JWT revocation 语义 document(access JWT 短 TTL,强撤销依 session_revocations 表) |

---

## 1. 背景 & 目标(不变)

容器里 agent 写完文件想发回用户。前端 markdown 把容器内绝对路径包成 `/api/file?path=...`,当前 v3 商用防火墙 403。目标是让 user 的 `/api/file` / `/api/media/*` GET 透明代理到他自己容器的对应 handler,admin 路径不退化,URL 不变。

## 2. 架构(r6 收敛后)

```
浏览器 (cookie: oc_session=<jwt>)
  │
  ▼  GET /api/file?path=/home/agent/.openclaude/generated/x.zip
Caddy :443 → HOST gateway
  │
  ▼  commercial router:
  │   [0] extractTokenFromReq → verify JWT
  │   [1] matchProxyRule(path, method): GET /api/file OR GET /api/media/*
  │         AND JWT ok AND role=user AND DB status=active
  │              → containerFileProxy;返 true
  │         否则 → [2]
  │   [2] matchBlockedRule: 原表不变,user 403 / admin bypass HOST handler / anon fall through 401
  │
  ▼ containerFileProxy:
  │   ① DB: requireUserVerifyDb(sub) → role=user AND status=active 否则 403 FORBIDDEN
  │      (**不是** 401 —— 401 会让前端 silentRefresh 空转;banned 状态 terminal)
  │      JWT 无效/过期 → 不进 ④,PROXY 让行 → BLOCKED 401(fall through silentRefresh)
  │   ② getV3ContainerStatus(uid) → state=running
  │                                + boundIp 经 net.isIPv4 且在 172.30.0.0/16
  │                                + port === 18789
  │                                + containerId 取到
  │   ③ capabilityCache(containerId, 60s TTL) probe /healthz,包含 capability
  │        ["bridge-http-bypass", "container-id-binding", "bridge-nonce"](r4)
  │        AND 返回的 containerId 与 DB 一致(防 IP 复用错配)
  │      否则 → 503 CONTAINER_OUTDATED
  │   ④ 发 GET http://boundIp:18789 + request header (agent:false,关 keep-alive):
  │        X-OpenClaude-Container-Id: <containerId>
  │        X-OpenClaude-Bridge-Nonce: HMAC-SHA256(OC_BRIDGE_SECRET, containerId)  (r4)
  │        Accept-Encoding: identity  (r3 强制)
  │        Accept / User-Agent / Range / If-None-Match / If-Modified-Since 透传
  │        **不**转: Authorization, Cookie, Host, X-Forwarded-*
  │   ⑤ 响应头校验 + 重写:
  │        若 upstream 401 → invalidate capability cache + 503 CONTAINER_OUTDATED (r4)
  │        若 Content-Encoding 非 identity 非空 → 502 UPSTREAM_INVALID_ENCODING (r4)
  │        不透: Set-Cookie/Cache-Control/Content-Disposition/Content-Encoding
  │        强写: Cache-Control:no-store, Vary:Authorization,Cookie
  │        Content-Disposition (RFC 5987):
  │           /api/file → attachment; filename="ascii"; filename*=UTF-8''...
  │           /api/media/:name → 对 image(非 svg)/audio/video/pdf 白名单 inline,否则 attachment
  │        decodeURIComponent 坏百分号 → 400 BAD_PATH (r4)
  │   ⑥ 流式 pipe;connect 3s → [connect 完成后/reuse 场景立即]header 5s → [response]body idle 120s
  │   ⑦ per-uid ≤ 4 并发;每 10s markV3ContainerActivity;cleanup 用 `cleaned` flag 幂等
  │
  ▼  docker bridge 172.30.0.0/16 (src=172.30.0.1)
容器内 gateway :18789
  │  [A] bridge bypass(r5 per-container nonce):
  │        remoteIp === TRUST_BRIDGE_IP
  │        AND (method=GET OR HEAD)
  │        AND path in {/api/file, /api/media/*}
  │        AND X-OpenClaude-Container-Id === process.env.OC_CONTAINER_ID
  │        AND timingSafeEqual(X-OpenClaude-Bridge-Nonce, process.env.OC_BRIDGE_NONCE)
  │             (容器端不持 root secret,只持本容器 expected nonce)
  │  [B] 否则走原 needsAuth
  │
  ▼  容器 /api/file / /api/media handler (r4 加 post-open fd realpath):
  │   1. 入参正则 / resolve 串 allow/block(快速拒)
  │   2. realpathSync 后跑一次 isFileAllowed + isFileBlocked(pre-open)
  │   3. openSync(realPath, O_RDONLY|O_NOFOLLOW) — 最后一层不跟 symlink
  │   4. (r4) fdRealPath = realpathSync(/proc/self/fd/<fd>);
  │          再跑一次 check,并确认 fdRealPath === realPath(闭中间目录 race)
  │   5. fstatSync(fd) 确保 regular file;否则 close+403
  │   6. stream = createReadStream(null, { fd, autoClose: true })
本地 FS
```

## 3. 代码改动清单

### 3.1 `router.ts` — PROXY 前置(同 r2)

```ts
const PROXY_FOR_USER_RULES = [
  { re: /^\/api\/file$/,      methods: M("GET"), label: "/api/file" },
  { re: /^\/api\/media\/.+$/, methods: M("GET"), label: "/api/media/:file" },
] as const;
```

commercialHandler 调整(r4 对齐 R3 FIX #6 + r6 加 feature flag):

```ts
// r6 (回应 R5 FIX #1): feature flag 守门,部署阶段 2 时 OFF,阶段 4 打开
function matchProxyRule(path: string, method: string) {
  if (!deps.config.fileProxyEnabled) return null   // FILE_PROXY_ENABLED flag
  // ...原有 PROXY_FOR_USER_RULES 匹配逻辑
}

if (matchProxyRule(url.pathname, method)) {
  const token = extractTokenFromReq(req)        // header 或 cookie
  const claims = token ? verifyCommercialJwtSync(token, deps.jwtSecret) : null
  if (!claims) {
    // 无 token / 无效 / 过期 → 401,保留 fall through 让前端 silentRefresh 重发
    // (不是 403,因为用户可能只是 token 过期)
    return { handled: false }  // 继续交给 BLOCKED → 401
  }
  if (claims.role === 'admin') {
    return { handled: false }  // admin 交给 BLOCKED admin bypass(保留运维能力)
  }
  // role=user path
  const verified = await requireUserVerifyDb(claims.sub, deps.pool)
  if (!verified) {
    // user 存在 JWT 但 DB 显示已禁/删除 → 这是 terminal 状态,403 直返,不走 silentRefresh
    sendError(res, 403, 'FORBIDDEN', 'user inactive', ctx.requestId); return { handled: true }
  }
  return containerFileProxy(req, res, ctx, deps, BigInt(claims.sub)).then(() => ({ handled: true }))
}
// 未命中 PROXY → 继续 BLOCKED 分支
```

`BLOCKED_FOR_USER_RULES` 原表 `/api/file` / `/api/media/:file` 全方法规则**不动**,保留作为 POST/PUT/DELETE 的兜底拦截 + JWT 无效时的 401 出口。

### 3.2 HOST gateway `/api/file` + `/api/media` 加 method guard(同 r2)

```ts
if (url.pathname === '/api/file') {
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return
  }
  // ...
}
```

### 3.3 `containerFileProxy.ts`(r3 收敛)

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { isIPv4 } from "node:net";
import { createHmac } from "node:crypto";
import { basename, extname } from "node:path";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";
import { markV3ContainerActivity, V3_CONTAINER_PORT } from "../agent-sandbox/v3supervisor.js";
import { isContainerCapabilityReady } from "./capabilityCache.js";

const CONNECT_TIMEOUT_MS = 3_000;
const HEADER_TIMEOUT_MS = 5_000;
const BODY_IDLE_TIMEOUT_MS = 120_000;
const ACTIVITY_REFRESH_MS = 10_000;
const PER_UID_MAX = 4;
// r5 (回应 R4 FIX #3): secret 不在模块顶层冻结 env。由 bootstrap 初始化后注入 deps,
// proxy 每次请求从 deps 读。这样即便 dotenv/bootstrap 顺序改变也不会把空 secret 永久烧死。

const inflight = new Map<string, number>();

function bump(key: string, delta: number) {
  const next = (inflight.get(key) ?? 0) + delta;
  if (next <= 0) inflight.delete(key);
  else inflight.set(key, next);
}

// r3: 用 net.isIPv4 + octet 精确判断 + CIDR 172.30/16
function isBoundIpAllowed(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return false;
  return parts[0] === 172 && parts[1] === 30;
}

export async function containerFileProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  uid: bigint,
): Promise<void> {
  const log = ctx.log.child({ route: "container_file_proxy" });
  const key = String(uid);

  // per-uid 并发闸
  if ((inflight.get(key) ?? 0) >= PER_UID_MAX) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "2",
    });
    res.end(JSON.stringify({
      error: { code: "TOO_MANY_DOWNLOADS", message: "concurrent downloads exceed limit" },
    }));
    return;
  }
  bump(key, +1);

  // r3: cleanup 幂等化
  let cleaned = false;
  const release = () => { if (cleaned) return; cleaned = true; bump(key, -1); };

  try {
    // ① 容器 status
    const status = await deps.v3.getContainerStatus(Number(uid));
    if (!status || status.state !== "running") {
      release();
      return writeJsonError(res, 503, "CONTAINER_NOT_RUNNING", "agent container not running");
    }

    // ② SSRF 硬校验
    if (!isBoundIpAllowed(status.boundIp) || status.port !== V3_CONTAINER_PORT) {
      log.error("container_bound_ip_invalid", { boundIp: status.boundIp, port: status.port });
      release();
      return writeJsonError(res, 502, "UPSTREAM_INVALID", "invalid upstream");
    }

    // ③ capability + 容器身份绑定 + nonce 支持
    // r5 (回应 R4 FIX #2): require 三项,漏 bridge-nonce 会让 r4 runtime 通过但容器忽略 nonce → 深防失效
    const ready = await isContainerCapabilityReady(status, [
      "bridge-http-bypass",
      "container-id-binding",
      "bridge-nonce",
    ]);
    if (!ready) {
      release();
      return writeJsonError(res, 503, "CONTAINER_OUTDATED",
        "agent runtime needs restart for file download support");
    }

    // ④ 构造 upstream 请求
    const incomingUrl = new URL(req.url ?? "/", "http://proxy.invalid");
    const isFileEndpoint = incomingUrl.pathname === "/api/file";

    // 过滤客户端 headers + 强制 Accept-Encoding: identity(r3)
    const FW_REQ = new Set(["range", "if-none-match", "if-modified-since", "accept", "user-agent"]);
    const upHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && FW_REQ.has(k.toLowerCase())) upHeaders[k] = v as string | string[];
    }
    upHeaders["Accept-Encoding"] = "identity";
    upHeaders["X-OpenClaude-Container-Id"] = String(status.containerId); // r3: 容器身份绑定
    // r5 (回应 R4 FIX #1+#3): nonce = HMAC-SHA256(rootSecret, containerId).hex
    //   rootSecret 存在 HOST 的 deps(bootstrap 注入),容器端不持 secret 只持本容器 expected nonce。
    //   SSRF 即使能选 header / IP,没 rootSecret 伪造不了;单容器 compromise 不扩散(nonce 只与该 id 匹配)。
    const rootSecret = deps.bridgeSecret;  // 由 bootstrap 启动时校验非空
    upHeaders["X-OpenClaude-Bridge-Nonce"] = createHmac("sha256", rootSecret)
      .update(String(status.containerId))
      .digest("hex");

    // AbortController + 分阶段 timer(r3: header timer 延后启动)
    const ac = new AbortController();
    let connected = false;
    let headered = false;
    let connectTimer: NodeJS.Timeout | null = setTimeout(() => {
      if (!connected) ac.abort(new Error("connect_timeout"));
    }, CONNECT_TIMEOUT_MS);
    let headerTimer: NodeJS.Timeout | null = null;

    const upstream = httpRequest({
      host: status.boundIp,
      port: status.port,
      method: "GET",
      path: incomingUrl.pathname + incomingUrl.search,
      headers: upHeaders,
      family: 4,
      signal: ac.signal,
      // r4: 关 keep-alive(回应 R3 FIX #1)。每 request 新 socket,
      //     connect 事件一定触发,header timer 语义不会被复用 socket 跳过。
      //     性能损失可接受:这条路径是文件下载,非 hot path。
      agent: false,
    });

    upstream.on("socket", (s) => {
      // r4: agent:false 下每次都是新 socket,这里 s.connecting 必为 true;
      //     但兜底一下 reuse 场景(defense in depth):若已 connected 直接启动 header timer
      const armHeaderTimer = () => {
        headerTimer = setTimeout(() => {
          if (!headered) ac.abort(new Error("header_timeout"));
        }, HEADER_TIMEOUT_MS);
      };
      const markConnected = () => {
        connected = true;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        armHeaderTimer();
      };
      if ((s as any).connecting === false) {
        // 已连接(reuse 场景):直接推进阶段
        markConnected();
      } else {
        s.once("connect", markConnected);
      }
    });

    const activityTimer = setInterval(() => {
      void markV3ContainerActivity(deps as any, status.containerId).catch(() => {});
    }, ACTIVITY_REFRESH_MS);

    const teardownTimers = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (headerTimer)  { clearTimeout(headerTimer);  headerTimer = null; }
      clearInterval(activityTimer);
    };

    upstream.on("response", (up) => {
      headered = true;
      if (headerTimer) { clearTimeout(headerTimer); headerTimer = null; }

      // r4 (回应 R3 FIX #3): 若 upstream 返 401,很可能是 capability cache 陈旧
      //   (IP 被复用给别的容器,containerId 对不上)。失效 cache + reprobe + 503
      //   给前端一个可 actionable 的错误,而不是让用户看到 401 困惑。
      const upStatus = up.statusCode ?? 502;
      if (upStatus === 401) {
        teardownTimers();
        invalidateContainerCapability(status.containerId);
        up.resume();  // 丢 body
        writeJsonError(res, 503, "CONTAINER_OUTDATED", "agent runtime state mismatched, retry");
        release();
        return;
      }

      // r4 (回应 R3 FIX #5): upstream Content-Encoding 必须是 identity 或缺席;
      //   出现 gzip/br 等说明中间层强行压缩,body 与 Content-Length 不再对齐,
      //   直接 strip 会让客户端拿到压缩字节却被告知是未压缩的,文件损坏。
      const upEncoding = String(up.headers["content-encoding"] ?? "").trim().toLowerCase();
      if (upEncoding && upEncoding !== "identity") {
        teardownTimers();
        up.resume();
        writeJsonError(res, 502, "UPSTREAM_INVALID_ENCODING",
          `unexpected Content-Encoding: ${upEncoding}`);
        release();
        return;
      }

      // body idle (upstream idle only) —— 120s 没有任何 upstream data 才 abort
      up.setTimeout(BODY_IDLE_TIMEOUT_MS, () => ac.abort(new Error("body_idle_timeout")));

      const outType = String(up.headers["content-type"] ?? "application/octet-stream");
      const outHeaders: Record<string, string | string[]> = {
        "Content-Type": outType,
        "Cache-Control": "no-store",
        "Vary": "Authorization, Cookie",
      };
      // 仅透传这几条安全元数据
      if (up.headers["content-length"]) outHeaders["Content-Length"] = up.headers["content-length"] as string;
      if (up.headers["accept-ranges"])  outHeaders["Accept-Ranges"]   = up.headers["accept-ranges"] as string;
      if (up.headers["content-range"])  outHeaders["Content-Range"]   = up.headers["content-range"] as string;
      if (up.headers["etag"])           outHeaders["ETag"]             = up.headers["etag"] as string;
      if (up.headers["last-modified"])  outHeaders["Last-Modified"]   = up.headers["last-modified"] as string;
      // Content-Encoding 经过上面校验后只会是 identity 或缺席,不用透传

      // Content-Disposition —— r3: /api/media 从 pathname 取 basename
      // r4 (回应 R3 FIX #4): decodeURIComponent 可能 URIError,try/catch 兜底
      let rawName = "";
      try {
        rawName = isFileEndpoint
          ? (incomingUrl.searchParams.get("path") ?? "")
          : decodeURIComponent(incomingUrl.pathname.replace(/^\/api\/media\//, ""));
      } catch {
        teardownTimers();
        up.resume();
        writeJsonError(res, 400, "BAD_PATH", "malformed percent encoding in URL");
        release();
        return;
      }
      const fname = sanitizeFilename(basename(rawName) || "file");
      outHeaders["Content-Disposition"] = dispositionFor(isFileEndpoint, outType, fname);

      res.writeHead(upStatus, outHeaders);

      const finalize = () => { teardownTimers(); release(); };
      up.on("end", finalize);
      up.on("error", () => {
        if (!res.writableEnded) res.destroy();
        finalize();
      });
      res.on("close", () => {
        if (!up.destroyed) ac.abort(new Error("client_close"));
        finalize();
      });
      up.pipe(res);
    });

    upstream.on("error", (err) => {
      teardownTimers();
      if (!res.headersSent) {
        log.warn("container_file_proxy_upstream_error", {
          err: err instanceof Error ? err.message : String(err),
          boundIp: status.boundIp,
        });
        writeJsonError(res, 502, "CONTAINER_UPSTREAM_ERROR", "failed to reach container");
      } else {
        try { res.destroy(); } catch {}
      }
      release();
    });

    upstream.end();
  } catch (err) {
    release();
    if (!res.headersSent) {
      writeJsonError(res, 500, "INTERNAL", "proxy internal error");
    }
  }
}

function writeJsonError(res: ServerResponse, status: number, code: string, message: string) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: { code, message } }));
}

function sanitizeFilename(name: string): string {
  // 去 CR/LF/"/\ 只保留 a-zA-Z0-9._- + Unicode 基础平面
  return name.replace(/[\r\n"\\\x00]/g, "_").slice(0, 255) || "file";
}

// r4 (回应 R3 NIT): RFC 5987 — `filename="ascii_fallback"; filename*=UTF-8''<percent>`
//   Chrome/Firefox/Safari 都解析 filename*,老 IE 回落到 filename
function rfc5987(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(filename)
    .replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function dispositionFor(isFile: boolean, contentType: string, filename: string): string {
  const typeBase = contentType.split(";")[0].trim().toLowerCase();
  const ACTIVE = new Set([
    "text/html", "image/svg+xml", "text/xml", "application/xml",
    "application/xhtml+xml", "application/javascript", "text/javascript",
  ]);
  const SAFE_INLINE = (t: string) =>
    (t.startsWith("image/") && t !== "image/svg+xml") ||
    t.startsWith("audio/") ||
    t.startsWith("video/") ||
    t === "application/pdf";
  const mode = (!isFile && SAFE_INLINE(typeBase) && !ACTIVE.has(typeBase)) ? "inline" : "attachment";
  return `${mode}; ${rfc5987(filename)}`;
}
```

关键修订对 R2:
- **r3 #1 容器身份绑定**: `X-OpenClaude-Container-Id: <row.id>` 随请求带,capability cache 验 `/healthz` 返的 containerId 和 DB 一致,容器端 bypass 验 env.OC_CONTAINER_ID 相等。即便 IP 被复用也打不通。
- **r3 #2 fd-based open**: 在容器 handler 下面 §3.6 详述,主 proxy 不直接读文件。
- **r3 fix #1 cleanup 幂等**: `let cleaned=false` + `release()` 守卫。
- **r3 fix #2 Accept-Encoding identity**:写死,不转客户端。
- **r3 fix #3 header timer 延后**:`connect` 事件后才 setTimeout,3+5 = 独立两段。
- **r3 fix #4 body idle 调到 120s**:兼容慢客户端场景。
- **r3 fix #6 isIPv4 严格**。
- **r3 fix #7 /api/media filename** 从 pathname 取。

### 3.4 `requireUserVerifyDb`(同 r2)

```ts
export async function requireUserVerifyDb(sub: string, pool: Pool) {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM users
      WHERE id = $1::bigint AND role = 'user' AND status = 'active' LIMIT 1`,
    [sub],
  );
  return r.rowCount > 0 ? r.rows[0]! : null;
}
```

### 3.5 Session cookie 握手(r3:TTL 收紧 + CSRF)

```ts
// handlers.ts
export async function handleCreateSession(req, res, ctx, deps): Promise<void> {
  // r3: 只接受 Authorization header 作为 mint 来源,不接受现有 cookie 再生 cookie(防 self-renewal)
  const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, "") ?? "";
  if (!authHeader) { sendError(res, 401, "UNAUTHORIZED", "missing token", ctx.requestId); return; }
  const claims = verifyCommercialJwtSync(authHeader, deps.jwtSecret);
  if (!claims) { sendError(res, 401, "UNAUTHORIZED", "invalid token", ctx.requestId); return; }

  const secure = isHttpsFromLoopbackProxy(req) ? "; Secure" : "";
  // r3: max-age = min(jwt.exp - now, 30d)
  const remainSec = Math.max(1, claims.exp - Math.floor(Date.now() / 1000));
  const maxAge = Math.min(remainSec, 30 * 86400);
  // SameSite=Strict + HttpOnly 已对抗 CSRF GET 下载;对 POST 不会自动带 cookie
  res.setHeader("Set-Cookie",
    `oc_session=${authHeader}; HttpOnly; SameSite=Strict${secure}; Path=/api/; Max-Age=${maxAge}`);
  sendJson(res, 200, { ok: true, maxAge });
}

// util: HTTPS 判断 —— 仅信 loopback X-Forwarded-Proto,避免 commercial 内部 socket.encrypted 漏判
function isHttpsFromLoopbackProxy(req: IncomingMessage): boolean {
  if ((req.socket as any).encrypted === true) return true;
  const addr = req.socket.remoteAddress ?? "";
  const loopback = addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
  return loopback && req.headers["x-forwarded-proto"] === "https";
}
```

logout 复用现有 handleLogout + 清 cookie(`Max-Age=0`)。

**CSRF 防御**:
- `SameSite=Strict` 阻止跨站请求带 cookie。
- `GET /api/file` 即便没 CSRF token,也只能下载该用户自己容器的文件(不是 state-changing)。
- 对 POST/PUT 走 BLOCKED 拦死(user 403),攻击面不通。

**前端最小改点(r6 回应 R5 FIX #5)**:

`packages/web/public/modules/auth.js`:

```js
// ---- session cookie mint ----
let _sessionCookieMintedFor = null   // 按 JWT jti (or SHA-256) 指纹标记

// r6 (回应 R5 FIX #5): 用 jti claim;若无 jti 回退 SHA-256(token) 前 16 hex
async function fingerprintToken(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (payload.jti) return `jti:${payload.jti}`
  } catch { /* malformed → fall through to hash */ }
  const bytes = new TextEncoder().encode(token)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return 'sha:' + [...new Uint8Array(hash).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function mintSessionCookie(token) {
  if (!token) return
  const fp = await fingerprintToken(token)
  if (_sessionCookieMintedFor === fp) return
  try {
    const r = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'same-origin',
    })
    if (r.ok) _sessionCookieMintedFor = fp
  } catch (e) { console.warn('session cookie mint failed', e) }
}

// 首屏渲染前 ensure,否则刚刷新登录态的用户一点媒体会 401
export async function _ensureSessionCookie() {
  const token = getCurrentAccessToken?.()
  if (token) await mintSessionCookie(token)
}

// r6 (回应 R5 FIX #5): /api/file 401 → clear 指纹 + 触发 silentRefresh,新 token 回来后自动 remint
export function invalidateSessionCookieFingerprint() {
  _sessionCookieMintedFor = null
}

// ---- 4 个 touch points ----
// 1. 登录成功后(setCurrentAccessToken 之后立即 await mint)—— 落盘确认再跳主屏
// 2. silentRefresh 成功后(fire-and-forget):refresh 的后置动作,不阻塞 authEpoch 判定
// 3. logout:现有 handleLogout 后端同时 Set-Cookie Max-Age=0;前端 _sessionCookieMintedFor=null
// 4. app 启动 / session restore 流程里,渲染 markdown 之前调 _ensureSessionCookie()
// 5. (r6) /api/file 或 /api/media 返 401 时,Markdown 链接 fetch 拦截 → invalidateSessionCookieFingerprint() + silentRefresh()
```

**和 silentRefresh 的边界**(参见 `feedback_frontend_auth_race_hardening.md`):
- mint 是 silent 的**并行后置动作**,不改 authEpoch,不抢 AbortController。
- mint 失败 → 下次点下载链接 cookie 缺 → 走 BLOCKED 401 → 触发 silentRefresh,闭环。
- 指纹优先 `jti`(每次签发唯一)→ 退 SHA-256;不用 `token.slice(-16)`(碰撞概率不为 0 且日志/调试隐患)。

**JWT revocation 语义说明(回应 R5 NIT)**:
- Commercial access JWT 短 TTL(30min,见 `packages/commercial/src/auth/config.ts`),刷新由 refresh_tokens 表控。
- 强撤销场景(管理员 ban 用户 / 主动 logout 吊销所有设备):通过 `session_revocations` 表 + `verifyCommercialJwtSync` 额外 DB 检查实现 —— 本 spec 不改这条语义,继承现状。
- `requireUserVerifyDb` 在 PROXY 层已经做 `status = 'active'` 双检,banned 账户 JWT 就算还没过期也拿不到下载(直接 403 FORBIDDEN)。文件下载场景 revocation 延迟 ≤ 30min + 瞬间 ban 下载 403,安全半径可接受。

### 3.6 fd-based open 加固 /api/file + /api/media(容器 + HOST 两端)(r4 闭中间目录 race)

r3 的 `realpath → check → openSync(O_NOFOLLOW)` 只挡了**最后一级** symlink 替换;**中间目录**在 check 和 open 之间被替换成 symlink → 物理路径字符串不变,但 openSync 解析这条路径时仍会跟着走到攻击者指向的位置。

r4 修正:open 之后用 Linux `/proc/self/fd/<n>` 拿**已打开 fd 的物理路径**,再跑 allow/block check(回应 R3 BLOCKING #1)。

```ts
// v3 packages/gateway/src/server.ts /api/file handler 尾部改造:
import { openSync, fstatSync, realpathSync, closeSync, constants as fsConstants, createReadStream } from "node:fs"

// 以前: statSync(resolved) + createReadStream(resolved)
// 现在:
let realPath: string
try {
  realPath = realpathSync(resolved)
} catch {
  res.writeHead(404); res.end('not found'); return
}
// 第一层 check(快速拒绝,避免 open 浪费 fd)
if (!isFileAllowed(realPath, agentCwds) || isFileBlocked(realPath)) {
  this.log.warn('api/file blocked (pre-open)', { resolved, realPath })
  res.writeHead(403); res.end('access denied'); return
}

let fd: number
try {
  // O_NOFOLLOW: realPath 最后一级若在我们校验后被换成 symlink,open 直接 ELOOP
  fd = openSync(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
} catch {
  res.writeHead(404); res.end('not found'); return
}

// r4 (回应 R3 BLOCKING #1): 中间目录 symlink race 闭合
//   /proc/self/fd/<n> 的 realpath 是 fd 实际指向的物理 inode 的绝对路径,
//   不依赖 realPath 字符串。若中间目录在 check 和 open 之间被换成 symlink,
//   fdRealPath 会暴露(≠ realPath)。
let fdRealPath: string
try {
  fdRealPath = realpathSync(`/proc/self/fd/${fd}`)
} catch {
  closeSync(fd); res.writeHead(404); res.end('not found'); return
}
if (fdRealPath !== realPath || !isFileAllowed(fdRealPath, agentCwds) || isFileBlocked(fdRealPath)) {
  this.log.warn('api/file blocked (post-open fd realpath)', { resolved, realPath, fdRealPath })
  closeSync(fd); res.writeHead(403); res.end('access denied'); return
}

let fstat
try { fstat = fstatSync(fd) } catch { closeSync(fd); res.writeHead(404); res.end('not found'); return }

if (!fstat.isFile()) {
  closeSync(fd)
  res.writeHead(404); res.end('not found'); return
}

const fileContentType = mimeFor(fdRealPath)
const fileDispositionMode = isActiveContentType(fileContentType) ? 'attachment' : 'inline'
res.writeHead(200, {
  'Content-Type': fileContentType,
  'Content-Length': fstat.size,
  'Cache-Control': 'private, max-age=3600',  // HOST 层缓存;proxy 层会重写 no-store
  'Content-Disposition': `${fileDispositionMode}; ${rfc5987(basename(fdRealPath) || 'file')}`,
})
// autoClose: true 保证流结束 / 错误时 fd 释放
createReadStream(null as any, { fd, autoClose: true }).pipe(res)
```

`/api/media` handler 也同样改(realpath → pre-check → open O_NOFOLLOW → fd realpath post-check)。

**安全性论证**:
- r3 `O_NOFOLLOW` 只管最后一级 → r4 fd realpath post-check 管所有中间组件。
- 即便攻击者在 `realpathSync` 和 `openSync` 之间把 `/tmp/ok/file.zip` 里的 `ok` 换成指向 `/etc` 的 symlink,openSync 会开成 `/etc/file.zip`;`/proc/self/fd/<n>` realpath 会暴露为 `/etc/file.zip` ≠ `/tmp/ok/file.zip` → 403。
- 非 Linux 场景(macOS 开发机)`/proc/self/fd` 不存在 → `realpathSync` 抛错 → 404(不会绕过安全,只是误报)。生产运行在 Linux 容器,不受影响。

### 3.7 容器 bridge bypass(r5:per-container nonce,容器不持 root secret)

**设计变更**:R4 把 `OC_BRIDGE_SECRET` 注入容器 → 单容器 compromise 等于全局 nonce 防线失守。R5 改为 HOST **per-container 派生**:容器只拿 `OC_BRIDGE_NONCE = HMAC(rootSecret, containerId)`,不接触 root secret,单容器泄漏只能伪造"自己本身的 nonce"(毫无意义,HOST 根本不对 id=自己的请求做 bridge bypass)。

`packages/gateway/src/server.ts`:

```ts
import { timingSafeEqual } from "node:crypto"

// HOST 请求进入 HTTP 处理前:
const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
const OC_CONTAINER_ID = process.env.OC_CONTAINER_ID || ''
const OC_BRIDGE_NONCE = process.env.OC_BRIDGE_NONCE || ''   // r5: 容器只持 expected nonce,不持 root secret
const remoteIp = req.socket.remoteAddress || ''
const isFromBridge = !!TRUST_BRIDGE_IP && !!OC_CONTAINER_ID && !!OC_BRIDGE_NONCE && (
  remoteIp === TRUST_BRIDGE_IP || remoteIp === `::ffff:${TRUST_BRIDGE_IP}`
)
const headerContainerId = String(req.headers['x-openclaude-container-id'] ?? '').trim()
const headerNonce = String(req.headers['x-openclaude-bridge-nonce'] ?? '').trim()

// r5 (回应 R4 FIX #4): hex 正则 + byte-length 双重校验,不依赖 Buffer.from 截断行为
function verifyBridgeNonce(received: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(received)) return false  // 64 hex = 32 bytes = SHA-256
  if (received.length !== expected.length) return false
  try {
    const a = Buffer.from(received, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

const BRIDGE_HTTP_ALLOW = (m: string, p: string) =>
  (m === 'GET' || m === 'HEAD') && (p === '/api/file' || p.startsWith('/api/media/'))

if (
  isFromBridge
  && BRIDGE_HTTP_ALLOW(method, url.pathname)
  && headerContainerId === OC_CONTAINER_ID             // r3: 身份绑定
  && verifyBridgeNonce(headerNonce, OC_BRIDGE_NONCE)   // r5: 本容器 expected nonce 直对
) {
  // 跳过 needsAuth,由下面 fd-based handler 自己再筛
} else if (needsAuth && !this.checkHttpAuth(req)) {
  res.writeHead(401, ...); return
}
```

容器 entrypoint / supervisor 注入 env(`packages/commercial/src/agent-sandbox/v3supervisor.ts:~847`):

```ts
import { createHmac } from 'node:crypto'
// rootSecret 从 deps 读(bootstrap 已初始化且校验非空)
const nonce = createHmac('sha256', deps.bridgeSecret)
  .update(String(row.id))
  .digest('hex')
env.push(`OC_CONTAINER_ID=${String(row.id)}`)
env.push(`OC_BRIDGE_NONCE=${nonce}`)          // r5: 只派生 per-container nonce,不下发 rootSecret
// 原 ANTHROPIC_AUTH_TOKEN 逻辑不变
```

HOST 端 secret 加载(`packages/commercial/src/bootstrap.ts` 启动 early phase):

```ts
import { openSync, readFileSync, writeFileSync, fsyncSync, closeSync, lstatSync, chmodSync, existsSync, constants as fsConstants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

const SECRET_PATH = '/etc/openclaude/.bridge_secret'

// r6 (回应 R5 FIX #2 + #3): lstat + O_NOFOLLOW + 严格 owner/mode 校验 + EEXIST 并发处理
function loadOrCreateBridgeSecret(): string {
  const dir = dirname(SECRET_PATH)
  const selfUid = process.getuid?.() ?? 0

  // 1. 目录:真目录、不是 symlink、非 group/world writable、owner=self 或 root
  const ds = lstatSync(dir)
  if (ds.isSymbolicLink()) throw new Error('bridge secret dir is symlink')
  if (!ds.isDirectory()) throw new Error('bridge secret dir is not a directory')
  if ((ds.mode & 0o022) !== 0) {
    // r6 (回应 R5 FIX #3): 目录 group/world writable 会让同机用户替换文件
    throw new Error(`bridge secret dir mode too permissive: ${(ds.mode & 0o777).toString(8)}`)
  }
  if (ds.uid !== selfUid && ds.uid !== 0) {
    throw new Error(`bridge secret dir owner ${ds.uid} unexpected (expected ${selfUid} or 0)`)
  }

  const tryReadExisting = (): string => {
    const fs = lstatSync(SECRET_PATH)
    if (fs.isSymbolicLink()) throw new Error('bridge secret is symlink')
    if (!fs.isFile()) throw new Error('bridge secret is not a regular file')
    // r6: mode 最多 0o600,不能 group/other 有任何 bit
    if ((fs.mode & 0o077) !== 0) {
      throw new Error(`bridge secret too permissive: ${(fs.mode & 0o777).toString(8)}`)
    }
    if (fs.uid !== selfUid && fs.uid !== 0) {
      throw new Error(`bridge secret owner ${fs.uid} unexpected (expected ${selfUid} or 0)`)
    }
    const raw = readFileSync(SECRET_PATH, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error('bridge secret malformed')
    return raw
  }

  // 2. 文件存在:直接走校验+读取
  if (existsSync(SECRET_PATH)) return tryReadExisting()

  // 3. 不存在:O_CREAT|O_EXCL|O_NOFOLLOW 创建;EEXIST(并发启动另一进程已创建)→ reread
  const secret = randomBytes(32).toString('hex')
  let fd: number
  try {
    fd = openSync(
      SECRET_PATH,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    )
  } catch (err) {
    // r6 (回应 R5 FIX #2): 并发启动场景,另一进程赢 race
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return tryReadExisting()
    throw err
  }
  try {
    writeFileSync(fd, secret + '\n')
    fsyncSync(fd)   // r6: writeFileSync with fd 不自动 fsync
  } finally {
    closeSync(fd)
  }
  chmodSync(SECRET_PATH, 0o600)   // 兜底(O_CREAT mode 受 umask 影响)
  return secret
}

// fail-fast:任何异常 throw → import bootstrap.ts 链失败 → commercial server 启动失败。
// 日志只记录 SECRET_PATH 路径,不打印内容。
export const bridgeSecret = loadOrCreateBridgeSecret()
```

`CommercialHttpDeps` 扩展:

```ts
export interface CommercialHttpDeps {
  // ...原有字段
  bridgeSecret: string  // r5: 由 bootstrap 保证非空
}
```

**r5 关键安全性论证**:
- 单容器 compromise:攻击者读到 OC_BRIDGE_NONCE(只有"自己 id 的 nonce"),想伪造请求 → HOST 要求 header containerId === env OC_CONTAINER_ID;同容器自己发请求给自己,HOST 层不会有这种 loop,反过来容器伪造 HOST 身份发给其他容器,也会被其他容器校验 headerContainerId 失败。
- HOST compromise:攻击者能算所有 nonce,但这个场景下跨租户防线已经从"nonce 签名"退化到"DB+capability+SSRF 白名单",仍然不是单点崩塌。
- 启动顺序:`bridgeSecret` 在模块导出时读取,bootstrap 必须先 `import './bootstrap.ts'` 再 `import './http/handlers.ts'`。若 `/etc/openclaude` 目录不可写或出任何异常,启动失败 —— fail-closed,不会默不作声跑 empty secret。

### 3.8 `/healthz` 扩展(r6:capability 动态依赖 env 就绪)

容器内 gateway:
```ts
// r6 (回应 R5 FIX #4): capability 必须反映 env 实际就绪状态,
//   不能容器支持新代码就硬编码 advertise bridge-nonce。
//   如果 HOST supervisor 是旧版没注入 OC_BRIDGE_NONCE,容器虽然有新代码,
//   advertise 给 HOST 说 'bridge-nonce' ready 会让 HOST 发 nonce 过来但容器校验失败 → 401/503 循环。
function computeCapabilities(): string[] {
  const caps = ['bridge-http-bypass']   // runtime 代码支持这点即可
  // container-id-binding:需要 env.OC_CONTAINER_ID 有值且合法
  if (/^\d+$/.test(process.env.OC_CONTAINER_ID ?? '')) caps.push('container-id-binding')
  // bridge-nonce:需要 env.OC_BRIDGE_NONCE 是 64 hex(HMAC-SHA256 输出)
  if (/^[0-9a-f]{64}$/i.test(process.env.OC_BRIDGE_NONCE ?? '')) caps.push('bridge-nonce')
  return caps
}

// /healthz 响应:
{
  ok: true,
  capabilities: computeCapabilities(),
  containerId: process.env.OC_CONTAINER_ID || null,
}
```

HOST `capabilityCache`(r4 加 invalidate 供 401 fallback 用):

```ts
// capabilityCache.ts
const cache = new Map<number, { caps: Set<string>; exp: number }>()
const TTL_MS = 60_000

export function invalidateContainerCapability(containerId: number) {
  cache.delete(containerId)
}

export async function isContainerCapabilityReady(
  status: V3ContainerStatus,
  capsRequired: string[],
): Promise<boolean> {
  const hit = cache.get(status.containerId)
  const now = Date.now()
  if (hit && hit.exp > now) {
    return capsRequired.every((c) => hit.caps.has(c))
  }
  try {
    const resp = await fetchHealthz(status.boundIp, status.port) // 短超时 1s
    if (String(resp.containerId ?? '') !== String(status.containerId)) {
      // containerId 对不上 —— 不 cache,每次重探(直到 supervisor vanish 旧行)
      return false
    }
    const caps = new Set<string>(resp.capabilities ?? [])
    cache.set(status.containerId, { caps, exp: now + TTL_MS })
    return capsRequired.every((c) => caps.has(c))
  } catch {
    return false
  }
}
```

r4 补充(回应 R3 FIX #3):containerFileProxy 遇 upstream 401 时调 `invalidateContainerCapability(status.containerId)` + 返 503 CONTAINER_OUTDATED,下次请求会重探 /healthz,若 IP 已被 recycle 给新容器(不同 containerId),probe 会识别并拒绝 cache,503 继续返,直到 supervisor `getV3ContainerStatus` 拿到新 row.id 或 state=vanished。

### 3.9 `promptSlots.ts` 文案(不变)

容器内 agent HOME=`/home/agent/`。platform-capabilities skill 举例改容器 HOME,纯文案。

## 4. 安全论证(r4 闭环)

### 4.1 容器身份绑定 vs IP 复用(r3 基座 + r4 HMAC + r5 per-container 派生)
- HOST 请求带 `X-OpenClaude-Container-Id: <DB 行 id>` + `X-OpenClaude-Bridge-Nonce: HMAC-SHA256(rootSecret, id).hex()`。
- 容器 bypass 校验 env.OC_CONTAINER_ID 相等 AND `timingSafeEqual(headerNonce, env.OC_BRIDGE_NONCE)`。
- 容器**不持** rootSecret,只持"派生给自己的那一个 expected nonce"(`HMAC(rootSecret, 自己的 id)`)。
- 即便 A 容器(id=10)被 terminate、172.30.50.50 被复用给 B 容器(id=20),HOST 带 header=10 + nonce_for_10 到 172.30.50.50 → B 容器 env.OC_CONTAINER_ID=20,id check 拒绝。
- SSRF 深防(未来 HOST 出漏):id 可猜但 nonce 需要 rootSecret;rootSecret 只在 HOST bootstrap 从 `/etc/openclaude/.bridge_secret`(0600)读,不经 env、不经 bind mount、不注入任何容器。
- **单容器 compromise 不扩散**:容器即便被完全拿下,它拿到的 OC_BRIDGE_NONCE 只与自己 id 匹配;想伪造"另一个容器的 nonce" 需要 rootSecret,拿不到。

### 4.2 fd-based open vs TOCTOU(r4 闭中间目录 race)
- **第一层**: `realpathSync(resolved)` 解析所有中间 symlink → 得物理路径 realPath。
- **pre-open check**: 对 realPath 跑 `isFileAllowed + isFileBlocked`,快速拒绝不合法请求。
- **O_NOFOLLOW open**: `openSync(realPath, O_RDONLY | O_NOFOLLOW)` 若 realPath 最后一级被替换成 symlink,open 立即 ELOOP。
- **r4 post-open fd realpath check**: `realpathSync(/proc/self/fd/<fd>)` 拿 fd 实际指向的物理 inode 路径 fdRealPath,再跑 `isFileAllowed + isFileBlocked`,并确认 fdRealPath === realPath。
  - 攻击场景:check 之后把 `/tmp/ok/` 换成 `/etc/` symlink → open 打开的是 `/etc/file` → fdRealPath 变 `/etc/file` → 403 拒绝。
- `fstatSync(fd).isFile()` 确认 regular file(不是目录、block device 等)。
- `createReadStream(null, { fd })` 流绑 fd,路径后续被改也无法 hijack 流。

### 4.3 防跨租户(5 层)
1. DB WHERE user_id=$sub,用户只能拿到自己的 boundIp。
2. bound_ip 必在 172.30/16 + port 18789(`net.isIPv4` 严格)。
3. 容器身份绑定 header(X-OpenClaude-Container-Id)。
4. **r4**: HMAC bridge nonce(SSRF 深防)。
5. capability cache probe 含 containerId echo(启动前检测错配)。

### 4.4 Cookie CSRF
- `HttpOnly + SameSite=Strict + Secure + Path=/api/` 阻止跨站请求带 cookie。
- `GET /api/file` 非 state-changing,且只能读调用者本人容器。
- Mint 路径 `POST /api/auth/session` 只接 `Authorization` header(不接 cookie),防 cookie self-renewal。
- cookie TTL = min(JWT exp, 30d),不超期。

### 4.5 防内容活跃渲染
- `/api/file` 统一 attachment。
- `/api/media/*` 白名单 image(非 SVG)/audio/video/PDF inline,其余 attachment。
- `X-Content-Type-Options: nosniff` 已由 commercial setSecurityHeaders 统一写。

### 4.6 防缓存串号
- HOST proxy 强写 `Cache-Control: no-store` + `Vary: Authorization, Cookie`,不透容器原头。

### 4.7 防压缩损坏
- HOST proxy 强写 `Accept-Encoding: identity`,即便中间层加 gzip 也不启用。

### 4.8 防方法越权
- PROXY 只 GET 命中;BLOCKED 全方法兜底;HOST handler 自身 method guard;容器 bypass method 白名单。

### 4.9 防资源耗尽
- per-uid 并发 ≤ 4(cleanup 幂等,不会负数)。
- connect 3s / header(connect 后)5s / body idle 120s,每段独立。
- 期间 10s markV3ContainerActivity 防 idle sweep 半途杀容器。

### 4.10 banned user
- `requireUserVerifyDb` DB status=active 双检,过期/禁用用户 403 直返。

## 5. 错误表(r4)

| 场景 | HOST | 用户感知 |
|------|------|----------|
| 无 JWT / JWT 过期 / JWT 无效(r4 FIX #6) | PROXY 不命中 → BLOCKED 401 | silentRefresh |
| role=admin | PROXY 不命中(交还 BLOCKED admin bypass)→ HOST handler | 正常读 HOST |
| role=user + DB status != active | PROXY 层 403 FORBIDDEN(不 fall through) | "账号状态异常" |
| 容器未 provision / stopped / missing | 503 CONTAINER_NOT_RUNNING | "会话未建立" |
| boundIp 非 172.30/16 或 port != 18789 | 502 UPSTREAM_INVALID + log.error | "系统异常" |
| 旧 runtime / capability 缺失 / IP 复用错配 | 503 CONTAINER_OUTDATED | "请重启 agent" |
| **r4**: upstream 401(身份/nonce 错配)| invalidate cache + 503 CONTAINER_OUTDATED | 同上,下次请求重探 |
| **r4**: upstream Content-Encoding != identity | 502 UPSTREAM_INVALID_ENCODING + log.error | "系统异常" |
| **r4**: URL 带坏 %xx | 400 BAD_PATH | "链接损坏" |
| per-uid 并发 > 4 | 429 TOO_MANY_DOWNLOADS | 前端 2s 后重试(通常不触发) |
| 容器端 403(symlink/blocked/路径不 allow)| 透传 403 | 链接 403 |
| 容器端 404 | 透传 404 | 链接 404 |
| Connect 3s 超时 | 502 CONTAINER_UPSTREAM_ERROR | 可重试 |
| connect 后 5s 无 header | 502 同上 | 可重试 |
| upstream idle 120s 无数据 | abort + RST | 下载中断,可重试 |
| 客户端早关 | upstream abort,并发计数归零 | 无感 |

## 6. 测试计划(r4)

### 6.1 containerFileProxy.test.ts(unit)
- A-10  status=null → 503
- A-20  state=stopped/missing → 503
- A-30  boundIp=127.0.0.1 → 502 UPSTREAM_INVALID
- A-31  boundIp=172.30.999.999 → 502(验 isIPv4 严格)
- A-32  boundIp=10.0.0.1 → 502
- A-33  port=9999 → 502
- A-40  无 bridge-http-bypass capability → 503 CONTAINER_OUTDATED
- A-41  capability ready 但 /healthz 返 containerId != DB id → 503 CONTAINER_OUTDATED
- A-42  (r4) upstream 返 401 → HOST 调 invalidateContainerCapability + 503 CONTAINER_OUTDATED;下次请求强制重探
- A-50  容器返 200 + body → 透传;headers 不含 Set-Cookie;Cache-Control=no-store;Vary=Authorization, Cookie
- A-51  /api/file 容器返 Content-Disposition=inline → HOST 强制 attachment
- A-52  /api/media/pic.png 容器返 image/png → HOST inline
- A-53  /api/media/x.svg 返 image/svg+xml → HOST attachment
- A-54  /api/media/x.html 返 text/html → HOST attachment
- A-55  /api/media/foo.png filename 正确取自 pathname
- A-56  (r4) /api/media/%GG.png(坏百分号)→ 400 BAD_PATH,不 crash
- A-57  (r4) Content-Disposition 含中文文件名 → 输出含 `filename="_"; filename*=UTF-8''...` RFC 5987 格式
- A-60  (r4) upstream 返 Content-Encoding: gzip → 502 UPSTREAM_INVALID_ENCODING(不透传、不 strip、不 crash)
- A-61  client 请求带 Authorization → 上游 headers 不含 Authorization / Cookie
- A-62  client 请求带 Accept-Encoding: gzip → 上游 headers.Accept-Encoding=identity
- A-63  client 请求带 Range → 透传;上游 206 → 透传 206 + Content-Range
- A-64  client 请求带 X-OpenClaude-Container-Id / X-OpenClaude-Bridge-Nonce 想伪造 → 上游收到的是 HOST 写入的(DB 行 id + HMAC)
- A-65  (r4) HOST httpRequest options 包含 `agent: false`(mock 验证),不走 keep-alive
- A-70  connect 4s → abort + 502 CONTAINER_UPSTREAM_ERROR(connect timeout 独立)
- A-71  connect 2s + header 6s → abort(header timer connect 后 5s)
- A-72  header 2s + body 130s 无 data → abort
- A-73  header 2s + body 正常流传完 → release 被调用一次,并发计数为 0
- A-74  (r4) mock socket.connecting===false 场景(reuse)→ 立即启动 header timer,不卡
- A-80  同 uid 5 并发 → 第 5 个 429
- A-81  1 个完成后再来第 5 个 → 通过(cleanup 幂等验证)
- A-82  cleanup 重复触发(上游 end + close 同时)→ 并发计数不变负数
- A-90  慢下载(客户端每 500ms 读 1KB)→ 不误杀(120s idle)

### 6.2 router.integ.test.ts(r4 FIX #6 auth 语义对齐)
- GET /api/file + user active + caps ok → PROXY 接住 200
- GET /api/file + user 存在但 DB status=banned → 403 FORBIDDEN(不 fall through)
- **GET /api/file + 无 Authorization/cookie → PROXY 让行 → BLOCKED 401(让 silentRefresh 触发)**
- **GET /api/file + JWT 过期 → PROXY 让行 → BLOCKED 401**
- **GET /api/file + JWT 伪造/签名错 → PROXY 让行 → BLOCKED 401**
- POST /api/file + user → PROXY 不命中 → BLOCKED 403
- HEAD /api/file + user → PROXY 不命中 → BLOCKED 403(PROXY 仅 GET)
- GET /api/file + admin JWT → PROXY 让行 → BLOCKED admin bypass → HOST handler
- GET /api/media/foo.png + user → 同 /api/file 对齐规则
- 多并发 uid 各自互不干扰(per-uid 计数独立)

### 6.3 容器端 gateway bypass(r5:per-container nonce)
- TRUST_BRIDGE_IP=172.30.0.1, OC_CONTAINER_ID=42, OC_BRIDGE_NONCE=<64hex>(for id=42)
  - GET /api/file + src=172.30.0.1 + container-id=42 + nonce=OC_BRIDGE_NONCE → 放行
  - GET /api/file + src=172.30.0.1 + container-id=43 + 任何 nonce → 401(id != env)
  - GET /api/file + src=172.30.0.1 + container-id=42 + 错误 nonce → 401
  - GET /api/file + src=172.30.0.1 + container-id=42 + 缺 nonce → 401
  - **(r5) GET /api/file + container-id=42 + nonce 非 hex(带 'g' 或 ' ')→ 401(正则拦截)**
  - **(r5) GET /api/file + container-id=42 + nonce 长度 ≠ 64 → 401(length check)**
  - GET /api/file + src=172.30.0.1 + 无 container-id header → 401
  - POST /api/file + src=172.30.0.1 + 全对 → 401(method 不在 bypass)
  - GET /api/agents + src=172.30.0.1 + 全对 → 401(path 不在 bypass)
  - GET /api/file + src=9.9.9.9 + 全对 → 401
  - GET /api/file + TRUST_BRIDGE_IP 空 env → 401(bypass 整体关闭)
  - GET /api/file + OC_BRIDGE_NONCE 空 env → 401(未注入 → bypass 关闭)
  - **(r5) 另一容器 compromise 场景 mock**:attacker 拿容器 B (id=43) 的 OC_BRIDGE_NONCE,发请求给容器 A (id=42) 带 header container-id=42 + nonce=(for 43)→ A 侧 nonce mismatch → 401

### 6.4 fd-based / realpath 加固(容器 + HOST)(r4 加中间目录 + r5 补 rename/unlink)
- 场景 A:普通文件 → 200
- 场景 B:`$generated/legit.txt` 是 symlink → `/home/agent/.openclaude/openclaude.json` → 403
- 场景 C:`$generated/legit.txt` 是 symlink → /etc/shadow → 403
- 场景 D:普通文件路径中间经 symlink(linkdir → /tmp/openclaude-xxx)→ 200(realpath 已解析成物理路径)
- 场景 E:`open()` 前把 realpath 最后一级从文件换成 symlink → open ELOOP → 404(O_NOFOLLOW 生效)
- 场景 F:realpath 通过后把**中间目录**(比如 `/tmp/openclaude-A/`)替换成 symlink 指向 `/etc/` → open 打开 `/etc/file` → `/proc/self/fd/<n>` realpath 暴露为 `/etc/file` ≠ realPath → 403
- 场景 G:realpath 是 dir,非 file → 404(fstatSync isFile=false)
- 场景 H:realpath 是 block device → 404
- **(r5 新)** 场景 I:open 成功后立刻 rename 目标文件 → stream 仍能读完原 inode 数据,不 crash;fd close 时不泄漏
- **(r5 新)** 场景 J:open 成功后立刻 unlink 目标文件 → stream 仍能读完 inode 数据,client 收到完整 body;fd close 时不泄漏
- **(r5 新)** 场景 K:open 前把 realpath 换成**指向目录**的 symlink → O_NOFOLLOW 让 open ELOOP → 404
- **(r5 新)** 场景 L:非 Linux 环境(`/proc/self/fd` 不存在)→ realpathSync 抛错 → 404 fail-closed,不 crash

### 6.5 bridge secret bootstrap(r5 新 + r6 补)
- `/etc/openclaude` 是 symlink → `loadOrCreateBridgeSecret` throw → 启动失败
- `/etc/openclaude/.bridge_secret` 是 symlink → throw
- `.bridge_secret` mode=0644 → throw
- `.bridge_secret` mode=0610(group-readable bit 存在)→ **(r6)** throw(`(mode & 0o077) !== 0`)
- `.bridge_secret` 内容不是 64 hex → throw
- `.bridge_secret` 不存在 → O_EXCL 新建,mode=0600,内容 64 hex
- **(r6)** 并发启动两进程:A 先 O_EXCL 成功并写入完整 64 hex;B 启动略晚,O_EXCL 返 EEXIST → 走 tryReadExisting → 读到 A 写的 secret → 成功返回同值;两进程最终 secret 相等
- `/etc/openclaude` 目录 world-writable(mode=0777) → throw
- **(r6)** `/etc/openclaude` 目录 group-writable(mode=0775)→ throw(`(ds.mode & 0o022) !== 0`)
- **(r6)** `/etc/openclaude` 目录 owner=普通用户 1001 而非 self/root → throw
- **(r6)** `.bridge_secret` 文件 owner=普通用户 1001 而非 self/root → throw

### 6.6 `/healthz` capability 动态(r6 新)
- env `OC_CONTAINER_ID=42` + `OC_BRIDGE_NONCE=<64hex>` → capabilities 含 `['bridge-http-bypass','container-id-binding','bridge-nonce']`
- env 缺 `OC_BRIDGE_NONCE` → capabilities 不含 `'bridge-nonce'`(即便镜像支持)
- env `OC_BRIDGE_NONCE=<非 hex>` → capabilities 不含 `'bridge-nonce'`(正则 reject)
- env 缺 `OC_CONTAINER_ID` → capabilities 只含 `['bridge-http-bypass']`
- HOST probe 这种退化 healthz → `isContainerCapabilityReady(['bridge-http-bypass','container-id-binding','bridge-nonce'])` 返 false → 503 CONTAINER_OUTDATED

### 6.7 feature flag 守门(r6 新)
- `FILE_PROXY_ENABLED=false` + GET /api/file + valid user JWT → PROXY 不命中 → BLOCKED 403(回退到现状)
- `FILE_PROXY_ENABLED=true` + GET /api/file + valid user JWT → PROXY 接住 200
- 运行中 flag 切换(SIGHUP 或 config reload)→ 下一请求即生效,in-flight 请求不受影响

### 6.5 Session cookie 握手
- POST /api/auth/session + valid JWT → Set-Cookie max-age = min(jwt.exp-now, 30d)
- POST /api/auth/session 只带 cookie(无 Authorization)→ 401(不自我续期)
- POST /api/auth/session + 过期 JWT → 401
- logout → Set-Cookie Max-Age=0
- 后续 GET /api/file 带 cookie 无 Authorization → PROXY 认证通过

### 6.6 端到端手测(staging + 生产灰度)
1. beta 账号 → 登录 → devtools 确认 oc_session cookie Secure HttpOnly SameSite=Strict
2. agent 在容器内生成 `/home/agent/.openclaude/generated/test.zip`
3. 点击 markdown 链接 → 下载成功
4. incognito B 账号同 URL → 403(不复用 A 的 oc_session / 不命中浏览器缓存,Cache-Control: no-store + Vary)
5. admin 后台 ban A 账号后 A 点击 → 403 FORBIDDEN
6. admin 账号访问 /api/file?path=/root/.openclaude/... → 仍读 HOST
7. admin terminate A 容器后立即 open A 浏览器点击下载 → 503 CONTAINER_NOT_RUNNING(/healthz probe 拿不到)
8. admin terminate A 容器后 IP 立刻被 provisioned 给 C 用户;A 的浏览器还在重试 → 503(capability/containerId 错配检测)
9. 同 A 开 5 个 tab 同时下载 → 第 5 个 429
10. 下载 100MB 大文件中途刷新页面 → 无 HOST 进程泄漏(并发计数归零可观测,或 HOST metric 可拉)

## 7. 回滚

| 组 | 路径 | 回滚方式 |
|----|------|----------|
| A  runtime 镜像(fd-open + /proc/self/fd/ 校验 + bridge HTTP bypass + containerId + per-container nonce 校验 + healthz capabilities) | `packages/gateway/src/server.ts` + `/healthz` handler + v3supervisor env 注入 OC_CONTAINER_ID/OC_BRIDGE_NONCE | rebuild 旧 tag,切 runtimeImage 回滚 |
| B  HOST commercial(proxy + PROXY_FOR_USER_RULES + requireUserVerifyDb + session cookie + capabilityCache + nonce 生成 + bootstrap secret loader) | `packages/commercial/src/http/*` + bootstrap secret loader | git revert + restart(保留 `/etc/openclaude/.bridge_secret`,下次升级可沿用;若需彻底清 rm -f) |
| C  前端(auth.js session 握手 + `_ensureSessionCookie`) | `packages/web/public/modules/auth.js` + sw 版本 bump | rsync 回滚 + 二次 ?v= bump |

回滚触发条件:
- 发现跨租户读盘路径 → 回 B(一键恢复原 BLOCKED 403 语义,不出安全问题,体验降级)
- 新 runtime 启动失败 → 回 A,HOST proxy 因 capability 缺席自动降级 503 CONTAINER_OUTDATED,B 不用动
- secret 文件意外泄漏 → `rm /etc/openclaude/.bridge_secret` + restart HOST(重新生成 rootSecret)+ 同步 admin 批量 terminate 所有活跃容器(新 nonce 派生下发到新容器)

## 8. 部署顺序(r6:4 阶段,feature flag 守门)

**问题**:`OC_BRIDGE_NONCE` 由 `v3supervisor.ts`(HOST 代码)注入。如果先 ship runtime image 再 cold-restart 容器,那时 supervisor 还是旧版,不会注入 nonce env,容器 cold-start 后 `/healthz.capabilities` 也不含 `bridge-nonce`,HOST 旧代码又没 PROXY 路径 → 那些容器的 restart 白费,PR-B 上线后还得再 cold-restart 一轮。

**r6 方案**:4 阶段,`FILE_PROXY_ENABLED` feature flag 守门。

### 阶段 1:runtime image(向前兼容,不破坏)
- `packages/gateway/src/server.ts` 改:fd-based open、bridge HTTP bypass(容器端)、`/healthz` 动态 capability。
- **关键**:旧 supervisor 不注入 nonce env 时,`computeCapabilities` 不 advertise `bridge-nonce` → HOST capability probe 不认 ready → 不走 PROXY(fall through BLOCKED 403,和现状一致)。
- build+save+scp+load 新镜像,`runtimeImage` 切到新 tag。
- 不用 cold-restart,WS 复连 / 自然 sweep 逐步迁。

### 阶段 2:HOST commercial 代码(feature flag = OFF)
- `packages/commercial/*` 上线:bootstrap `loadOrCreateBridgeSecret` / `supervisor` 注入 OC_CONTAINER_ID+OC_BRIDGE_NONCE / `containerFileProxy` / `PROXY_FOR_USER_RULES` / session cookie handlers / capabilityCache。
- **feature flag** `FILE_PROXY_ENABLED=false`:router 的 `matchProxyRule` 第一行检查 flag,off 时返回 not-matched,流量继续走 BLOCKED 403。
- rsync HOST + `systemctl restart openclaude`。
- 新创建容器已带 nonce env(supervisor 新代码);旧容器仍老版没 nonce env,无碍(flag off)。

### 阶段 3:admin 批量冷启活跃容器
- 运维脚本:`last_ws_activity < 1h` 的 active 容器 terminate,强制 cold-start 到 "runtime-v3-file-return + supervisor-new-nonce-inject"。
- 观察 `/healthz.capabilities` 覆盖率到 ≥ 95%(grafana or metrics)。

### 阶段 4:打开 flag + 前端灰度
- `FILE_PROXY_ENABLED=true` rolling restart(或热 reload)。
- 前端 PR-C rsync + sw.js 版本 bump(依 `feedback_v3_static_cache_trap.md` bump `?v=` 两次 + restart 清 gateway 内存)。
- 灰度:部分账号(admin/beta list)先开,观察 48h。
- 错误率 `CONTAINER_OUTDATED`、`CONTAINER_NOT_RUNNING`、`UPSTREAM_INVALID_ENCODING` 均衰减到 0 后全量。

### 回滚 
- 任意阶段出问题:flag off(瞬时回落到原 403 语义),观察 → 修 → 再开。
- runtime image 坏:切 `runtimeImage` 回旧 tag,但 HOST supervisor 已经在注入 env,旧 runtime 忽略 env 不影响。
- secret 泄漏:见 §7。

## 9. 待定

- `/api/file` 的容器端 Range 需实测 createReadStream(null, { fd, start, end }),若不支持再补后端。
- 大文件下载时 capability cache 60s TTL 期间若容器重建,可能一次 request 打到新容器:containerId 校验会命中错配 → 503 自动恢复。
- 若未来改多 host,container_id 跨 host 全局唯一即可(已用 BIGSERIAL),不冲突。

## 10. 实现期 notes(R6 PASS 时 codex 补建议)

### 10.1 secret 并发创建的 read-during-write window
- 场景:进程 A `openSync(O_EXCL)` 成功拿到 fd,尚未写完;进程 B 启动,`existsSync(SECRET_PATH)` 为 true → 走 tryReadExisting → 读到空/半写 → 正则 fail → throw 启动失败。
- 当前设计:fail-closed,可接受(系统级单点启动竞争极罕见)。
- 若要更平滑,可加 bounded retry:read 返 malformed 时 sleep 100ms 重试 ≤ 3 次,超过再 throw。
- 实施时优先观察线上启动 race 频率,真实发生再加重试,不提前加代码。

### 10.2 前端 `atob` base64url padding
- JWT payload 是 base64url,`atob` 是标准 base64,可能需要补 `=`:
  ```js
  function b64urlToJson(s) {
    const pad = s.length % 4 ? '='.repeat(4 - s.length % 4) : ''
    return JSON.parse(atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')))
  }
  ```
- 实现时加 padding 提高 `jti` 命中率;SHA-256 fallback 兜底 malformed 场景。

### 10.3 import/deps hygiene
- 不要让 `containerFileProxy.ts` 隐式依赖 "bootstrap.ts 必须先 import"。
- main entrypoint 显式 `const bridgeSecret = loadOrCreateBridgeSecret()` → 装入 `CommercialHttpDeps` → 传入 `createHandler`。
- `bootstrap.ts` 导出 `loadOrCreateBridgeSecret()` 函数,不做模块顶层 side effect 导出常量。

### 10.4 监控 / 指标(阶段 3-4 观察项)
发版前后 grafana 必须有以下 counter:
- `oc_file_proxy_status{code=...}`:按响应 code 分组(200/401/403/429/502/503)
- `oc_file_proxy_error{reason=...}`:`CONTAINER_OUTDATED` / `UPSTREAM_INVALID_ENCODING` / `upstream_401_invalidate` / `TOO_MANY_DOWNLOADS` / `BAD_PATH` / `connect_timeout` / `header_timeout` / `body_idle_timeout`
- `oc_file_proxy_inflight_per_uid`:gauge,按 uid 分桶(观察 per-uid 并发水位)
- `oc_container_healthz_caps`:按 capabilities 组合分组,阶段 3 覆盖率目标 ≥ 95% 三项全齐
- rollout 结束后保留最少 30 天。

---

## 迭代总结

6 轮审查(r1-r6),每轮发现与修复:

- **r1 → r2**:初稿将 BLOCKED 替换为 PROXY 被 codex 抓到 non-GET 兜底失效、没 session cookie 浏览器 `<a>` 不带 Authorization、JWT-only 漏 banned user、statSync symlink bypass 等 6 项。
- **r2 → r3**:bound_ip race(IP 复用)、realpath + createReadStream TOCTOU 两项 BLOCKING + cleanup 幂等 / accept-encoding / header timer / cookie CSRF 等 8 项 fix。
- **r3 → r4**:中间目录 symlink race(`O_NOFOLLOW` 只保护最后一级)、keep-alive 跳过 header timer 两项 BLOCKING + 4 项 fix + 1 项 NIT。
- **r4 → r5**:`OC_BRIDGE_SECRET` 不该下发容器、capability list 漏 `bridge-nonce`、BRIDGE_SECRET 顶层 const 冻结 env、nonce hex 校验不严、secret 文件创建 TOCTOU 等 5 项 fix + 3 项 NIT。
- **r5 → r6**:部署顺序 nonce 注入依赖错层、并发 EEXIST、owner/mode 校验、`/healthz` capability 静态不反映 env 就绪、前端 slice(-16) 指纹不严 等 5 项 fix + 1 项 NIT。
- **r6 PASS**:架构层面所有安全防线闭环;剩 4 条实现期 notes(见 §10)。

方案可进入实施阶段。
- `oc_session` cookie 只走 `/api/` 路径,不泄漏到 `/ws`;WS 握手仍走 Authorization bearer,与现状一致。
