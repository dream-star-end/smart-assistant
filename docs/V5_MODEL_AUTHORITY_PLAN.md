# V5 模型权威批次:ModelExecutionCatalog + seed model 声明化

日期:2026-07-12 · 分支:feat/v5-model-authority · 状态:R5(R1×6B8M2m+R2×6B6M3m+R3×4B6M2m+R4×2M4m 全闭环)
前置裁定:hotcfg R1-B5/R2-B1。现状调研见 R1 版 §0(6 处清单/可路由与可计费分裂/
双信任源/seed 双端硬编码);目标与非目标见 R1 版 §1(provider 机制与凭据不 DB 化
的冷面边界经 R1 审定 PASS,不再复述)。

## 1. 数据模型

### 1.1 版本化 catalog(R2-B6)

- **`model_catalog`**:`entry_id`(serial PK)、`model_id`、`engine`('ccb'|'codex')、
  `provider_id`(engine='ccb' 时 NOT NULL ∈ 服务端 provider 机制集)、
  `upstream_model_id`(NULL=同 model_id)、`context_window`、`capability_profile`
  (JSONB)+ **`capability_schema_version`**(R2-m15:未知版本消费侧 fail-closed)、
  `state`('staged'|'active'|'disabled'|'retired')、`lock_version`、审计列。
  **部分唯一索引**:`model_id` 于 state∈(staged,active) 唯一 —— engine 变更 =
  旧行 disable→retired,新行同 model_id 重新 staged→校验→active,旧版本保留审计。
- **`model_aliases`**:`alias`(PK)→`entry_id`;alias 只可指向 staged/active 行;
  删除/重指/目标收窄走状态机+审计(R2-M8)。
- **`model_pricing` 收口**(R2-M7):价格/可见性列保留;**`enabled` 列退役为生成
  兼容视图**(读=对应 catalog 行 state='active'),写口移除 —— 可用性唯一权威 =
  catalog.state,proxy/授权/公共投影/seed 校验统一改判 state。
- **`model_security_epoch`**(单行表):单调递增。
- **状态机与 epoch 由 DB 强制(R2-M9)**:trigger 校验合法转移(staged→active→
  disabled→{active|retired};retired 单向终态,被 alias 引用禁退休,R2-m14)、
  active 行身份列(model_id/engine/provider_id/upstream_model_id)不可变、
  **active 行全部 execution 字段不可变(R3-B3)**:model_id/engine/provider_id/
  upstream_model_id/context_window/capability_profile/capability_schema_version
  —— 任何 execution descriptor 组成字段的变化(含放宽)都必须走版本状态机
  (disabled→新 staged→校验→active)并产生新 executionRevision;
  **security-sensitive 写(state 离开 active/visibility 收紧/grant 撤销/任何
  execution 字段·价格·alias 变更)自动 bump epoch**;应用账号仅经存储过程/受限
  权限写。**engine/execution 版本切换由单一存储过程执行(R3-M8)**:旧 active→
  disabled → 建新 staged → aliases 重指新行 → 旧→retired → 新→active,中间态
  对外恒 fail-closed,禁止多请求手工拼装。

### 1.2 快照与 revision(R2-B1/M12)

master `ModelCatalogSnapshot`(catalog+aliases+pricing 一次事务读,NOTIFY 重建):
- `executionRevision` = 规范化**当前有效执行投影**sha256(wire 全长,日志 12hex;
  R4-m5:仅 active 行的规范执行字段 ∪ 指向有效版本的 aliases ∪ capability schema
  version;**排除** entry_id/lock_version/审计列/staged·retired 历史行 —— 编辑
  未激活 staged 行不抖动全局 revision);
- `billingRevision`、`securityEpoch` 随载;
- **per-uid `projectionRevision`** = hash(该 uid 投影内容)(R2-M12:全局 revision
  不作为用户可观测字段,仅进签名 envelope);
