# R7 — Docker Volume GCS Backup & Cross-Host Restore (Plan)

最后更新: 2026-04-27 (Plan v3.1, Codex round-3 PASS for R7.1 implementation)

## Changelog
- v3.1 (2026-04-27): Codex round-3 反馈处理。§4.1 锁 key 显式复用 `acquireUserLifecycleLock(client, uid)` (v3supervisor.ts:516),不自创 hashtext。§4.1 加 PG pool guardrail 段:并发 backup 上限、metric 监控、hard timeout。§4.5 / §4.6 收紧 header 接口:不接受 generic Record<string,string>,只接受 `ifGenerationMatch` 数字字符串,helper 内 curl 命令的 header name 固定写死。
- v3 (2026-04-27): Codex round-2 反馈处理。NEEDS-CHANGES: §4.1 stopAndRemoveV3Container 内部主动获取 per-uid lifecycle advisory lock(caller 不一定持锁,idle sweep / admin 不持)。扫除 v1 残留:§3 顶图 / §4.7 / §8 R7.3 统一到 v2 语义(去掉 resumable session、selfHostId gating、baseline 分发)。§4.3 / §4.5 / §4.6 If-Generation-Match 改为显式 `headers` 字段下发给 helper,curl 原样传。§10 加 blocking/deferred 划分。
- v2 (2026-04-27): Codex round-1 反馈处理。BLOCKER: §4.1 触发 gating 改为允许 remote host(经 ContainerService 路由),`UPDATE vanished` 仍先于 backup 执行,backup 用 `wasActive` captured 判定。§4.2 restore 失败抛 `ContainerUnreadyError` 不启动空 volume。NEEDS-CHANGES: §4.2 restore 挂点改为 `provisionV3Container` 内、`ensureVolume` 后,持 per-uid lifecycle lock。§4.3 tar object 名加唯一后缀(timestamp + containerId + 短 uuid)。§4.5 helper 镜像分发改为复用 image distribute 机制(需调研),不再依赖 baseline。§6 boheyun 跨洋上传速度作为 launch gate,加进 §8 / §10。§9 简化 V1 不做 resumable session。§8 / §10 / §11 多处补强。
- v1 (2026-04-27): 初版。

## 1. 背景与目标

### 1.1 上一站 (v1.0.17 sticky scheduling) 留下的缺口

v1.0.17 (commit 5575961, 已上线) 让调度优先回到用户最近用过的 host:

- `findUserDataHost(userId)` 查 `state IN ('active','vanished')` 最近一行
- dataHost 健康 → 必须用它(sticky 命中,99% case)
- dataHost 主动 busy(`draining` / cooldown / 容量满) → 抛 `NodePoolBusyError`
- dataHost **被动失败**(`quarantined` / `broken` / 行被删 / `bootstrapping`) → fall through 到 least-loaded

**fall through 的语义**:让用户能继续工作,但代价是新 host 上 docker volume 不存在 → ensureRunning 走 `ensureVolume` 创建空 volume → 用户看到空工作区。

这是 sticky 的故意妥协: 我们选择 "可用性 > 数据保留"。R7 要补上的是: **fall-through 路径上,如果 GCS 里有这个 user 的备份,先恢复,再启动容器**。

### 1.2 R7 目标

| 维度 | 目标 |
|------|------|
| **正常路径(99%)** | sticky 命中,**完全不触发** R7 任何逻辑(无延迟、无成本、无依赖) |
| **fall-through(1%)** | 新 host 拉取 GCS 最近备份并解压到 fresh volume,然后启动容器。用户看到 **几秒延迟 + 最近一次备份的状态**(而不是空工作区) |
| **灾难恢复 (DR)** | 即便 dataHost 整机永久丢失,GCS 仍保留 ≤30d 历史快照 |
| **零回归** | sticky 命中路径不引入任何 GCS 调用、不引入任何阻塞步骤 |

### 1.3 非目标

- **不替代 sticky**: sticky 仍是首选 (本机 volume → 0 网络 IO)
- **不做实时同步 / 跨主机镜像**: GCS 是异步快照,不保证 RPO=0
- **不做容器内 live snapshot**: 备份在容器**已 stop** 时执行,保证文件系统一致
- **不在所有 stop 路径执行**(参见 §4.1): 只在"主动停 + 仍 active"语义下推送

---

## 2. 现有代码地形(关键 anchor)

| 模块 | 文件 / 函数 | R7 关联 |
|------|------------|---------|
| 调度 fall-through 命中点 | `nodeScheduler.ts: pickHostForNewContainer` (v1.0.17 新分支) | restore trigger 在这里挂 |
| 容器停-删 chokepoint | `v3supervisor.ts: stopAndRemoveV3Container` (line 1513) | backup trigger 在这里挂(stop 后 / vanished 前 vol 还在) |
| Volume 抽象 | `containerService.ts: HostAwareContainerService` | 新增 `backupVolume / restoreVolume` 方法 |
| Local backend | `LocalDockerBackend` | self host 上直接 docker run tar |
| Remote backend | `RemoteNodeAgentBackend` | 远端走 mTLS 到 node-agent |
| Node-agent 卷 op | `node-agent/internal/containers/volumes.go` | 新增 `BackupVolume / RestoreVolume`(docker run 临时容器 tar+zstd) |
| Node-agent HTTP | `node-agent/internal/server/server.go` | 新增 `POST /volumes/{name}/backup`、`POST /volumes/{name}/restore` |
| Idle sweep | `v3idleSweep.ts` | 不动(走 `stopAndRemoveV3Container`,backup 已挂在 chokepoint) |

---

## 3. 顶层设计

