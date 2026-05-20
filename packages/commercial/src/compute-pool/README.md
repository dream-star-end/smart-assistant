# compute-pool

跨主机调度 / 容器分发 / 镜像分发 / node-agent client。

## Coverage Status(2026-05-20)

按 prod 实际跑通的路径标注。"DORMANT"指生产路径上**当前没有运行实例**触发该代码,测试仍维护是因为代码本身还在,作为再启用时的回归基线。

| 测试文件 | 状态 | 备注 |
|---|---|---|
| `__tests__/master-mtls-url.test.ts` | **ACTIVE** | 纯函数(`isPrivateIp` / `chooseMasterMtlsUrl`),master 端 mTLS URL 选择,与 host 数量无关 |
| `__tests__/nodeScheduler.test.ts` | **ACTIVE** | `pickHost` / `pickBoundIp`;self-host(`compute_hosts` 表里的 'self' 行)也走 |
| `__tests__/containerService.test.ts` | **ACTIVE** | `HostAwareContainerService` self-host → `LocalDockerBackend`,**生产主路径** |
| `__tests__/v3VolumeGc.test.ts` | **ACTIVE** | `runVolumeGcTick`,self-host fan-out 仍走;0 remote host 时退化为本机 dockerode |
| `__tests__/computeHostsDiskMonitor.test.ts` | **ACTIVE** | metrics monitor,self-host 也作为被 monitor host 计入 |
| `__tests__/hostReqCounter.test.ts` | **ACTIVE** | 请求计数器,纯逻辑 |
| `__tests__/queriesAtomicLifecycle.integ.test.ts`(在 `src/__tests__/`) | **ACTIVE** | atomic lifecycle SQL,self-host 创建/销毁容器都走 |
| `__tests__/nodeAgentClient.test.ts`(在 `compute-pool/__tests__/`) | **DORMANT** | Go node-agent mTLS RPC client;0 remote host → 不被调用 |
| `__tests__/remoteCodexAuth.test.ts`(在 `src/__tests__/`) | **DORMANT** | 通过 node-agent 写 remote container 的 codex auth.json;同上依赖 0 实例 |
| `__tests__/imageDistribute.test.ts`(在 `src/__tests__/`) | **DORMANT** | `distributePreheatToAllHosts` 过滤 self / 非 ready,self-only → [];0 remote host → noop |
| `__tests__/computePoolAudit.test.ts`(在 `src/__tests__/`) | **DORMANT** | admin 分发 host 操作的审计写入;0 remote host 时 admin 路径不触发 |

## 何时把 DORMANT 改回 ACTIVE

任一条件成立即应回滚状态:

1. `compute_hosts` 表新增非 'self' 行(任何 remote host bootstrap),且 `status='ready'`
2. `node-agent` 二进制被部署到任一 remote host
3. 跨 host 镜像分发 / volume GC / codex auth 写入有真实流量

历史: 2026-04-25 boheyun(38.55.134.227)曾接入 pool,2026-05 后停用。当前 prod (`commercial-v3` GCE Tokyo) 仅 self host。