- **epoch fence = master 与 egress 两进程共用的消费契约(R3-B1)**:生产
  `/v1/messages` 链路在独立 openclaude-v5-egress 进程(自持 PricingCache),
  fence 必须双进程各自执行:签发 authority、codex preCheck/journal、egress 的
  授权/provider 路由/settle 之前,断言 `请求携带 epoch == DB epoch == 本进程
  snapshot epoch`;任一不等 → 同步强制重建,重建失败/DB 不可达 → 拒(fail-closed;
  egress 收到 epoch 变更 NOTIFY 先把本地标 unknown,unknown 期间拒新请求,重建
  成功恢复)。**生效面显式含 deploy-v5.sh --egress**。
- **安全变更零 stale 窗口(R3-B2;粒度按 R4-m3 无歧义化)**:authority 签发、
  codex preCheck/journal,以及 **egress 对每个独立 `/v1/messages` HTTP 请求在
  授权/路由前各一次**(同一请求内 settle 复用该线性化结果 —— 长 turn 的下一次
  上游请求必然感知安全变更),epoch 读取**直接单行 SELECT,不用时间微缓存**
  (收窄与计费变更不允许已知 stale window;单行索引读的代价可接受,实现期压测
  确认,超预算再走"trigger→outbox 同步失效标 unknown"方案);仅纯展示/放宽面
  允许微缓存。admin 安全写同事务 bump epoch,提交后本进程 snapshot 同步激活成功
  才返回成功;egress 侧靠 NOTIFY→unknown→重建 fence(不必等预热,但成功前拒)。
  grants checker 刷新失败且 epoch 已漂移 → 拒(替代现状"保留旧 checker 放行")。

## 2. 判定单点化:签名 execution descriptor(R2-B2/B3/B4)

- **非对称信任根**:master 持 Ed25519 私钥(随 bridge secret 域生成持久化),
  supervisor 向容器注入**公钥 keyring**(env,公开无妨;同 uid 进程可读 environ
  也无法伪造签名)。envelope 带 `keyId`(R3-M7);**轮换五步**:①下发新公钥(旧钥
  保留)②全容器 attest 新 keyId ③master 切新私钥 ④等旧签名 TTL 耗尽 ⑤删旧公钥。
- bridge 对每个 forward 的 inbound.message 注入 `__oc_model_authority`,内容为
  **版本化规范编码(JCS)**的完整签名载荷(R2-B3 字段全集):
  `{ v, uid, containerId, authorityTurnId(每 inbound 铸造,不复用计费 requestId
  的可选语义;codex 的 billing requestId 作绑定字段), canonicalModel, engine,
  executionDescriptor(该模型完整规范化执行语义:capability_profile/context_window/
  effort/vision/upstream 无关字段除外), executionRevision, securityEpoch,
  issuedAt, expiresAt(短,仅约束"开始执行",gateway 首次单次消费),
  connectionChallenge(R4-m4:gateway 产生 challenge→hello attest→bridge 签入→
  gateway 验证与当前连接一致), billingRequestId? }` + Ed25519 签名。
  **turn lease(R4-M1)**:envelope 同时携带独立签名的 turn lease(期限=平台最大
  turn 窗口+grace,如 hard timeout 45min+5min),turn 内后续上游请求凭 lease ——
  长 turn(团队/delegate/compact/工具密集)不被 5min 过期误伤;**安全撤销不靠
  lease 过期,由每请求 epoch fence 保证**(lease 长≠放过 disable/revoke)。
  测试覆盖 >5min 多上游请求与跨 compact。
- **容器消费(R2-B4 推荐项)**:该 turn 的 engine/capability/context/effort/vision
  **全部取自 descriptor**(自包含,不查本地 catalog → master/容器对该 turn 物理
  同快照,revision 漂移问题消解);验签失败/过期/epoch 低于已见最大值/
  authorityTurnId 重放 → 拒帧(**replay cache 语义,R3-M10**:活跃 TTL 内条目
  绝不静默淘汰,容量满 → 拒新 authority+告警;签名另绑连接 challenge,连接关闭/
  gateway 重启后旧 envelope 天然失效,测试覆盖 cache 满与重启重放);**一切入口先无条件 strip**
  同名字段(bridge 先 strip 再注入;HTTP inbound/cron/delegate/本地 WS 只 strip);
  descriptor.canonicalModel 与 frame.model(alias 归一后)不一致 → 拒。