```
┌─────────────────────────────────────────────────────────────────┐
│ Master (gateway)                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ GcsBackupBroker                                             │ │
│  │  - 持有 service account JSON (env GOOGLE_APPLICATION_CREDS)  │ │
│  │  - issueUploadUrls(uid, containerDbId) → 2 个 V4 signed PUT  │ │
│  │      URL + ifGenerationMatch="0" (单字段,非 generic headers)│ │
│  │  - issueDownloadUrls(uid, manifest) → 2 个 V4 signed GET     │ │
│  │  - readManifest(uid) / commitManifest(uid, m, ifGenMatch)   │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ ContainerService(host-aware, R7 扩展)                        │ │
│  │  + canBackup(hostId): bool (cache pos 30s / neg 5s)         │ │
│  │  + backupVolume(hostId, name, {url,ifGenMatch,timeoutSec})  │ │
│  │  + restoreVolume(hostId, name, {url,sha,timeoutSec})        │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ stopAndRemoveV3Container (扩展 R7-aware,内部持 advisory lock) │ │
│  │  acquireUserLifecycleLock(client, uid)  // 复用 supervisor 现有 │ │
│  │  → SELECT (snap wasActive,hostUuid) → UPDATE vanished →     │ │
│  │  stop → if wasActive&canBackup: backup → commit manifest    │ │
│  │  → remove (持锁全程,与 provision/GC 共用同一锁 key)           │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ provisionV3Container (持 per-uid lifecycle lock)             │ │
│  │  ensureVolume(new) → if restoreIntent&manifest: restore      │ │
│  │  → restore 失败:删 volume + ContainerUnreadyError 重试        │ │
│  │  → createAndStart                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                  │ mTLS                              │ mTLS
                  ▼                                   ▼
┌──────────────────────────┐         ┌──────────────────────────────┐
│ self / tk1 / boheyun-1   │         │ ...                          │
│ node-agent (Go)          │         │                              │
│  POST /volumes/X/backup  │         │                              │
│  POST /volumes/X/restore │         │                              │
│   docker run --rm        │         │                              │
│     -v X:/src:ro <helper>│         │                              │
│     (tar | zstd | curl   │         │                              │
│      -X PUT --data-bin   │         │                              │
│      -H "x-goog-if-gen") │         │                              │
└──────────────────────────┘         └──────────────────────────────┘
                          │ HTTPS PUT (V4 signed) / GET (V4 signed)
                          ▼
                ┌──────────────────────────┐
                │ GCS bucket               │
                │ openclaude-v3-volumes    │
                │  (asia-northeast1)       │
                │   u<uid>/data-<ISO>.tzst │
                │   u<uid>/proj-<ISO>.tzst │
                │   u<uid>/manifest.json   │
                │  Lifecycle: 30d 删除      │
                └──────────────────────────┘
```

### 3.1 关键架构选择

1. **凭据集中在 master**: node-agent **不持** GCS 凭据,只用一次性 signed URL。理由:
   - 减小爆破面(node-agent 在 boheyun-1 跨 ISP,不能放长期凭据)
   - 凭据轮换只改一处
2. **数据流不经 master**: master 只发 URL,bytes 直接 node-agent ↔ GCS。理由:
   - master 是 single point,几十 MB 流量打过来会卡住聊天主业
   - GCP egress 直连最便宜
3. **资源不变**: node-agent 现有 docker socket 权限就够,**不引入 gsutil / gcloud** Go SDK。用 curl + signed URL 是最小变更。
4. **Sticky 正常路径不动**: backup 是异步的,即便 GCS 全挂,sticky 命中仍然 100% 工作。

---

## 4. 详细设计

### 4.1 Backup 触发点(精确到一行代码)

**唯一触发点**: `stopAndRemoveV3Container` (v3supervisor.ts:1513)

为什么这里:
- 全 v3 系统中,**所有让用户 volume "可能与 host 解绑"** 的路径都汇到这一函数:idle sweep / admin force / re-provision / ensureRunning self-heal。
- 函数当前先 `UPDATE state='vanished'` 再 stop+remove docker。**插入 backup 的位置**: stop 完成、UPDATE 已落、remove 之前。

**修改后顺序(v3 — 内部加 per-uid advisory lock + 保留"意图先落 DB"不变量)**:
```
0. BEGIN; SELECT user_id FROM agent_containers WHERE id=$1
   --- 先拿到 uid,用于 advisory lock key
1. await acquireUserLifecycleLock(client, uid)  // ★ v3 修正:复用 v3supervisor.ts:516 现有函数
   --- 这个函数已经是 (USER_LIFECYCLE_LOCK_NS, uid|0) 二元锁,与 provisionV3Container
       和 v3volumeGc 共用同一锁 key (v3supervisor.ts:511-514 注释明示)
   --- 关键变化:caller (idleSweep / admin) 不再保证持锁,本函数自己拿
   --- xact-scoped,COMMIT/ROLLBACK 自动释放
   ⚠️  绝不能用新 hashtext key 或自创锁 — 必须复用 acquireUserLifecycleLock,
       否则与 provisionV3Container 锁 key 不同 → 同 uid race 仍然存在
2. SELECT state, host_uuid FROM agent_containers WHERE id=$1
   --- 读 row 快照(锁后再读,看到的是最新状态),捕获 wasActive = (state == 'active'),hostUuid
3. UPDATE state='vanished' (保留现有顺序 — admin/idle sweep 意图必须先落 DB,
   防止 docker 步骤失败导致 row 残留 active + 容器半死的旧 bug)
4. docker stop t=5  --- best-effort,失败转 5
5. if (wasActive && hostUuid && r7Broker?.isEnabled() && containerService.canBackup(hostUuid)):
     a. master.issueUploadUrls(uid, containerDbId) → 2 个 V4 signed PUT URL (1h 过期)
        + ifGenerationMatch="0" 字段(单字段,非 generic headers,见 §4.5/§4.6.5),
        objectName 含唯一后缀 {ts}-{containerId}-{shortUuid}
     b. containerService.backupVolume(hostUuid, dataVolName, {url, ifGenerationMatch, timeoutSec}) // 路由到 self/remote
        containerService.backupVolume(hostUuid, projVolName, {url, ifGenerationMatch, timeoutSec})
        --- 并发执行,各自 hard timeout(默认 120s,可按 host 调,见 §6.2)
     c. master.commitManifest(uid, {dataObject, projObject, sha256, size, sourceHostId, ts})
        --- If-Generation-Match CAS;冲突则 LWW 重试(本次 ts 更新 → 覆盖)
   else:
     沿用现有逻辑,backup 跳过
6. docker remove force
7. 事务结束(advisory lock 自动释放)
8. 任意 backup 步骤失败:
     a. log.warn + emit metric `r7.backup.failure_total{reason,host}`
     b. **仍然继续** remove(不挡 idle sweep / admin)
     c. manifest 不更新 → 这次 backup 视作未发生(下次 stopAndRemove 再试)
```

