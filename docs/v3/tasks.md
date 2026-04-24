# v3 多机容器池 — 完整实现任务清单

**创建**: 2026-04-24
**目标**(boss 原话): "用户量上来后,继续加虚机,容器能自动创建到空闲的机器上。我只在管理界面添加虚机信息,其它所有操作全自动。"
**当前位置**: Chunks 1-6 完成,开始 Batch A。

---

## 术语

- **master**: 主控节点 = GCP Tokyo 34.146.172.239,跑 `openclaude.service` + PG + Redis + Caddy + anthropic proxy。管理界面、调度决策、用户 WS 入口都在这台。
- **host / 虚机**: 在管理界面加进来的工作节点,只跑 `openclaude-node-agent` systemd unit + docker。通过 mTLS 被 master 管控。
- **self host**: master 自己也作为 host 注册在 `compute_hosts` 表,`name='self'`,绕过 node-agent 走本地 docker。
- **baseline**: 平台强制注入容器的 CLAUDE.md + `skills/` 基线目录,master 持有权威版本。
- **ready**: health poll 状态机里表示 host 可调度;其它状态: `bootstrapping` / `quarantined` / `drained` / `removed`。

---

## 已完成 ✅

| Chunk | 内容 | 路径 |
|---|---|---|
| 1 | DB migration 0030(`compute_hosts` + `agent_containers.host_uuid` + `bound_ip_host_partial` uniq index) | `packages/commercial/migrations/0030*.sql` |
| 2 | mTLS CA + SPIFFE URI + 证书签发/续期原语 | `packages/commercial/src/compute-pool/certAuthority.ts` |
| 3 | nodeAgentClient(master → node-agent RPC,mTLS + PSK 双因子) | `packages/commercial/src/compute-pool/nodeAgentClient.ts` |
| 4 | node-agent Go 二进制(server / containers / tunnel / egress / renew / bootstrap-verify) | `packages/commercial/node-agent/` |
| 5 | nodeBootstrap(master 远程 SSH + deliver binary + keygen + sign cert + firewall + systemd) | `packages/commercial/src/compute-pool/nodeBootstrap.ts` + `sshExec.ts` |
| 6 | nodeHealth poll + nodeScheduler(sticky + least-loaded) | `packages/commercial/src/compute-pool/nodeHealth.ts` + `nodeScheduler.ts` |

---

## Batch A — node-agent 文件/卷/baseline 能力(远程容器落地的基座)

> 没有这批,远程 host 上无法建 volume、无法拿到 baseline、supervisor 路由到远程时必炸。

### A.1 node-agent 加 Volume RPC

**文件**: `packages/commercial/node-agent/internal/containers/volumes.go`(新)
**API**(注册到 server 路由):
- `POST /volumes/create  {name}` → `docker volume create --label openclaude.v3=1 <name>`
- `DELETE /volumes/{name}` → 先 `docker volume inspect` 验 label 归属,再 `docker volume rm`
- `GET /volumes/{name}` → 返 `{exists: bool, mountpoint?: string}`

**校验**:
- 名字 regex `^oc-v3-vol-[a-zA-Z0-9_-]{1,64}$`
- delete 前必须 assertOwned(label `openclaude.v3=1`),否则拒绝
- 并发控制: 复用 `globalSem`(32)

**验证命令**:
```bash
cd /opt/openclaude/openclaude-v3/packages/commercial/node-agent
go build ./... && go vet ./...
```

### A.2 node-agent 加 File Delivery RPC

**文件**: `packages/commercial/node-agent/internal/files/files.go`(新)
**API**:
- `PUT /files?path=<abs>&mode=<octal>` body = raw bytes → tmp + fsync + chmod + rename(原子)
- `DELETE /files?path=<abs>` → unlink
- `GET /files/stat?path=<abs>` → `{exists, size, mtime, sha256}`

**约束**:
- path 必须 abs 且前缀必须在白名单(`/var/lib/openclaude/baseline/`、`/run/ccb-ssh/`、`/var/lib/openclaude/user-data/` 三根)。其它路径一律 403。
- 单文件 body size 上限 16MB(bodyLimitReader)
- 并发: 同 path 互斥(per-path mutex),全局 semaphore 并发上限 16