- CCB spawn 的 capability override 从 descriptor 注入(本地 staticKeyModels 表
  仅剩无 descriptor 的本地路径回落,且 revision 不匹配不放行)。

## 3. 容器本地路径(cron/synthetic/delegate,无 envelope)

- 判定源 = 容器 catalog 快照(`GET /internal/v3/model-catalog`,单飞+TTL 30s+
  LKG 落盘);**LKG 使用前提 = epoch 验证通过**(窄 `GET /internal/v3/
  model-catalog-epoch`,R2-m13 不用 HEAD body;或复用拉取响应头
  `X-OpenClaude-Security-Epoch`);epoch 漂移 → 强拉,拉不到 → 本地路径拒新 turn;
  冷启无 LKG 且 master 不可达 → 拒(**无 baked 回落**,R1-B1)。
- 真值表(R1-M9 审定):cron/synthetic 的 codex 意图 → 既有降级为非 codex;CCB
  delegate → anthropic proxy 逐请求计费(见 §4 绑定);**codex delegate/provider
  pin 本地 turn → 创建 runner 前结构化错误 `DELEGATE_CODEX_UNSUPPORTED`**(现状
  为 billing guard 晚期拒,本批产品化提前;master 铸子 requestId 登记债)。

## 4. CCB proxy 请求绑定(R2-M10 + R3-M5/M6)

- **bridge turn**:gateway 对 turn 内每个上游 `/v1/messages` 请求附带**完整签名
  envelope(或其紧凑签名 token 形态)**,非裸 header(同 uid 进程可伪造裸 header,
  R3-M5);egress 验签 + containerId/uid + canonical body.model==descriptor.model
  + epoch fence + turnId;
- **本地路径 turn**:附带**独立标识的 container-catalog token**(`kind:
  local_catalog`,携 projectionRevision+epoch,R3-M6 —— 不伪装 bridge authority,
  不使用不下发的 global executionRevision);egress 对 local kind 仅做 epoch
  fence+既有授权/enabled 校验(现状语义,收口显式化);
- epoch 不等 = 安全/计费变更发生 → 拒后续请求(fail-closed);价格类变更导致的
  在途 turn 拒绝返回专用码 **`MODEL_CONFIG_CHANGED_RETRY_TURN`**(R3-m12,前端
  引导重开 turn;监控区分安全撤销 vs 价格版本);
- **计费按请求级当前价格快照结算**(现状语义显式化);usage_records 增记
  `execution_revision`/`projection_revision`/`security_epoch`(不适用置 NULL)+
  `authority_kind`('bridge_signed'|'local_catalog')(R3-m11)。

## 5. seed 声明化两阶段(R2-B3′/M11)

**阶段 A**:platform-seed schema v2(解禁 model/engine/provider/runnerKind,值
校验),**值与现状硬编码完全相同**;entrypoint 读声明(本地 billing 常量删,
一致性测试锚:声明 == master 常量);部署后等待核验:**全部 managed 容器(含
stopped 可复用态,R2-M11)** 带有效 bundle_rev label —— 不满足的由 runtimeStale/
手动 recycle 清零。
**阶段 B**:master 按容器实际 rev 推导:
- resolver 移到 `ensureRunning` 返回 labels 之后,显式接收 `bundleRev`;
- **完整性(R2-M11)**:直接复用 hotcfg 的 `resolvePlatformBundleMount`(全量
  digest==目录名校验)验证该 rev bundle,通过后读 seed(不另造弱校验);LRU 缓存
  验证结果(rev 不可变),失败不负缓存+critical;
- label 缺失/bundle 缺 → **fail-closed 拒帧**(阶段 A 已保证不存在;出现=异常);
- seed 模型 ∈ catalog active:deploy prepare master 侧脚本断言。
滚动窗口新旧容器各按自己 rev 计费,无分叉。

## 6. per-uid 下发与投影

- `/internal/v3/model-catalog`(container token→uid):行集 = active&&(public∨
  granted);响应含 `{projectionRevision, securityEpoch}`(global executionRevision
  不下发,R2-M12);seed 全局校验=行存在且 active(deploy 门+启动断言),per-uid
  **仍严格过滤不强塞不 500**(未授权 seed agent 由 bridge authority 拒执行);