**关键不变量(v2 加固)**:
- **意图先落 DB**: `UPDATE vanished` 在 step 2 不动,backup 失败不影响这条状态机不变量(参见 v3supervisor.ts:1495 注释)。如果 backup 后才 UPDATE,master 在 step 4 崩溃 → row 残留 active + container 已 stopped → 用户卡 stopped/missing 循环(旧 bug 复发)。
- **wasActive 是 captured 状态**: 不依赖当前 row state(已被 step 2 翻成 vanished),用 step 1 的快照判定。这样幂等重入(v3volumeGc 重复调本函数 / 测试 mock)在 vanished 行上不会重复 backup。
- **backup 路由到 host**: gating 不再是 `host==selfHostId`,改为 `containerService.canBackup(hostUuid)`(self 直接 docker run / remote 走 mTLS 调 node-agent)。这样 tk1 / boheyun-1 上的容器也参与备份,只是上传由该 host 上的 node-agent 完成。

**为什么 stopAndRemoveV3Container 内部主动持 per-uid advisory lock(v3 修正)**:
- Codex round-2 finding: `provisionV3Container` 持 lifecycle lock,但 `idleSweep` / admin stop/remove 调本函数时**当前不持**。 v2 plan 错误假设 caller 持锁。
- 实际并发风险:row 已 `vanished`、docker container 还没 remove 时,另一 ensureRunning tick 可能开始 provision 同 uid → 撞容器名冲突 / volume in-use → 4503 重试 120s 窗口。
- 修法:本函数 step 1 调 `acquireUserLifecycleLock(client, uid)`(v3supervisor.ts:516 已有),与 `provisionV3Container` (line 1121 调同一函数) 和 `v3volumeGc` (volumeGc.ts:250 调同一函数) **共用同一二元锁 key** (USER_LIFECYCLE_LOCK_NS=0x0cb3d001, uid|0)。这样同 uid 的 stop / provision / GC 是 mutually exclusive。
- 不用 row lock(`SELECT FOR UPDATE`):row lock 持 120s 等 GCS 上传 → 阻塞同 row 的其它 admin 查询(idleSweep 看到 NOWAIT 失败也只能跳过)。advisory lock 是 hash space 锁,不挡查询。

**PG connection pool guardrail(Codex round-3 finding)**:
- 持锁事务最长 = backup timeout (120s) + remove time。对 master PG pool (实测 max=20 in production) 是真实压力。
- v3idleSweep 当前 `LIMIT 10` 单 tick → 串行处理 → 不会同时 hold 10 连接 120s。
- admin force-stop 并发是潜在风险:admin UI 一次点 batch stop 可能并发触发。
- **必须的工程约束**(写进 R7.3 实施前置):
  1. idleSweep / batch admin force-stop 路径上,backup-aware stop **必须**走单 worker 队列(不允许 fan-out concurrent),metric `r7.backup.in_flight_total` 监控
  2. PG pool 监控加 `r7.backup.pool_wait_ms` (acquire client 耗时);超过阈值告警
  3. 任何 backup 路径 hard timeout 不能去掉(不能等 GCS 慢链路无限期)
  4. 同一 master 实例上 backup 并发上限 ≤ 3(留 17 个 PG 连接给聊天主路径)

**RPO 透明声明**: R7 RPO = "最近一次受控 stopAndRemove 后的状态"。docker daemon 自发 stop / host reboot / host 突然失联 / 容器 OOM 都不会触发 backup。这是已知妥协,反映在 §11 风险登记。

### 4.2 Restore 触发点(精确到一行代码)

**Scheduler 端**: `pickHostForNewContainer` 的 fall-through 分支(nodeScheduler.ts,v1.0.17 改完后)在返回结构上加 `restoreIntent: { uid, sourceHostId, manifestRef } | null`。**scheduler 不执行 restore**,只标意图。

**实际执行点(v2 — 修正)**: `provisionV3Container` 内部,**`ensureVolume` 之后、`createAndStart` 之前**,在已持 per-uid lifecycle advisory lock 的关键区里完成 restore。这是因为:
- `ensureRunning → provisionV3Container` 才是真正持 lifecycle lock 的层(v3supervisor.ts:1121)
- volume 创建发生在 `provisionV3Container` 内部,与 restore 必须在同一锁下,避免另一个 ensureRunning tick 在 restore 中途看到非空 volume 直接启动
- restore 必须发生在 `createAndStart` **前**,否则容器会基于空 volume 启动,等 restore 写入时就是 race condition

**伪代码(在 provisionV3Container 内,持 lifecycle lock 的范围)**:
```ts
// — 现有: ensureVolume(data) / ensureVolume(proj) —
await containerService.ensureVolume(host.id, dataVolumeName);
await containerService.ensureVolume(host.id, projVolumeName);

// — R7: 仅当 caller 传入 restoreIntent 时执行 —
if (restoreIntent && r7Broker.isEnabled() && r7Broker.isRestoreEnabled()) {
  const manifest = await r7Broker.readManifest(restoreIntent.uid);
  if (manifest) {
    try {
      const { dataUrl, projUrl } = await r7Broker.issueDownloadUrls(restoreIntent.uid, manifest);
      await Promise.all([
        containerService.restoreVolume(host.id, dataVolumeName, {
          downloadUrl: dataUrl, expectedSha256: manifest.data.sha256,
        }),
        containerService.restoreVolume(host.id, projVolumeName, {
          downloadUrl: projUrl, expectedSha256: manifest.proj.sha256,
        }),
      ]);
      log.info('R7 restore complete', { uid: restoreIntent.uid, fromHost: restoreIntent.sourceHostId, toHost: host.id });
    } catch (err) {
      // ★ v2 修正: 决不让空 volume 进入业务可写状态(否则下次 backup 会污染好的备份)
      // 兜底删 volume → 抛 ContainerUnreadyError 让 userChatBridge 走 4503 retry,
      // 客户端轮询时下次再试 restore;若 GCS 持续抖动,admin 看告警。
      try {
        await containerService.removeVolume(host.id, dataVolumeName);
        await containerService.removeVolume(host.id, projVolumeName);
      } catch (cleanupErr) {
        log.error('R7 restore failed AND cleanup failed; volumes may be empty', {...});
      }
      log.error('R7 restore failed', { stage: extractStage(err), uid: restoreIntent.uid });
      throw new ContainerUnreadyError('restore_failed', { retryAfterSec: 10 });
    }
  } else {
    // manifest 不存在(从未 backup)→ 用空 volume 是合理的
    log.info('R7 restore intent with no manifest; proceed with empty volumes', { uid: restoreIntent.uid });
  }
}

// — 现有: createAndStart —
const { containerInternalId } = await containerService.createAndStart(host.id, spec);
```