**验证命令**: 同 A.1

### A.3 node-agent 加 Baseline Pull 能力

**文件**: `packages/commercial/node-agent/internal/baseline/baseline.go`(新)
**行为**:
- 启动时读 config `master_baseline_url`(如 `https://master.internal:18792/internal/v3/baseline-tarball`)
- 每 60s 轮询 `GET /internal/v3/baseline-version`,返 `{version: "sha256:abc..."}`;版本不匹配 → 触发拉取
- 拉取: `GET master_baseline_url` 用 mTLS client cert 认证,解 tar.gz 到 `/var/lib/openclaude/baseline/`(先解到 `.tmp`,校验 SHA256 后原子 `rename`)
- 版本记录: `/var/lib/openclaude/baseline/.version`

**API**(manual trigger):
- `POST /baseline/refresh` → 强制立即拉

**验证命令**:
```bash
go build ./... && go vet ./...
```

### A.4 master 加 baseline serve endpoint

**文件**: `packages/commercial/src/compute-pool/baselineServer.ts`(新)
**挂载**: 在 commercial 的 internal mTLS HTTP server(新增,监听 127.0.0.1:18792 + mTLS 客户端证书验证,SAN URI 必须为 `spiffe://openclaude/host/<uuid>`)
**路由**:
- `GET /internal/v3/baseline-version` → `{version}`,版本 = `sha256(tar.gz)`
- `GET /internal/v3/baseline-tarball` → 返 tar.gz 字节流

**实现**:
- master 启动时用 `tar -C /opt/openclaude/claude-code-best -czf -` 打 `CLAUDE.md` + `skills/baseline/`(具体子集由 `V3_CCB_BASELINE_SKILL_NAMES` 决定,跟 v3supervisor.ts 的 baseline 清单保持一致 —— 复用已有 `resolveCcbBaselineMounts`)
- 结果缓存在内存,带 SHA256;每 5min 检查源目录 mtime 变化 → 重建 tarball + bumping version
- version 查询 < 1ms,tarball 传输压缩后预期 < 1MB

**验证命令**:
```bash
cd /opt/openclaude/openclaude-v3/packages/commercial
npx tsc --noEmit
```

### A.5 master → node-agent client 补齐新 RPC

**文件**: `packages/commercial/src/compute-pool/nodeAgentClient.ts`(追加)
**新增函数**:
- `createVolume(target, name): Promise<void>`
- `removeVolume(target, name): Promise<void>`
- `inspectVolume(target, name): Promise<{exists, mountpoint?}>`
- `putFile(target, remotePath, content: Buffer, mode): Promise<void>`
- `deleteFile(target, remotePath): Promise<void>`
- `statFile(target, remotePath): Promise<{exists, size?, mtime?, sha256?}>`
- `triggerBaselineRefresh(target): Promise<void>`
- `getBaselineVersion(target): Promise<string>`

**验证命令**:
```bash
cd /opt/openclaude/openclaude-v3/packages/commercial
npx tsc --noEmit
```

### A.6 bootstrap 阶段触发第一次 baseline pull

**文件**: `packages/commercial/src/compute-pool/nodeBootstrap.ts`(改)
**改动**: 在 `agent_verify` step 之后、`final_verify` 之前,插入 step `baseline_first_pull`:
- 调 `triggerBaselineRefresh(target)`
- 轮询 `statFile(target, '/var/lib/openclaude/baseline/.version')`,30s 内应 exists
- 失败 → 整体 bootstrap fail(写 `bootstrap_step_failed` 记录)

### A.7 Batch A Codex Review

**提交**: 所有 A.1-A.6 diff 一次性给 Codex,model=`gpt-5.3-codex-spark`,按 `skill codex-review-loop` 流程。
**阻塞**: Codex PASS 前不进 Batch B。

---

## Batch B — master containerService facade + v3supervisor 改造

> 这批真正把"远程 host 能跑容器"接到 v3 业务层。