- 错误统一 `MODEL_NOT_AVAILABLE`;端点不进 browser→container 代理 allowlist
  (双侧+测试);
- `/api/public/models` 服务端投影:provider_id/degraded(按 provider_id 查健康)/
  supported_efforts;staged/retired 恒不出现。

## 7. 上线:per-connection attestation(R2-B5 修订)

| 步 | 动作 | 行为变化 | 回滚 |
|---|---|---|---|
| 1 | 迁移(建表+回填=protocol 常量,一致性锚;epoch 表;pricing.enabled→**可更新兼容视图+INSTEAD OF trigger 把旧 enabled 写映射到 catalog 状态机**,R3-M9,覆盖旧 master 回滚后的写路径;稳态后移除写 trigger 登记债) | 零 | master 回滚(读写均经视图兼容) |
| 2 | master 双读影子(快照判定 vs legacy 判定对比告警;判定仍 legacy)+epoch fence 基建;**egress 同批部署 shadow 双读/fence 基建(--egress,R4-M2)** | 零(影子) | 同上(egress 同批回滚) |
| 3 | release 滚动:容器验签消费+catalog client+**hello attestation `model_authority_v1`** | 容器仍 baked 判定(无 envelope) | release 回滚 |
| 4 | **flag `OC_MODEL_AUTHORITY=1`**:bridge 对**每条连接**要求 attestation —— 未 attest 前缓冲用户帧(有界+超时),旧容器连接 → 拒+触发 stale recycle;新 provision 强制 capability release(release rev 门);envelope 注入+catalog 判定开启;**启用前同时验证 egress capability(`model_authority_v1-egress`,R4-M2)** | 判定源切换(影子已证零漂移) | 关 flag(容器无 envelope 自动回容器判定=baked,集合同值) |
| 5 | 开放 admin INSERT/状态机操作(staged 流程) | 新能力 | **不可逆兼容地板(R3-B4+R4-M2,覆盖 {DB schema, master, egress, runtime release} 四面)**:步骤 5 起禁止任一面回滚到 legacy/baked 判定;deploy/rollback 守卫拒激活无 model_authority_v1(-egress) capability 的旧 tuple/旧 egress 版本;真需退 baked = 事务性恢复 catalog 至 baked 等价值+bump epoch+等全部快照与运行容器收敛后才允许关 flag |
| 6 | seed 阶段 A → 核验(含 stopped)→ 阶段 B | §5 | 各自可回滚 |

步 4 的 attestation 是**连接级持续门**而非一次 census(R2-B5):stopped 旧容器
复活/检查窗口新建旧容器/早到帧三类竞态全部由"未 attest 缓冲/拒+recycle"覆盖,
测试显式覆盖这三类。

## 8. 测试与债

- 单测:状态机 trigger 矩阵(含 retired 单向/alias 引用禁退休/active 身份列不可
  变/自动 epoch bump)/epoch fence(master snapshot 陈旧拒签发/admin 写同步激活)/
  Ed25519 验签(伪造/过期/重放/epoch 回退/strip 全入口/model 不一致拒)/descriptor
  自包含(容器不查本地 catalog)/本地路径 LKG epoch 协议/per-uid projectionRevision/
  alias 全链归一/capability ⊆ provider 上限/attestation 三竞态/seed rev 复用
  bundle 校验器三态/影子对比零漂移锚;
- 计费 E2E:staged→active→turn 全链;disable 后拒且不扣+epoch bump 全链失效;
  engine 变更走 retire+新行全流程;proxy 请求级 epoch 拒;codex delegate 结构化错;
  **R4-m6 三项**:master 新/egress 旧(或 snapshot 陈旧)必拒;步骤 5 后回滚旧
  egress/旧 tuple 被部署守卫拒;keyring 轮换期新旧 keyId 并存+旧 TTL 耗尽拒旧签名;
  turn lease:>5min 长 turn 不误伤+lease 内 epoch 收窄仍拒;
- 债:①codex delegate 子 requestId(触发=产品需求);②provider 机制 DB 化(触发=
  月增多家);③CCB 本地 capability 表退役(触发=descriptor 注入稳定一发版周期)。