**Restore 失败处理(v2 修正)**:
- 下载/解压/sha 校验任一失败 → 兜底删 volume → 抛 `ContainerUnreadyError("restore_failed", {retryAfterSec:10})`
- userChatBridge 现有 4503 重试机制接住,客户端轮询时下次再试 restore
- **不**让空 volume 进入业务可写状态(否则容器一旦写入,下次 stopAndRemove 触发 backup 时,空状态会被推上 GCS 覆盖最近一次好的备份)
- 持续失败 → admin 看到 `r7.restore.failure_total{reason,stage}` 告警,人工干预决定是否手动跳过 R7(临时关 `R7_RESTORE_ENABLED=0`)

**为什么不让用户用空 volume 继续**: §4.1 的 backup 触发会在 next stopAndRemove 把空 volume 推上 GCS,从而把 user 的最近一次有效备份覆盖掉。这是一条不可逆数据丢失路径,必须用阻塞重试避免。代价是 fall-through 期间 GCS 抖动会让用户看到 "环境初始化中" 转圈,但聊天主路径(已建立的 sticky 会话)不受影响。

### 4.3 GCS 数据布局

```
gs://openclaude-v3-volumes/        # bucket name
  ├── u<uid>/
  │   ├── data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst   # 卷 data 内容(唯一名)
  │   ├── proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst   # 卷 proj 内容(唯一名)
  │   └── manifest.json                                   # 最新 pointer
  └── ...
```

**Object 名格式(v2 修正)**: `{kind}-{ISO8601}-c{containerDbId}-{shortUuid}.tar.zst`,其中:
- `kind` ∈ {`data`,`proj`}
- `ISO8601` 用 `:` → `-` (S3/GCS 友好)
- `containerDbId` 是 agent_containers.id(便于事后追溯哪次 stopAndRemove 产物)
- `shortUuid` 是 `crypto.randomUUID().slice(0,4)` 4 字符随机后缀,**保证两个并发 backup 同一秒也不撞名**

**Object 写入并发保护**: master 在 `issueUploadUrls` 时,对每个 V4 signed PUT URL 注入 `x-goog-if-generation-match: 0` 头(强制 PUT 必须是创建,不能覆盖已存在 object)。这样即便不同 worker 算出同一 object 名(uuid 撞概率 1/65536 × 同秒同 cid),后写者得到 412 → 重试生成新 uuid。

`manifest.json`:
```json
{
  "version": 1,
  "uid": 32,
  "updatedAt": "2026-04-27T03:15:22Z",
  "sourceHostId": "bc99292f-...",
  "sourceHostName": "self",
  "sourceContainerId": 1234,
  "data": {
    "object": "u32/data-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    "sha256": "...", "size": 12345, "createdAt": "..."
  },
  "proj": {
    "object": "u32/proj-2026-04-27T03-15-22Z-c1234-a3f2.tar.zst",
    "sha256": "...", "size": 6789, "createdAt": "..."
  }
}
```

**Bucket 配置**:
- Region: `asia-northeast1` (Tokyo) — self/tk1 同区,boheyun-1 (US) 跨洋,这是已知妥协(见 §6 成本)
- Storage class: `STANDARD`
- Versioning: **off** (我们靠时间戳路径自己版本化,避免 GCS versioning 计费冗余)
- Lifecycle:
  ```json
  [
    { "action": {"type": "Delete"},
      "condition": {"matchesPrefix": ["u"], "age": 30, "matchesSuffix": [".tar.zst"]} },
    { "action": {"type": "Delete"},
      "condition": {"matchesPrefix": ["u"], "age": 90, "matchesSuffix": ["/manifest.json"]} }
  ]
  ```
  manifest 多保 60d 是为了用户被 ban 90d → 自动删 volume 的边界 case 取证。
- IAM: master service account 持 `roles/storage.objectAdmin`(只对此 bucket);node-agent **不持** 任何 GCS 角色,只用一次性 URL。
- `Object retention: not used` (lifecycle 已经够)
- `Soft-delete policy: 7d` (GCP 2024 默认开启,作为误删兜底)

### 4.4 Manifest 写入的原子性

manifest.json 写法:
1. node-agent 完成两个 tar.zst 上传(各自得到 sha256 + size)
2. master 收到两端的回报后,组装新 manifest JSON
3. master 直接 PUT 到 `manifest.json`,使用 GCS 的 `If-Generation-Match` 头实现 CAS:
   - 第一次写: `If-Generation-Match: 0`(对象不存在)
   - 后续写: `If-Generation-Match: <prev_generation>`
4. 拿到 412 Precondition Failed → 说明并发修改 → 重读 → 比较时间戳 → 决定是否覆盖
5. 极端 case (双写):**保留最新时间戳的 manifest**(简单 LWW;两个 master 不会共存,这个分支主要防 idle sweep 与 admin force 同时走)

**为什么不用 generation 链表 / GCS object versioning**:
- 我们不需要历史 manifest,旧的 tar.zst 走 lifecycle age 自动清
- versioning 会把每次 PUT 都留版本 → 计费 + 复杂度

### 4.5 node-agent 新 HTTP 端点