### B.1 定义 containerService 抽象

**文件**: `packages/commercial/src/compute-pool/containerService.ts`(新)
**接口**:
```ts
export interface ContainerSpec {
  name: string;               // oc-v3-<uid>
  image: string;
  env: string[];
  user: string;               // "1000:1000"
  networkName: string;        // openclaude-v3-net(self) 或 openclaude-br0(远程)
  boundIp: string;
  binds: string[];            // "src:dst:ro|rw"
  tmpfs: Record<string, string>;
  capDrop: string[];
  labels: Record<string, string>;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  readonlyRootfs: boolean;
  noNewPrivileges: boolean;
}

export interface ContainerService {
  ensureVolume(hostId: string, name: string): Promise<void>;
  removeVolume(hostId: string, name: string): Promise<void>;
  inspectVolume(hostId: string, name: string): Promise<{exists: boolean}>;

  createAndStart(hostId: string, spec: ContainerSpec): Promise<{containerInternalId: string}>;
  stop(hostId: string, cid: string, opts?: {timeoutSec?: number}): Promise<void>;
  remove(hostId: string, cid: string, opts?: {force?: boolean}): Promise<void>;
  inspect(hostId: string, cid: string): Promise<ContainerInspect>;
  waitReady(hostId: string, boundIp: string, port: number, opts: ReadinessOpts): Promise<void>;

  /** 供调用方决定是否走远程分支 */
  isRemote(hostId: string): Promise<boolean>;
  /** baseline 在 host 上的实际挂载路径(self = CCB 本地路径, remote = /var/lib/openclaude/baseline) */
  resolveBaselinePaths(hostId: string): Promise<{claudeMdHostPath: string; skillsDirHostPath: string} | null>;
}
```

**实现策略**:
- `LocalDockerBackend`: 走 `dockerode`(复用 v3supervisor.ts 里原来的调用)
- `RemoteNodeAgentBackend`: 走 `nodeAgentClient`
- `HostAwareContainerService`: 根据 `compute_hosts.name === 'self'` 路由到 local,否则 remote
- self host 复用 `/opt/openclaude/claude-code-best/{CLAUDE.md, skills/baseline}`;remote host 用 `/var/lib/openclaude/baseline/{CLAUDE.md, skills/}`(A.3 已拉好)

**验证命令**:
```bash
cd /opt/openclaude/openclaude-v3/packages/commercial
npx tsc --noEmit
```

### B.2 waitContainerReady 升级为 endpoint union

**文件**: `packages/commercial/src/agent-sandbox/v3readiness.ts`(改)
**改动**:
- 入参从 `(boundIp, port, opts)` 改成 `(endpoint: ReadinessEndpoint, opts)`
- `ReadinessEndpoint = {kind:'direct', host, port} | {kind:'node-tunnel', hostId, cid, internalPort}`
- `node-tunnel` 分支: 通过 `nodeAgentClient.openTunnel(hostId, cid, port)` 拿一个 HTTP HEAD/GET probe channel
- 所有调用方同步更新(grep `waitContainerReady`)

### B.3 v3supervisor.ts 接入 containerService

**文件**: `packages/commercial/src/agent-sandbox/v3supervisor.ts`(改)
**改动点**(grep 已知 3 处 + baseline 1 处):
- L883 `provisionV3Container` → `containerService.ensureVolume(hostId, volumeNames.data/projects)` + `containerService.createAndStart(hostId, spec)`
- L1209 `stopAndRemoveV3Container` → `containerService.stop + remove(hostId, cid)`
- L1308 `getV3ContainerStatus` → `containerService.inspect(hostId, cid)`
- baseline mounts: 改成调 `containerService.resolveBaselinePaths(hostId)`,self 返 master CCB 路径, remote 返 `/var/lib/openclaude/baseline/*`

**入参**: `V3SupervisorDeps` 加字段 `containerService: ContainerService` 和 `hostId: string`;`hostId` 由上层 `v3ensureRunning` 调 `nodeScheduler.schedule({userId: uid})` 拿。

