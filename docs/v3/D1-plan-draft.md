# Batch D.1 Plan (draft) — multihost identity + master 18443 mTLS + node-agent L7 reverse proxy

## Goal

让远程 host 上的容器能访问 anthropic API 中央代理,保持与 self-host 相同的双因子身份语义,且架构最简(L7 反代,不引入 CONNECT 隧道/双层 TLS/容器额外 CA)。

## 现状参照

| 事实 | 位置 |
|------|------|
| 容器 `ANTHROPIC_BASE_URL = http://172.30.0.1:18791` | agent-sandbox/v3supervisor.ts:76 |
| anthropicProxy 独立 HTTP server,监听 `INTERNAL_PROXY_BIND:PORT` | commercial/src/index.ts:383-424 |
| 现有 identity: `findActiveByBoundIp(ip)` + `verifyContainerIdentity(repo, peerIp, auth)` | auth/containerIdentity.ts |
| 新 DB 查询 `findActiveByHostAndBoundIp(hostUuid, boundIp)` **已经存在** | compute-pool/queries.ts:145 |
| mTLS 基础设施 (`ensureCa`/`ensureMasterLeaf`/SPIFFE `spiffe://openclaude/host/<uuid>`) | compute-pool/certAuthority.ts |
| node-agent Go,已有 egress CONNECT 代理(本 plan 不动) | node-agent/internal/egress |
| node-agent 配置 `ProxyBind = 172.30.<N>.1:3128`(CONNECT)+ `MasterBaselineBaseURL` | node-agent/internal/config/config.go |

## 目标架构(确定版)

```
self-host (现有,不动):
  container → http://172.30.0.1:18791 (plaintext) → anthropicProxy (同进程)
      peerIp = socket.remoteAddress = bound_ip
      host_uuid = self (推断)

remote host (新增):
  container → http://172.30.<N>.1:18791 (plaintext) → node-agent L7 reverser
      → mTLS HTTPS POST https://<master>:18443/v1/messages
         headers: X-V3-Container-IP: <原始容器 IP>,
                 Authorization: <原封转发>
      → master gateway 18443 mTLS listener
         验 client cert → SAN URI → host_uuid
         读 X-V3-Container-IP → container bound_ip
         → anthropicProxy handler (复用同一个)
```

## D.1a — identity 层重构

**文件**: `packages/commercial/src/auth/containerIdentity.ts`

### 改动

1. `ContainerIdentity` 加字段 `hostUuid: string`
2. `ContainerIdentityRepo` 接口改:
   ```ts
   findActiveByHostAndBoundIp(hostUuid: string, boundIp: string): Promise<ActiveRow | null>
   ```
   (删除 `findActiveByBoundIp`)
3. `createPgIdentityRepo` 改为调 `computeQueries.findActiveByHostAndBoundIp`(已存在)
4. `verifyContainerIdentity` 签名改:
   ```ts
   verifyContainerIdentity(
     repo,
     ctx: { hostUuid: string; boundIp: string },
     authorizationHeader: string | undefined,
   ): Promise<ContainerIdentity>
   ```
   - caller 必须同时提供 hostUuid + boundIp;调用点自己判断来源(socket peerIp 还是 header)
5. ~~HOST_UUID_MISMATCH~~ 删除 — `findActiveByHostAndBoundIp(hostUuid, ...)` 的 WHERE 已经把 host_uuid 钉死,返回的 row 不可能与输入不一致,重复校验是纯冗余(Codex D.1 review Q6 NIT)。

### 为什么不在 identity 层做 "无 hostUuid 时回退 self"

- self-host 场景 caller(anthropicProxy 的挂载代码)本来就知道当前是 self,直接传 `hostUuid = SELF_HOST_UUID`。identity 层保持输入明确、无歧义。
- 回退分支放 identity 层会让单测矩阵爆炸,也违反 "不写防御性分支"。

### `SELF_HOST_UUID` 如何拿

commercial 启动时从 `compute_hosts WHERE name='self'` 读一次,进程级常量。若 DB 无 self 行 → fail-closed,bootstrap error。

**文件**: `packages/commercial/src/compute-pool/queries.ts`(可能已有 `getSelfHost` helper,查一下;没有就加一个小 helper)

### 单测

`packages/commercial/src/__tests__/containerIdentity.test.ts` 全部重写 mock repo,输入参数改 `{hostUuid, boundIp}` 形式。

## D.1b — master 侧新增 18443 mTLS HTTPS listener

**文件**: `packages/commercial/src/index.ts`(在现有 anthropicProxy 独立 server 紧随其后)

### 改动