**`POST /volumes/{name}/backup`** (V1 简化:V4 signed PUT,不用 resumable session)
```
请求 body:
{
  "uploadUrl": "https://storage.googleapis.com/<bucket>/<obj>?X-Goog-Signature=...",   # V4 signed PUT URL
  "ifGenerationMatch": "0",                                                            # 仅这一个 header 字段(v3 收紧)
  "timeoutSec": 120
}

行为:
  1. 校验 name 走 ValidateVolumeName 现有 regex
  2. inspectVolumeNoLock 确认 volume 存在 + label 归属正确
  3. 严格校验 ifGenerationMatch:必须是 ASCII 数字字符串(`^[0-9]+$`),否则 400
  4. docker run --rm \
       -v <name>:/src:ro \
       -e UPLOAD_URL=<uploadUrl> \
       -e GCS_IF_GEN_MATCH=<ifGenerationMatch> \
       <R7_HELPER_IMAGE> \
       (helper exec curl 用 argv 数组形式: `curl -X PUT --data-binary @- -H "x-goog-if-generation-match: $GCS_IF_GEN_MATCH" "$UPLOAD_URL"` —— curl 命令固定写死 header 名,只把数字值替进去,不接受任意 header)
  5. 解析 helper 输出的 JSON 报告 (size, sha256, http_status)
  6. 返回 {"size": N, "sha256": "...", "collide": false}

错误:
  - GCS 412 (object 名撞了 / If-Generation-Match 失败) → helper 报 http_status=412 → node-agent 返 200 + {"collide": true} → master 重生 uuid 重试
  - 上传失败 (curl exit != 0 / GCS HTTP != 200/201/412): 容器 exit code != 0 → 解析 stderr → 返 502 + reason
  - 超时: docker run 被 ctx 取消 → 杀容器 → 返 504
```

**Header allowlist 设计(v3 修正,Codex round-3 finding)**:
- ❌ 不接受 `Record<string, string>` 任意 headers — 哪怕 master escape 也是更大攻击面
- ✅ 只接受 `ifGenerationMatch` 单一字段,值必须是 ASCII 数字
- helper 内 curl 命令的 `-H` flag 名字固定写死 `x-goog-if-generation-match`,不从 env 拼接
- node-agent 用 `exec.Command(docker, args...)` argv 数组形式调用,与现有 volumes.go 严格对齐(line 71-77 已有先例)
- 未来如需更多 signed headers,逐个加白名单字段(明确显式),不开 generic header 接口

**`POST /volumes/{name}/restore`**
```
请求 body:
{
  "downloadUrl": "https://storage.googleapis.com/...",  # V4 signed GET URL (1h 过期)
  "expectedSha256": "...",                              # 必填,download 完成后必校验
  "timeoutSec": 180
}

行为:
  1. 校验 name + inspectVolumeNoLock
  2. 校验 volume 必须为空(避免覆盖正在用的 volume) — 用 `docker run --rm -v X:/dst:ro alpine sh -c "ls -A /dst | head -1"`,non-empty 直接返 409
  3. docker run --rm \
       -v <name>:/dst:rw \
       -e DOWNLOAD_URL=<downloadUrl> \
       -e EXPECTED_SHA=<expectedSha256> \
       <R7_HELPER_IMAGE> \
       (entrypoint 做 curl | tee >(sha256sum) | zstd -d | tar -xpf -,流式)
  4. 解析报告,返回 {"size": N, "sha256": "..."}

错误:
  - sha 不匹配 → exit !=0 → 502
  - 解压失败(磁盘满/损坏 tar)→ 502
  - 超时 → 504
```

**helper 镜像 `openclaude/r7-backup-helper:<sha>`**:
- 基于 alpine:3.19,装 `zstd, tar, curl, coreutils` (sha256sum)
- entrypoint 是单一 `/usr/local/bin/r7-helper.sh`,~50 行 shell,read-only mount + docker 隔离
- 不引入 Go 依赖,不增 node-agent 二进制大小

**镜像分发机制(v2 修正 — 不依赖 baseline pipeline)**:
- ⚠️ **R7.2 launch gate**: 调研现有 image distribution(`packages/commercial/src/agent-sandbox/imageDistribute.ts` 等)是否能复用给 helper 镜像。Plan-phase **不锁定方案**,实施 PR 内根据现有能力决定。
- 候选方案 A: 把 helper 镜像加进 v3 supervisor 启动时 `pullImageIfMissing` 列表,与 `openclaude/v3-agent` 镜像同期发布
- 候选方案 B: 跟主镜像同期发布,master 启动时 `inspectImage` 校验,缺失 → 该 host R7 自动 disable
- 候选方案 C: 不用 helper 镜像,直接 docker run alpine:3.19 + 内联 sh -c 命令(略增 node-agent 复杂度,但消除分发依赖,**KISS 备选**)
- 任一方案的兜底: `inspectImage` 失败 → admin dashboard 显示该 host R7 `disabled`,不阻断聊天主路径,emit `r7.helper_image_missing{host}`

### 4.6 Master 端: GcsBackupBroker

新模块: `packages/commercial/src/r7-backup/gcsBackupBroker.ts`

Public API:
```ts
class GcsBackupBroker {
  async isEnabled(): Promise<boolean>;  // env vars present + bucket reachable

  async issueUploadUrls(uid: number, containerDbId: number): Promise<{
    // V4 signed PUT URL 必须把 x-goog-if-generation-match: 0 作为 signed header 一起签,
    // 否则 GCS 不强制 precondition。
    // v3 收紧:不返回 generic headers map,只返回 ifGenerationMatch 数字字符串,
    // helper 内 curl 命令的 header name 固定写死,只把这个数字值替进去。
    data: { url: string; objectName: string; ifGenerationMatch: string };
    proj: { url: string; objectName: string; ifGenerationMatch: string };
    expiresAt: number;
  }>;

  async issueDownloadUrls(uid: number, manifest: Manifest): Promise<{
    data: { url: string };
    proj: { url: string };
    expiresAt: number;
  }>;

  async readManifest(uid: number): Promise<Manifest | null>;

  async commitManifest(uid: number, manifest: Manifest): Promise<{ committed: boolean }>;

  async deleteUserBackups(uid: number): Promise<void>;  // 给 v3volumeGc 调
}
```