**不破坏**:
- 原 error 类型(HostFull/ImageNotFound/CcbBaselineMissing/NameConflict)全部保留
- per-uid advisory lock / hostCap lock 语义不变(hostCap 改成 per-host,SELECT ... WHERE host_uuid=$1)
- bridgeSecret / secretHash / token 拼装逻辑不变

### B.4 v3ensureRunning 接入 scheduler

**文件**: `packages/commercial/src/agent-sandbox/v3ensureRunning.ts`(改)
**改动**:
- provision 分支前调 `scheduler.schedule({userId: uid})` 拿 `{hostId, hostHost, agentPort, boundIp, bridgeCidr}`
- `hostId` + `boundIp` 传给 `provisionV3Container(deps, uid, {hostId, boundIp})`
- running 分支: 从 `agent_containers` 行读 `host_uuid + bound_ip`,readiness 用对应 endpoint(self→direct,remote→node-tunnel)

### B.5 Batch B Codex Review

Codex `gpt-5.3-codex-spark`,full diff。PASS 前不进 Batch C。

---

## Batch C — SSH mux 跨机同步

> 让落到远程 host 的容器也能用"远程执行机"功能。

### C.1 sshMux materialize 增 host-aware 分支

**文件**: `packages/commercial/src/remote-hosts/sshMux.ts`(改)
**改动**:
- materialize 写文件前,读取容器将被分配的 `host_uuid`(通过传入参数)
- `host_uuid === self` → 写本机 `/run/ccb-ssh/u<uid>/h<hid>/`(现状)
- 远程 → 调 `nodeAgentClient.putFile(target, remotePath, content)` 同步写远端 `/run/ccb-ssh/u<uid>/h<hid>/{known_hosts, ctl.sock.hint}`
- `ctl.sock` 本身不跨机: 远程 host 的 node-agent 侧在容器启动前由 master 触发 RPC `startSshControlMaster(uid, hid, creds)` 让远端 host 本地跑 ControlMaster,sock 路径同语义

### C.2 node-agent 加 SSH ControlMaster RPC

**文件**: `packages/commercial/node-agent/internal/sshmux/sshmux.go`(新)
**API**:
- `POST /sshmux/start  {uid, hid, host, port, user, passwordB64}` → 在 `/run/ccb-ssh/u<uid>/h<hid>/` 起 `sshpass -d 3 ssh -M -N -S ctl.sock ...`
  - password 通过 fd 3 pipe 传给 sshpass,**不写盘**;写完立刻 zeroize
  - `known_hosts` 由 master 侧 `/files PUT` 先写好(C.1 的权威通道),start handler 仅校验存在 + 调 `chmod 0640 / chown root:AGENT_GID`
  - `runDir` chmod 0750 root:AGENT_GID;ready 后 `ctl.sock` chmod 0660 root:AGENT_GID
- `POST /sshmux/stop  {uid, hid}` → SIGTERM 进程组,3s 后 SIGKILL;`rm ctl.sock`。`known_hosts` / `runDir` 不删(master `releaseMux` 用 `/files DELETE` 清理)
- 并发模型:同 `(uid, hid)` 启停互斥,跨 key 并行
- 不实现 `GET /sshmux/list`(无调用方)

**实现细节**:
- `Manager` 单例,`reg` 用 `m.mu` 保护(仅 map 读写),启停互斥用 per-key lock
- `waitForReady`:`waitCh := make(chan error, 1)` + buffered `go cmd.Wait()` 填入;轮询 `ssh -O check`(单次 2s 超时避免卡死);超时或 master 提前退出均 kill pg + drain
- `Shutdown()`:并发 kill 所有 entry,总预算 5s,由 `Server.ListenAndServe` 在 `ctx.Done()` 时先于 `srv.Shutdown` 调用
- `agentGID = 1000`,与 TS 侧 `V3_AGENT_GID` 常量锁死

### C.3 bootstrap wire `setRemoteMuxDeps`(scheduler pre-warm 已放弃)

**文件**: `packages/commercial/src/index.ts`(改)