1. 新 config 字段: `EXTERNAL_MTLS_BIND`(默认 `0.0.0.0`)+ `EXTERNAL_MTLS_PORT`(默认 `18443`)+ `EXTERNAL_MTLS_ENABLED`(默认 false,显式开)。缺配置 → 不启动,日志警告。
2. 启动 `https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true })`,复用 `ensureMasterLeaf` + `ensureCa`。
3. Handler:
   - **peer cert 双重校验**(新增 helper `verifyIncomingHostCert(socket): Promise<{ hostUuid }>` 放 `compute-pool/certAuthority.ts`,镜像 `nodeAgentClient.verifyServerCert` 的反向逻辑):
     1. `socket.getPeerCertificate(true)` 拿 DER → PEM,`extractSpiffeUris()` 匹配 `^spiffe://openclaude/host/([0-9a-f-]{36})$`,提取 `hostUuid`。匹配失败 → 403
     2. `fingerprint256` lowercase 无冒号 → 查 `compute_hosts WHERE id=hostUuid AND state='active' AND agent_cert_fingerprint_sha256 IS NOT NULL` 得到 expected fingerprint + state
     3. timingSafeEqual 比对 fingerprint,不一致 → 403(cert 泄露/已轮换/被吊销场景)
     4. host `state` 必须 `'active'`;若为 `'quarantined'` / `'draining'` / `'removed'` → 503(不是 403,区分"暂时不可用"与"身份非法")
   - 读 `X-V3-Container-IP` 头(严格 IPv4 正则 + `\r\n` 防御、`net.isIPv4()` 二次校验,防止 header 注入/伪造)。缺失或非法 → 400(Codex D.1 review Q7)
   - 调 `internalProxyHandler(req, res, { hostUuid, boundIp: containerIp })` ——
     **需要改 AnthropicProxyHandler 签名**,把 peerIp 参数换成 `ctx: { hostUuid: string; boundIp: string }`
4. self-host 那个 plain HTTP server 启动代码对应改成传 `{ hostUuid: SELF_HOST_UUID, boundIp: socket.remoteAddress }`

### 为什么双重校验(SAN URI + fingerprint pin)是必需的(Codex D.1 review Q1 MAJOR)

- 威胁模型:node-agent host 被攻破 / client cert + key 泄露
- 只做 SAN URI 校验 → 攻击者拿到 cert 后直到 cert 过期(90d)都能冒充该 host
- 加 fingerprint pin 查 DB → 运维可以通过 UPDATE `agent_cert_fingerprint_sha256` 立即吊销(compute_hosts migration 0030 comment 里明确写"M1: cert 撤销通过更新 compute_hosts.agent_cert_fingerprint_sha256")
- 组合 `host_uuid + bound_ip` 查 agent_containers 的键本就在 `queries.findActiveByHostAndBoundIp` 里,跨 host 冒充已被该层收敛 — fingerprint pin 补的是 **同 host cert 盗用后的吊销窗口**

### 为什么复用 handler 而不是新建一个

anthropicProxy 里除身份识别外的**全部**(rate limit / pricing / preCheck / finalize / broadcast)都与来源无关。只有 identity 入口参数变。新建一份就是大规模拷贝。

### 防火墙

GCP Tokyo 34.146.172.239:
```
gcloud compute firewall-rules create openclaude-v3-mtls-18443 \
  --network=<vpc> \
  --allow=tcp:18443 \
  --source-ranges=<node-agent 公网IP 白名单 CSV>
```
白名单管理在 D.3 admin API 落地后可以自动化(从 `compute_hosts.host` 列聚合生成),Batch D.1 先手动配。

## D.1c — node-agent L7 反代(Go)

**新文件**: `packages/commercial/node-agent/internal/internalproxy/internalproxy.go`

### 改动

1. 新监听 `<bridge_gateway_ip>:18791` plaintext HTTP server(容器 `ANTHROPIC_BASE_URL` 指向这里)。
2. 只接受 `POST /v1/messages`。其它 → 404。
3. Handler:
   - 读 `req.RemoteAddr` 拿容器 IP(bridge CIDR 内),做 allowlist 校验(必须匹配 `bridge_cidr`,防 host 网络外部扫描)
   - 构造出向 `https://<master_host>:18443/v1/messages`
   - 附 `X-V3-Container-IP: <容器 IP>` 头(严格 IPv4 格式,不透传用户输入)
   - 透传原 `Authorization` 头、原 body
   - 用 mTLS client(已有 cert/key/CA 加载代码在 client.go 类似地方)拨 master
   - stream 响应回容器(包括 SSE chunked)