**实现**:
- 用 `@google-cloud/storage` (Node SDK) — 已经在 npm 上,加进 commercial workspace 即可
- service account JSON 路径走 env `GOOGLE_APPLICATION_CREDENTIALS`,标准 GCP 习惯
- bucket 名走 env `R7_GCS_BUCKET`
- 全 disabled 路径: 任一 env 缺失 → `isEnabled() = false`,所有 issue/* 立刻返 disabled,master 主路径完全跳过 R7

### 4.6.5 ContainerService 接口扩展(v2 新增)

`HostAwareContainerService` 增加三个方法,把 backup/restore 的 self/remote 路由收在这一层(对 supervisor 透明):

```ts
interface ContainerService {
  // 现有方法 (ensureVolume, removeVolume, inspectVolume, createAndStart, stop, remove, ...)

  /** 该 host 是否能跑 backup/restore(检查 helper 镜像 + node-agent 版本)。 */
  canBackup(hostId: string): Promise<boolean>;

  /** 把 volume 内容流式上传到 GCS signed PUT URL。
   *  v3 收紧:不接受 generic headers,只接受 ifGenerationMatch 数字字符串,
   *  防止任意 header 注入(细节见 §4.5)。 */
  backupVolume(hostId: string, volumeName: string, opts: {
    uploadUrl: string;
    ifGenerationMatch: string;  // 必须 /^[0-9]+$/
    timeoutSec: number;
  }): Promise<{ size: number; sha256: string; collide?: boolean }>;

  /** 从 GCS signed GET URL 拉取 → 校验 sha → 解压到空 volume。 */
  restoreVolume(hostId: string, volumeName: string, opts: {
    downloadUrl: string;
    expectedSha256: string;
    timeoutSec: number;
  }): Promise<{ size: number; sha256: string }>;
}
```

- LocalDockerBackend: 直接用本机 dockerode 跑 helper container
- RemoteNodeAgentBackend: 走 mTLS POST 到 `/volumes/{name}/backup` 或 `/restore`
- canBackup 实现(v3 修正):**asymmetric cache** — positive (true) 30s,negative (false) 5s。原因:刚部署完 helper 镜像后 30s 内的 idle sweep 会无谓漏备份,负缓存短一点能尽快恢复;正缓存可以稍长。helper image deploy / node-agent refresh 完成后 master 可以显式调 `containerService.invalidate(hostId)` 立即失效。

这样 §4.7 supervisor 改动不需要知道 host 是 self 还是 remote,只调 `containerService.canBackup(hostId)` 决定是否走 backup。

### 4.7 Backup 触发的 supervisor 改动(扩展现有签名)

`stopAndRemoveV3Container(deps, containerRow, timeoutSec)` 的 `deps` 已经是依赖注入,加 R7 broker:

```ts
type V3SupervisorDeps = {
  pool: Pool;
  docker: Docker;
  selfHostId?: string;
  containerService?: HostAwareContainerService;
  r7Broker?: GcsBackupBroker;  // 新增,可选;未注入或 isEnabled()=false 走 no-op
};
```

`stopAndRemoveV3Container` 改造(v3 修正):
1. 函数顶部主动 acquire per-uid advisory lock(见 §4.1 step 1)
2. 保留 "UPDATE state='vanished' 先于 docker" 不变量
3. 仅当 `wasActive(captured) && hostUuid && r7Broker?.isEnabled() && containerService.canBackup(hostUuid)` 时执行 backup;**任一不满足都跳过 backup,但其它步骤不变**
4. 跨 host 不再是 gating(由 `containerService.canBackup` 内部路由判定)
5. R7 全关时,函数体内的 backup 块整体跳过,等价于今天的实现 → 零行为变化

这避免回归:R7 全关或 host 不支持时,这个函数除了多一个 advisory lock(无 R7 时锁内不做 GCS 调用,持锁时间 ~ms 级)等价于今天的实现。

### 4.8 v3volumeGc 集成

`v3volumeGc` 当前 GC 触发条件:用户被 ban 7d / 90d 不登录 → 删 docker volume。
R7 集成:**同时** 删 GCS 备份,避免被遗忘的备份占空间 + 履行 user 数据删除承诺。

实现:在现有 `v3volumeGc` 删 volume 那一步前,先调 `r7Broker.deleteUserBackups(uid)`(列出 `u<uid>/*` 全删)。失败仅 log,不挡 GC 主路径。

---

## 5. Schema 变更

**`compute_hosts` 表**: 不动。

**`agent_containers` 表**: 不动 manifest 元数据全靠 GCS,DB 不存。

**新增 metric / log**:
- `r7.backup.success_total{host}` / `r7.backup.failure_total{host,reason}`
- `r7.backup.bytes_total{host,kind}`(累计上传字节)
- `r7.restore.success_total{host}` / `r7.restore.failure_total{host,reason,stage}`
- `r7.manifest.cas_conflict_total{}`

(metric backend 是现有 `metricsRegistry`,直接挂)

---

## 6. 成本评估

### 6.1 当前(2026-04-27 实测)

- 32 个 active 用户,数据 volume 大小 mostly 8K-40K(`du -s /var/lib/docker/volumes/oc-v3-data-uX/_data` 实测)
- 整体备份大小 < 10MB tar.zst
- 每个用户每周触发 1-2 次 stopAndRemove(idle sweep) → 每周 64 次备份 × 1MB = 64MB 上传
- GCS storage cost (asia-northeast1, STANDARD): **$0.020/GB·month** → 月度存储 < 1MB × 30d × 32 user = ~1GB → **$0.02/月** ✅
- GCS egress (恢复时): 极少触发,1% × 32 user × 1MB = 0.3MB/月 → 接近 0 ✅

### 6.2 中规模(假想 1000 用户,平均 100MB 卷)

- 月度存储: 1000 × 100MB × 30d-持有 = 3000 GB·month × $0.020 = **$60/月**
- Backup 写入: PUT 操作免费,但跨地区上传走 ISP egress
  - **boheyun-1 (US Lightsail) → GCS asia-northeast1**: AWS Lightsail 出 internet 是 $0.09/GB
    - 1000 用户里 30% 在 boheyun(估算)= 300 用户 × 2 backup/week × 100MB = 24 GB/week → **$2.16/周 = $9/月**
  - **GCP Tokyo (self/tk1) → GCS Tokyo**: 同 region 同 project egress = **$0**
- Restore 读取: 1% fall-through × 1000 user × 100MB = 1 GB/月 egress
  - 出 GCS 到 GCP Tokyo 同 region: $0 ✅
  - 出 GCS 到 boheyun (cross-region internet): $0.12/GB → 微乎其微

**总计**: 中规模下约 **$70/月**,比 boss 当前 v3 整体云成本是个位数百分比,可接受。

### 6.3 大规模触发的优化策略(R7 v2)

如果未来用户卷涨到 GB 级(开发 Next.js / Python 项目带 .next / node_modules / .venv):

1. **排除策略**: helper 脚本支持 `EXCLUDE` env(逗号分隔),tar 时跳过:
   ```
   EXCLUDE=node_modules,.next,dist,.cache,__pycache__,.venv
   ```
2. **增量备份**: tar `--listed-incremental` + 每 N 次全量(本期不做,留 R7.5)
3. **本地预筛**: helper 跑前 du -sh,> 1GB 报警(管理员决定排除策略)

**初版 (R7.1) 不做这些**,直接全量 tar.zst。10 用户 × 100MB 仍然秒级完成。

---

## 7. 安全评估

| 威胁 | 缓解 |
|------|------|
| **GCS 凭据泄露** | 只在 master 持有;node-agent 仅获一次性 URL |
| **跨 user 数据泄漏(URL 被劫持)** | URL 为 V4 signed,1h 过期,object path 含 uid;mTLS 通道传输 |
| **Restore 写错 volume(uid 错位)** | volume name regex `^oc-v3-(data|proj)-u[1-9][0-9]+$` 严格;master 校验 manifest.uid==expected uid |
| **恶意 tar(zip-slip)** | helper 用 `tar -xpf` 不带 `--absolute-names`,GNU tar 默认拒 abs path 和 `..` |
| **空 volume 上覆盖** | helper restore 前必须 volume 为空,non-empty 返 409 |
| **Master 被 compromise → 偷所有 backup** | 这是已存在的威胁面,R7 不放大(master 已有 DB 全访问) |
| **Helper 镜像被替换** | 走 §4.5 选定的 image distribution 机制(R7.2 决策),与 v3 现有 `openclaude/v3-agent` 镜像同等供应链 |

---

## 8. 实施分阶段

| 阶段 | 范围 | 验收 |
|------|------|------|
| **R7.1** | GcsBackupBroker + 单一 user 手动触发 backup/restore CLI | 一个 user 能 backup → 删 host 上 volume → restore → diff = 0 |
| **R7.2** | helper 镜像分发(调研复用 imageDistribute / 内联 sh -c)+ node-agent /backup /restore endpoints + **boheyun 跨洋上传速度实测** (Open Q2 launch gate) | 端到端走通,**未集成进 stopAndRemove / scheduler**;实测三个 size × 三个 host 上传耗时表落 doc |
| **R7.3** | 接进 stopAndRemoveV3Container(内部 advisory lock + wasActive captured + canBackup 路由 + 失败 best-effort) | 一次 idle sweep 后 GCS 出现 manifest;并发 admin force-stop 与 idle sweep 不冲突 |
| **R7.4** | 接进 nodeScheduler fall-through restore 路径 | 模拟 host quarantine → 用户重连 → 看到 restore 后的工作区 |
| **R7.5** | v3volumeGc 集成 + admin 监控 dashboard + lifecycle 配 30d | GC 删 user 时 GCS 也清干净;admin 页能看到 backup 总量 |

每阶段独立 PR,Codex review 走 plan→code 流程。

### 8.1 端到端验收脚本(R7.4 阶段)

`scripts/r7-acceptance.sh` (新建):
```
1. 准备: ensure user u32 active container on self
2. 写一些独有内容:
   docker exec <cid> sh -c "echo 'hello-r7' > /data/r7-canary.txt; echo 'proj-r7' > /workspace/proj-canary.txt"
3. 强制 stopAndRemove (idle sweep simulator):
   curl -X POST $ADMIN/api/admin/v3/containers/$cid/force-stop
4. 等待 GCS manifest 出现 (poll 30s)
   gsutil cat gs://openclaude-v3-volumes/u32/manifest.json
5. 模拟 host quarantine:
   psql -c "UPDATE compute_hosts SET status='quarantined' WHERE name='self'"
6. 让 u32 重新 ensureRunning(发一条聊天消息):
   curl -X POST $API/api/chat?uid=32 -d '{"message":"hi"}'
7. 等待新 host 上容器 ready
8. 验证 canary 文件存在:
   docker exec <new_cid> cat /data/r7-canary.txt   # → 'hello-r7' ✅
   docker exec <new_cid> cat /workspace/proj-canary.txt  # → 'proj-r7' ✅
9. 清理: 取消 quarantine,删测试容器
```

成功标准:
- canary 内容完整匹配
- 端到端延迟(stopAndRemove 到 restore 完成)< 60s
- 无 master 错误日志,无 admin 告警

---

## 9. 配置 / Env

新加 env(全部 optional,缺失 = R7 disabled):
```
R7_GCS_BUCKET=openclaude-v3-volumes
R7_GCS_REGION=asia-northeast1
GOOGLE_APPLICATION_CREDENTIALS=/etc/openclaude/r7-sa.json
R7_BACKUP_ENABLED=1                # admin kill-switch
R7_RESTORE_ENABLED=1               # admin kill-switch (单独控制)
R7_BACKUP_TIMEOUT_SEC=120
R7_RESTORE_TIMEOUT_SEC=180
R7_HELPER_IMAGE=openclaude/r7-backup-helper:<sha>
```

`R7_BACKUP_ENABLED=0` + `R7_RESTORE_ENABLED=0` = 完全 no-op,等价于今天行为。

Admin 页加两个开关 + 当前 backup 总数 / 总字节展示。

---

## 10. Open Questions(需 boss 确认)

**按 stage gating 分组**(v3 新增,Codex round-2 reply):

| Stage gate | 必须先定的 Q | 可 deferred |
|------------|-------------|-------------|
| **R7.1 实现前 blocking** | Q1 (bucket/凭据), Q10 (R7.1 是否含 remote);若 R7.1 含真实 restore CLI,还要 Q4 (restore 失败策略) | — |
| **R7.2 实现前 blocking** | Q2 (boheyun launch gate 实测), helper 分发方案(R7.2 内决) | — |
| **R7.3 / R7.4 实现前 blocking** | Q3 (RPO/RTO), Q4 (restore 失败 UX), Q5 (前端 cold-start UX) | — |
| **R7.5 / 远期** | Q6 (manifest 写 DB), Q7 (exclude policy,除非实测发现卷已 > 1GB), Q8 (admin 删除按钮), Q9 (host reboot 主动 backup) | 全部可推 |

**详细列表**:


1. **GCP 项目和 bucket 创建权限**: master 现在跑在哪个 GCP project?bucket `openclaude-v3-volumes` 由谁创?要不要复用现有 PG backup pull 的脚本基础设施?
2. **Boheyun-1 跨洋上传可用性(launch gate,关键)**: §6.2 boheyun-1 (US Lightsail) → GCS asia-northeast1 的实测吞吐是多少?如果 1GB 卷需要 300s,120s timeout 会让 boheyun 用户**永远没有备份**。R7.2 必须实测三个数字: 100KB / 10MB / 100MB 卷的 P50 / P99 上传耗时。如果 P99 > 60s 即超过 default timeout,需要其一: (a) 按 host 配 timeout(boheyun 拉到 600s)(b) 设置 max backup size 阈值,超过的卷不备份并 admin 看到 alert(c) 临时关 boheyun 的 R7,只对 GCP host 启用。**boss 需决策接受哪种降级策略**。
3. **RPO/RTO 目标**: §4.1 透明声明 R7 RPO = "最近一次受控 stopAndRemove",docker daemon 自发 stop / host reboot / OOM 不会触发 backup。boss 是否能接受这个 RPO?如果不行,需要加 v3orphanReconcile 路径的主动 backup(本期不做)。RTO = restore 完成时间;100MB 卷 boheyun 跨洋下载估计 30-60s,可接受?
4. **Restore 失败时阻塞 vs 让用户用空 volume**: §4.2 选择阻塞重试(更安全,避免污染 GCS 备份)。代价:一次 GCS 长时间抖动会让 fall-through 的 user 持续看到"环境初始化中"。boss 是否同意"数据完整性 > 立即可用性"?如果偏向后者,需提供 admin override(`R7_RESTORE_ENABLED=0` 临时关 R7 让用户进空 volume)。
5. **Cold-start UX**: fall-through 的 restore 期间,聊天界面是否需要新提示?可在 v1.0.13 的"环境初始化中"横条上加 R7 子状态"正在恢复工作区..."。
6. **Manifest 是否要写 DB**: 当前方案只写 GCS。如果担心 GCS 抖动导致 master 不知道有 backup,可加 `agent_containers.last_backup_at` 列。R7.1 不做,留 R7.5 看实际频率。
7. **Volume size 上限 / exclude 策略**: 是否首版就需要排除 `node_modules / .next / .venv / .cache`?如果用户跑大型 webdev 项目,卷可能 > 1GB,首版全量 tar 会超时。简单做法:helper 镜像内 hard-coded `--exclude` list。
8. **删除用户(GDPR / 退款)**: deleteUserBackups 是 v3volumeGc 自动做,还是要给 admin 一个手动按钮?
9. **host reboot / active-but-stopped 行的恢复策略**: container `RestartPolicy=no`,host 重启后会留下 active row + stopped container。R7 应不应在 v3orphanReconcile 路径主动 backup 这种 row?(本期暂不做,记为已知 RPO 缺口)
10. **R7.1 是否支持 remote host(tk1/boheyun)还是先只做 self**: 如果只做 self,§6.2 boheyun 跨洋讨论可以推迟,但 fall-through 路径上 tk1 / boheyun 用户仍然空 volume。boss 倾向 R7.1 全 host 还是 self-only 启动?

---

## 11. 风险登记

| 风险 | 等级 | 缓解 |
|------|------|------|
| GCS 抖动导致 stopAndRemove 卡住 | 高 | hard timeout 120s,失败仅 log + best-effort,不挡停容器;`UPDATE vanished` 仍在 backup 之前(v2 修正) |
| Boheyun 跨洋上传 P99 > timeout | 高 | R7.2 launch gate 实测;按 host 配置 timeout 或 max size,boss 决策(§10 Q2) |
| 双 master 实例并发 backup → object 名撞 | 低 | object 名加 4 字符 uuid 后缀,同时 PUT 带 If-Generation-Match: 0,撞了重生 uuid 重试 |
| 双 master 实例并发 backup → manifest 冲突 | 低 | If-Generation-Match CAS,LWW 容许丢一次 |
| Restore 失败 → 空 volume 进业务 → 污染下次 backup | 高 | v2 修正:restore 失败兜底删 volume + 抛 ContainerUnreadyError 让前端重试,**不**让空 volume 启动 |
| helper 镜像无法分发到 host | 中 | R7.2 调研后选 imageDistribute 复用 / 内联 sh -c,失败 → 该 host R7 自动 disable |
| 大 volume 备份打爆出口带宽 | 中 | timeout 截断 + 监控 r7.backup.bytes_total;§10 Q7 决定首版 exclude 策略 |
| Restore 内容损坏(网络中断) | 中 | helper sha256 校验,不匹配 → 502 + 删 volume + 抛 retry |
| 服务账号密钥泄漏 | 中 | bucket-scope IAM + 文件 600 权限 + 90d 轮换;node-agent 不持久化凭据 |
| GCS lifecycle 误删活跃数据 | 低 | object age 30d,远超活跃 user 的 stop-stop 间隔(idle sweep 30 min) |
| Backup gating 把 vanished 行重复 backup | 中 | wasActive captured 状态判定,vanished 调本函数时 wasActive=false → 跳过 |
| host reboot 后 active-but-stopped 行无 backup | 中 | 已知 RPO 缺口,§10 Q9 留 boss 决策;R7.1 不覆盖 |

---

## 12. 何时算 done

R7 阶段 1-5 全部:
- 单元测试覆盖 broker / 触发判定 / 失败回退路径(≥ 36 个新 case,跟 sticky 风格一致)
- Codex 三轮审过(plan PASS + code 至少两轮)
- 端到端脚本(§8.1)在三台 host 全跑通
- prod 跑一周后 admin dashboard 显示
  - r7.backup.success_rate > 99%
  - r7.restore.success_rate > 95%(允许少量 stale manifest)
  - 0 conflict 报警
- Open Questions 全部有 boss 确认的答案落到此文档

---

## 13. 跟踪

- 父 plan: 本文档
- 关联 v1.0.17: commit 5575961, tag v1.0.17
- 关联模块: nodeScheduler.ts(已改) / stopAndRemoveV3Container(待改) / nodeagent server.go(待改)
- 关联文档: docs/backup-restore-runbook.md (PG 备份,与 R7 互不替代)