**实际改动**:
在 `registerCommercial()` 里 v3Deps 装配块之后、`createCommercialHandler` 之前,调用
`setRemoteMuxDeps({...})` 向 sshMux 注入 remote-aware 依赖:
- `resolvePlacement(userId, hostId)` — 按 userId 查 `findUserStickyHost` → self → `{kind:'self'}`,其它 → `{kind:'remote', target: hostRowToTarget(hostRow)}`。fail-closed:userId 非正整数 / 无 active 容器 / compute_host 找不到 → 抛 `RemoteHostError("INTERNAL", "NO_CONTAINER: ...")`
- `startSshControlMaster` / `stopSshControlMaster` — 直接透传 nodeAgentClient 同名函数
- `putRemoteFile` / `deleteRemoteFile` — 直接透传 `nodeAgentClient.putFile` / `deleteFile`

不注入时 remote 分支等同死代码(sshMux.ts defaultDeps 的 RPC fn 都会抛 "RPC fns not configured")。

**原 tasks.md 第二条("scheduler sticky-override 兜底")已放弃**,理由:
1. `/run/ccb-ssh` 的 ro bind mount VFS 语义是 live 可见,容器 spawn 后在宿主上创建的文件可以被容器看到(bind mount 只禁止 write/unlink/create,不禁止观察对端增加);不存在"spawn 时 ro 为空就永久为空"
2. `pickHost` 时没有 sessionId + 用户还没选 user_remote_hosts,根本无法 pre-trigger `acquireMux`
3. `findUserStickyHost` 在"首次开容器"时返 null,没有 sticky host 可 override
4. gateway `sessionManager.ts:1357` 已经在"session 切换到 remote host"时惰性 `acquireMux`,路径已覆盖

Codex plan-review + code-review 双 PASS。M1 语义是"一个 user 最多占一台 compute_host",如果未来放宽需重新 keyed by `(userId, hostId)`。

### C.4 Batch C Codex Holistic Review

**结论**: BLOCK 0 / MAJOR 2 / MINOR 3 / NIT 2。MAJOR-1 已修复,其余 defer:

- ✅ **MAJOR-1 修复**: `acquireMuxRemote` 的 rollback 原本只 delete 文件,不 stop 远端 ControlMaster。若 node-agent 在 `/sshmux/start` 进程起后 / 响应前 TLS 断,master 侧判失败但远端 mux 已起,导致 orphan。修法:catch 块里 `startAttempted=true` 时额外发 `stopSshControlMaster(target, uidInt, hostId)` best-effort,stop handler 对不存在 key 幂等。

- ⚠️ **MAJOR-2 记录为已知边界(非本 batch 修)**: `releaseMux` remote 分支 stop RPC 失败 → 旧 compute_host 残留 mux;用户容器从 A 漂移到 B 后,新 lazy acquireMux 会建 B 上的 mux,旧 A 上的进入 orphan。`(userId, hostId)` mutex 语义本身没问题,但 stop 失败没有**异步重试队列**。M2 兜底方向:node-agent 侧装 idle sweep,scan reg 里 ctl.sock 已坏 / 最后接入 >1h 的 entry 主动 stop。当前依赖 node-agent 进程退出时 Shutdown 统一清。

- ℹ️ **MINOR-1**: `passwordB64` 是 V8 immutable string,`JSON.stringify(args)` 中间副本无法原位清零。已有 CCB comments 标记,TLS 承担边界,接受。

- ℹ️ **MINOR-2**: `NO_CONTAINER` 上游没统一重试策略。容器刚 provision 时短时抖动失败的处理属于 sessionManager 职责,挪到 Batch D 的 anthropicProxy / userChatBridge 改动里再定。

- ℹ️ **MINOR-3**: node-agent 错误码细(VALIDATION / KNOWN_HOSTS_NOT_REGULAR / READY_TIMEOUT / BIND_BUSY),master 侧都 map 到通用 `RemoteHostError`。可观测性弱化,非正确性 bug,非本 batch 修。

- **NIT-1 / NIT-2** 记录,不阻断。

---

## Batch D — proxy + admin UI + 测试 + 终审