4. 新 config 字段:
   - `master_mtls_endpoint`: e.g. `"34.146.172.239:18443"`(缺失 → internal proxy 不启动,容器调用 anthropic 会失败,显式 log error)
5. wire 到 `main.go` / `cmd/node-agent` 启动流程,与 egress 并列。

### Streaming

anthropicProxy 上游是 SSE,必须 **不做 buffer**,直接 `io.Copy(w.(http.Flusher), resp.Body)` 或类似。`http.Transport` 默认不 buffer,注意不要加 gzip。

### 关闭链接

Context cancel 传递:容器端断开 → cancel master 出向请求。用 `req.Context()` 直接给 `http.NewRequestWithContext`。

### 不做的

- 不做 retry / circuit breaker — 让上游错误透传给容器,容器 CCB 自己重试。
- 不做 per-container rate limit — master anthropicProxy 已做 per-uid。
- 不做 body 审计 — 那是 master 的事。

## D.1d — 部署影响

| 项 | self-host (34.146.172.239 现状) | remote host (未来) |
|----|--------|----------|
| 容器 `ANTHROPIC_BASE_URL` | `http://172.30.0.1:18791` (不变) | `http://172.30.<N>.1:18791` (nodeBootstrap 已按 host index 分配) |
| 18791 监听者 | commercial/src 里的 http server(现有) | node-agent 的 L7 反代(新,D.1c) |
| 18443 监听 | 启用(给未来远程 host 用;自 host 也可经它以统一代码路径,但默认走 plaintext 18791 更快) | — |
| 防火墙 | 18443 白名单 remote host 出口 IP | node-agent 能拨 master:18443 |
| mTLS CA | 现有(`certAuthority.ts`) | 现有 bootstrap 给每台 host 发 cert |

self-host 启用后**也**有 18443 监听,但自 host 容器仍走 18791 plaintext(省 TLS 开销)。18443 只接 remote node-agent。

## 验证目标(tasks.md 风格)

| step | verify |
|------|--------|
| D.1a | `cd /opt/openclaude/openclaude-v3 && npm test --workspace=@openclaude/commercial -- containerIdentity` 全绿 |
| D.1b | 本地 dev: `curl -k --cert <fake-host-cert> --key <key> -H "X-V3-Container-IP: 172.30.0.10" -X POST https://localhost:18443/v1/messages -d '{}'` 返 401 (identity 过不了,但走完路径); 错 cert/无 cert → TLS handshake fail |
| D.1c | node-agent unit test: POST 到 localhost:18791 能到 mock master (用 httptest.Server),X-V3-Container-IP 头和 body 正确透传 |
| D.1 整体 | 单测矩阵全绿 |

## 不在 D.1 做的

- (D.2) 其它 multi-host queries(`countActiveContainersByHost` 等)
- (D.3) admin API
- (D.4) admin UI
- (D.5) e2e 多 host
- 容器 `ANTHROPIC_BASE_URL` 由 supervisor 根据 host 类型动态生成(nodeBootstrap 已写了 bridge_cidr 派 gateway IP,v3supervisor 读 host 的 bridge_gw,不用改;仅需核对)

## 风险 / 待确认

1. self-host 也启 18443 会不会冲突 → 不会,两套 listener 不同端口(18791 self plaintext + 18443 mTLS 公网)
2. TLS cert SAN URI 解析依赖 OpenSSL 输出格式 — certAuthority.ts 有成熟解析,复用其 helper(`parseHostSpiffeFromCert` 类);若没现成,加一个
3. IPv6 容器 IP:MVP 明确只支持 IPv4 bridge,遇到 `::1` 类 peerIp → 400,不破坏
4. **同 host cert 盗用**: 若攻击者拿到某 host 的 client cert+key 但运维已 UPDATE fingerprint → 即使 `compute_hosts.state='active'`,`verifyIncomingHostCert` 的 fingerprint pin 比对仍会失败并返 403。吊销立即生效(下一个请求粒度),无需 TLS session drain。
5. `X-V3-Container-IP` 头若由容器自己发会不会被伪造?**不会** — 这个头只在 node-agent L7 反代 layer 注入。node-agent 识别容器 IP 用 `req.RemoteAddr`(TCP 四元组,容器无法伪造)。容器自己若在自己请求里塞 `X-V3-Container-IP`,node-agent 先调 `req.Header.Del("X-V3-Container-IP")` 再 `Set`,覆盖掉。务必在代码里显式 Del+Set,不是 Add。另外对要注入的 IP 字符串做 `strings.ContainsAny(ip, "\r\n")` 预校验(与现有 `egress.go` 对 X-V3 头的防御一致),防 header 折行注入。