### D.1 多机 identity lookup + master 18443 mTLS 入口 + node-agent L7 反代

**详细 plan (plan-review PASS)**: `docs/v3/D1-plan-draft.md`

**关键架构决策** (2026-04-24 与 boss 定稿):
- 放弃原 CONNECT/X-V3-Host-UUID header-in-tunnel 路线。理由:容器 `ANTHROPIC_BASE_URL = http://172.30.0.1:18791` 是 plaintext HTTP 直连 bridge gateway,不走 HTTPS_PROXY,egress.go 的 CONNECT + X-V3 注入其实是为容器访问**其它** HTTPS 站点做的通用出口代理,与 anthropic 主路径无关。
- 新方案 = **L7 反代**: remote host 的 node-agent 在 bridge gateway 18791 plaintext 接容器 → mTLS HTTPS POST 到 master:18443 → master 从 client cert SAN URI 解 host_uuid + fingerprint pin 查 DB,从 `X-V3-Container-IP` 头拿 bound_ip → 走现有 anthropicProxy handler。self-host 保持现状走 18791 plaintext。

**三个子任务**:

**D.1a — `packages/commercial/src/auth/containerIdentity.ts` 改造**
- `ContainerIdentityRepo.findActiveByBoundIp(ip)` → `findActiveByHostAndBoundIp(hostUuid, boundIp)`,底层调 `compute-pool/queries.findActiveByHostAndBoundIp`(已存在)
- `verifyContainerIdentity(repo, peerIp, auth)` 签名改为 `verifyContainerIdentity(repo, ctx: { hostUuid, boundIp }, auth)`
- `ContainerIdentity` 加 `hostUuid` 字段
- `createPgIdentityRepo` 同步改造
- 不加 `HOST_UUID_MISMATCH` errcode(`findActiveByHostAndBoundIp` WHERE 已钉 host_uuid,重复校验冗余)
- 单测 `__tests__/containerIdentity.test.ts` 全部重写 mock repo 接口

**D.1b — master 新增 0.0.0.0:18443 mTLS HTTPS listener**
- `packages/commercial/src/index.ts`: 现有 plaintext 18791 server 启动代码之后,再起一个 `https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true })`
- 新 config: `EXTERNAL_MTLS_BIND` (默认 `0.0.0.0`) + `EXTERNAL_MTLS_PORT`(默认 18443)+ `EXTERNAL_MTLS_ENABLED`(显式 opt-in)
- 新 helper `verifyIncomingHostCert(socket): Promise<{ hostUuid }>` 放 `compute-pool/certAuthority.ts`(镜像 `nodeAgentClient.verifyServerCert` 反向版):
  1. SAN URI 解 hostUuid
  2. 查 `compute_hosts WHERE id=hostUuid AND state='active'` 拿 expected fingerprint
  3. `peerCert.fingerprint256` lowercase 无冒号,timingSafeEqual 比对,mismatch → 403
  4. state ≠ 'active' (quarantined/draining/removed) → 503(区分身份非法 vs 暂不可用)
  5. 每请求查 DB,不缓存 fingerprint(运维 UPDATE fingerprint 即时吊销)
- handler 读 `X-V3-Container-IP` 头,严格 IPv4 + `\r\n` + `net.isIPv4()` 三重校验
- self-host plain HTTP server 代码对应改成传 `{ hostUuid: SELF_HOST_UUID, boundIp: socket.remoteAddress }`
- `AnthropicProxyHandler` 签名从 `(req, res, peerIp)` 改为 `(req, res, ctx: { hostUuid, boundIp })`

**D.1c — `packages/commercial/node-agent/internal/internalproxy/internalproxy.go`(新)**
- bridge gateway `<bridge_gw_ip>:18791` plain HTTP listener
- 只接 `POST /v1/messages`,其它 404
- 读 `req.RemoteAddr` 拿容器 IP,校验在 bridge CIDR 内
- 构造 mTLS HTTPS POST 到 `<master_mtls_endpoint>/v1/messages`,stream 透传 body + `Authorization` 头,显式 `req.Header.Del("X-V3-Container-IP"); req.Header.Set("X-V3-Container-IP", containerIp)` 防容器伪造
- IP 字符串做 `strings.ContainsAny(ip, "\r\n")` 预校验(与 egress.go 风格一致)
- 用 `req.Context()` 做上下游 cancel 联动;`http.Transport` 默认不 buffer,SSE 自然透传
- 不做 retry / circuit breaker / per-container rate limit(master 层有 per-uid)
- 新 config: `master_mtls_endpoint`(缺失则不启动该 listener)
- wire 到 `cmd/node-agent` 启动,与 egress 并列

**威胁模型收敛**(Codex Q1 MAJOR 采纳):
- 跨 host 冒充 → `findActiveByHostAndBoundIp` 组合键收敛
- 同 host cert 盗用 → fingerprint pin + DB state 双重校验,运维 UPDATE `agent_cert_fingerprint_sha256` 下一请求粒度即时吊销
- 容器伪造 X-V3-Container-IP → node-agent `Del + Set` 覆盖
- Header 折行注入 → 三重校验(regex + `\r\n` + `net.isIPv4`)

**验证目标**:
- D.1a: `npm test --workspace=@openclaude/commercial -- containerIdentity` 全绿
- D.1b: `curl -k --cert ... --key ... -H "X-V3-Container-IP: 172.30.1.10" -X POST https://localhost:18443/v1/messages -d '{}'` → 401(identity 合法但无 active container,走完全路径);cert 错/无 → TLS fail;fingerprint mismatch → 403;host state=quarantined → 503
- D.1c: node-agent unit test 用 `httptest.Server` 验 POST/Authorization/X-V3-Container-IP 透传正确

### D.2 queries 加 multi-host 查询

**文件**: `packages/commercial/src/compute-pool/queries.ts` 和/或 `src/agent-sandbox/queries.ts`
**新增**:
- `findActiveByHostAndBoundIp(hostUuid, boundIp)`
- `countActiveContainersByHost(hostUuid)`(已有? 确认)
- `findUserStickyHost(uid)`(已有,确认行为)

### D.3 admin HTTP API — 虚机管理

**文件**: `packages/commercial/src/admin/computeHostsRoutes.ts`(新)
**路由**(挂在现有 admin router 下,复用 admin auth):
- `GET /admin/v3/compute-hosts` → 列出所有 hosts + 状态 + active 容器数 + cert 剩余天数 + 最后 health 时间
- `POST /admin/v3/compute-hosts/add  {host, port, username, password, bridgeCidr, agentPort, maxContainers}` → 异步启动 bootstrap,立即返 `{hostId, status: 'bootstrapping'}`
- `GET /admin/v3/compute-hosts/:id/bootstrap-log` → 返 bootstrap 各 step 状态
- `POST /admin/v3/compute-hosts/:id/drain` → 标记 status='drained',停止新容器落入
- `POST /admin/v3/compute-hosts/:id/remove` → 必须 drained + active=0 才能删
- `POST /admin/v3/compute-hosts/:id/quarantine-clear` → 手动从 quarantined 拉回 ready
- `GET /admin/v3/baseline-version` → 返当前 baseline 版本 + 每 host 已同步版本(便于排障)

### D.4 admin UI — 虚机 tab

**文件**: `packages/commercial/public/admin/v3-hosts.html` + `.js`
**功能**:
- 表格: host_uuid / name / host / port / status / active/max / cert_expire / last_health
- "添加虚机" 表单(password 字段 autocomplete=off,提交后立即 `.value=''`)
- 每行 actions: View bootstrap log / Drain / Remove / Re-bootstrap
- 实时刷新(5s 轮询)
- 添加后自动跳到 bootstrap log 视图,显示每 step 实时状态(success/running/failed)

### D.5 端到端测试

**新文件**:
- `packages/commercial/src/compute-pool/__tests__/nodeScheduler.test.ts`
- `packages/commercial/src/compute-pool/__tests__/containerService.test.ts`(mock backends)
- `packages/commercial/src/compute-pool/__tests__/nodeBootstrap.smoke.test.ts`(用 localhost docker 模拟)
- `packages/commercial/src/agent-sandbox/__tests__/v3supervisor.multihost.test.ts`(mock containerService,验证 remote path 分流)

**验证命令**:
```bash
cd /opt/openclaude/openclaude-v3/packages/commercial
npm test
npx tsc --noEmit
```

### D.6 最终 Codex 审计(整仓 diff)

Model `gpt-5.3-codex-spark`,按 `skill codex-review-loop`。PASS 后才能 merge。

### D.7 上线流程

1. `deploy-to-remote.sh` 部署 master 代码到 34.146.172.239(v3 商用版专属路径,不走 45.32)
2. migration 0030 跑
3. master 重启,确认 `compute_hosts` 表里已自动注册 `self` host
4. 登入 admin,添加一台测试虚机,观察 bootstrap log 全绿 → ready
5. 造一个测试用户,观察 scheduler 把容器分配到测试虚机,anthropic 代理正常工作
6. 测试用户 idle 几小时 → 容器被 sweep,remote host 侧 container 也清理
7. 主动 drain 测试虚机 → 后续新用户不再落入 → remove

---

## 执行约束

1. **Codex review 强制**: 每 Batch 结束先给 Codex `gpt-5.3-codex-spark` 审,PASS 前不进下一 Batch。违反 = 违反 CLAUDE.md 强制条款。
2. **dev 验证**: commercial v3 不走 45.32 dev 规则,但也不直接 push 生产。每 Batch 在本地 `/opt/openclaude/openclaude-v3/` typecheck + test 全绿,再 rsync 到 34.146.172.239 staging 验证。
3. **安全不妥协**: PSK/私钥/密码所有内存字符串必须 `.fill(0)` zeroize;mTLS 客户端证书 SAN URI 必须校验;Bearer PSK 必须 `subtle.ConstantTimeCompare`。
4. **Scope 纪律**: 只改 tasks.md 列出的文件;顺手改进 / 添加不需要的防御(per global CLAUDE.md rule 3 "Surgical Changes")一律拒绝。
5. **凭据不落文档**: 任何 host password / PSK / 证书内容都不写进 git、不 echo 进 log。
6. **断点续传**: 每 Batch 完成后 commit 一次,commit msg 带 `batch-A` / `batch-B` 等标签。中途被打断重启只从对应 batch 开头接。

---

## 进度追踪

- [x] Chunks 1-6(基础设施)
- [ ] Batch A(node-agent 文件/卷/baseline RPC) — **正在做**
  - [ ] A.1 volumes.go
  - [ ] A.2 files.go
  - [ ] A.3 baseline.go
  - [ ] A.4 baselineServer.ts + internal mTLS server
  - [ ] A.5 nodeAgentClient 补齐 RPC
  - [ ] A.6 bootstrap 接入 baseline_first_pull
  - [ ] A.7 Codex review PASS
- [ ] Batch B(containerService + v3supervisor 改造)
  - [ ] B.1 containerService.ts
  - [ ] B.2 v3readiness endpoint union
  - [ ] B.3 v3supervisor.ts 3 处改造 + baseline 路径分流
  - [ ] B.4 v3ensureRunning 接 scheduler
  - [ ] B.5 Codex review PASS
- [ ] Batch C(SSH mux 跨机)
  - [ ] C.1 sshMux host-aware
  - [ ] C.2 node-agent sshmux RPC
  - [ ] C.3 scheduler sticky-override
  - [ ] C.4 Codex review PASS
- [ ] Batch D(proxy + admin UI + 测试 + 终审)
  - [ ] D.1 anthropicProxy X-V3 头
  - [ ] D.2 queries multi-host
  - [ ] D.3 admin HTTP API
  - [ ] D.4 admin UI
  - [ ] D.5 测试
  - [ ] D.6 Codex final review PASS
  - [ ] D.7 上线验证

---

*每次 session 开始先读本文件找下一个未勾选项,全自动推进。遇到 blocker 在对应任务下写 `<!-- BLOCKER: ... -->` 然后停下问 boss。*
