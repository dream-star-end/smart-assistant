# V3 CC External Endpoint — Phase 5 Platform Envelope Plan (2026-05-21)

## 0. 背景:Phase 4 mental model 的纠偏

Phase 4 (`feat/envv2-phase4-routing`,未合 `origin/v3`)假设外接客户端是裸 `curl -A
claude-cli/x.y.z` + 空 body 的 BYOK 用户,所以提出"server 派生 L0 强锁 + L1 4 个机器画像
字段(os_arch / cpu_count / node_version / hostname_prefix)"。

实测调研(2026-05-21)发现:

1. **外接客户端绝大多数就是 CCB 自己**(用户本机 cc binary 配 `ANTHROPIC_BASE_URL`
   指向 master)。CCB 在出站时已经构造规范的 `system[0]/[1]/[2]` 和
   `messages[0] <system-reminder>`,L1/L2/L3 字段都自带。

2. **真正的画像不一致来源**是客户端机器 fs walk 出来的 **PII**:
   - `~/.claude/CLAUDE.md`(用户私人指令,boss 全局 instructions 这种)
   - 项目级 CLAUDE.md(cwd 走 walk)
   - AutoMem `~/.claude/projects/<id>/memory/MEMORY.md`
   - `metadata.user_id.device_id`(CCB 用 `getOrCreateUserID` 写在 `~/.claude.json`)

   这些都跨机器**一定不一致**。Phase 4 的 L1 派生 4 字段反而是**画蛇添足** —
   容器路径根本不发这些字段,外接派生反倒是新的画像偏差。

3. **容器路径 outbound 真实形态**(调研 archival id `arc-mpewiqtu-7843wg`):
   - `system[0]` = `x-anthropic-billing-header: cc_version=<ver>.<fp3>; cc_entrypoint=...;`
   - `system[1]` = CC sysprompt prefix(3 variants 之一)
   - `system[2]` = `[CCB getSystemPrompt static+dynamic, OpenClaude extra-prompt.md (12KB,
     9 slot), gitStatus 字符串].join("\n\n")`
   - **`messages[0]`** = `<system-reminder>` 包裹 `claudeMd + currentDate`(role=user,
     isMeta=true)— 注意是 user message,不是 system!
   - `metadata.user_id` = `{device_id→pinned, account_uuid, session_id, [EXTRA_METADATA]}`
     (3 必有 key + 客户端 extras)

4. **Phase 4 v2 normalize 注入的 `<external-api-account fingerprint="..." />` block 在
   容器路径根本不存在** — Anthropic 端只要按"有/无该 block"做 attribution 形态聚类就能
   切分。这是 Phase 4 设计错位的根本表现。

**结论**:Phase 4 整支废弃。Phase 5 重新从 `origin/v3` 起,做正确的 envelope rewrite。

## 1. 目标 invariant

沿用 `feedback_one_account_one_human.md`:

> **同一 ApiKey 装到 3 台不同机器、3 个不同项目里跑,Anthropic 端看到的画像还像一个真人。**

精细化为两条硬指标:

| 编号 | 标准 |
|---|---|
| H1 | 同一 ApiKey 从 3 个不同 client 配置(hostname / OS / fs / project)发等价请求,outbound 满足: `system[0]/[1]/[N+1]` **byte-level 一致**;`metadata.user_id` **key set 一致**(仅 3 keys),其中 `account_uuid` byte-level 稳定一致、`device_id` 由 auth 阶段覆盖为 pinned_user_id、`session_id` server-generated 且不携带客户端值 |
| H2 | 同一 OpenClaude 用户从容器内 + 外接产出的 outbound,`system[0]/[1]` byte-level 一致,`metadata.user_id` keys 集合一致,`messages[0]` 不暴露客户端机器 PII |

> 不追求 `system[2..N]` 字面完全一致(client-side dynamic sections 必然漂移,见 §3.3)。

## 2. 当前代码基线(`origin/v3` = `bd2a994f`)

- `packages/commercial/src/http/proxy/externalEnvelope.ts` v1:仅在 outbound `body.system`
  里找若有 `CC_DEFAULT_PREFIX | CC_AGENT_SDK_PRESET | CC_AGENT_SDK`(三个 variants 之一)
  即 skip,否则在数组开头注入 `CC_DEFAULT_PREFIX`。无 attribution、无 metadata 处理、无
  slot lock、无 PII strip。
- `packages/commercial/src/http/proxy/index.ts:325-327`:`isExternalApiKeyOAuthPath` 双重
  命中调用 v1 normalize(`identity.containerId === null && route.kind === "oauth"`)。
- `packages/commercial/src/http/proxy/shared.ts`:`buildSafeUpstreamHeaders` 5-key allowlist
  + `rewriteMetadataDeviceId`(`device_id` → `pinned_user_id`)— 这两个**容器/外接共用**,
  不需要动。
- DB schema:**无** `fingerprint_salt` / `envelope_version` 字段(Phase 4 加的)。
- DB schema:**无** `external_api_keys.openclaude_user_id` FK(Phase 5 决策点见 §3.5)。

## 3. 设计

### 3.1 五步 envelope rewrite

`anthropicProxy` handler 在 `isExternalApiKeyOAuthPath === true` 分支,调
`buildPlatformEnvelope(body, platformContext, { userId, serverSecret }, identity)`
替换原 `normalizeExternalApiKeyEnvelope`。**注意签名不含 `account`** — 调用时机
在 `pickUpstream` 之前,OAuth account 尚未选定;派生只依赖 userId + server_secret。
处理顺序:

**关键时机约束**:`buildPlatformEnvelope` 必须在 `pickUpstream` **之前**执行 — 此时
还没选出 OAuth account,因此 fp3 / account_uuid **不能依赖 `account.id`**,改走
HMAC 派生(详见下方派生规则)。

```
[1] system[0] 强制重写
    内容: x-anthropic-billing-header: cc_version=<MACRO.VERSION>.<fp3>; cc_entrypoint=sdk; cch=00000;
    fp3 = HMAC-SHA256(server_secret, "fp3" || userId).slice(0, 3)  // 3 hex,稳定派生,不依赖 OAuth account
    no cache_control
    → 客户端发什么 system[0] 一律覆盖

[2] system[1] 强制重写
    内容: getCLISyspromptPrefix({variant: "default"})  // 选 default variant,跟容器路径默认一致
    cache_control: ephemeral
    → 客户端发什么 system[1] 一律覆盖

[3] system[2..N] 处理
    a) PII strip(必做): 扫描 system[2..N] text content,strip 以下形态:
       - hostname / fqdn(client 机器名)
       - 绝对路径 `/Users/<name>/` `/home/<name>/` `C:\Users\<name>\`
       - device-id 形态(getOrCreateUserID 出来的 hex 字符串)
       - claudeMd 拼接片段(检测 "# User Instructions" / "# Project Context" 等已知 marker)
       → 命中即整 block 替换为占位 "[redacted-by-platform]" 或直接删除该 block
       理由: H2 承诺"messages[0] 不暴露客户端机器 PII",但 PII 同样可能漂到 system[2..N]
            (CCB sysprompt dynamic section 拼了 hostname / cwd),不 strip 就是 H2 漏洞
    b) 漂移容忍: PII strip 后剩余的 dynamic section(feature flag / growthbook / mcp /
       tool descriptions)允许漂移,Anthropic 端看作"项目级上下文差异"
    c) 追加 system[N+1]: server 注入 OpenClaude 用户级 attribution block
       内容 = USER.md + MEMORY.md core + SKILLS list(name+description, 不展开 body)
       cache_control: ephemeral

[4] messages[0] <system-reminder> 处理(仅首条消息)
    检测条件(全部满足才命中):
       - messages 数组非空且 messages[0].role === "user"
       - messages[0].isMeta !== false(undefined 也算命中,CCB 老版本可能不设此字段)
       - messages[0].content 支持两种形态:
         * 字符串:starts with "<system-reminder>" && contains "# claudeMd"
         * 数组:第一个 block.type === "text" && text 满足上述字符串规则
       - 仅检测 messages[0],不扫后续 user message(子 turn 用户消息不动)
    动作: 整块替换为 server 版 <system-reminder>,内容 = server 端拼装的等价文本:
          # claudeMd
          <OpenClaude 用户级 CLAUDE.md 等价(USER.md 节选)>
          # currentDate
          <today ISO date>
    fail-safe: 不命中即 skip,不破坏非 CCB SDK 调用

[5] metadata.user_id 强制重写(string-typed JSON value,proxyBodySchema 已校验)
    收紧到 3 必有 key,默认不透传任何 EXTRA_METADATA:
    {
      device_id: <client value>,         // 后续 applyUpstreamAuth + rewriteMetadataDeviceId 覆盖为 pinned_user_id
      account_uuid: <HMAC-SHA256(server_secret, "account_uuid" || userId) → UUID v4 形态>,
      session_id: <server gen uuid (crypto.randomUUID)>,  // 不透传客户端 session_id,防机器画像泄漏
    }
    所有客户端 EXTRA_METADATA 字段(尤其 L1 派生那 4 个 os_arch/cpu_count/...)全部 strip
    顶层 metadata.session_id(如果客户端写在 metadata 而不是 metadata.user_id)也一并 strip

注: device_id 字段在此阶段为占位,真正值由 applyUpstreamAuth 阶段从 oauth_account
    表的 pinned_user_id 字段覆盖。Step 5 在 rewrite 阶段仍写客户端值是为了让 proxyBodySchema
    校验过,不代表对外可见。
```

### 3.2 派生密钥用途 — 离开 fingerprint_salt + account.id 模型

Phase 4 用 `fingerprint_salt + account.id` 派生 L1 4 字段 + `<external-api-account>` 12 hex
fingerprint。Phase 5 **彻底改型**:

- 派生不再依赖 `account.id` — envelope rewrite 时机在 `pickUpstream` **之前**,
  此时还没选出 OAuth account。
- 派生改用 **server_secret(HMAC key)+ userId**(`ApiKeyRow.userId`,稳定 1:1 映射用户)。
- Phase 4 引的 `fingerprint_salt` DB column 在 `origin/v3` 上**根本不存在**(那个 migration
  没合),Phase 5 不需要它。
- `server_secret` 复用现成的 `OPENCLAUDE_HMAC_SECRET` env(若没有,部署阶段加,32 字节随机)。

派生规则(严格定义):

```ts
// fp3:HMAC-SHA256 输出转 hex 字符串后取前 3 字符(3 hex char,12 bit 熵)
const fp3 = createHmac("sha256", server_secret)
              .update("fp3:" + userId.toString())
              .digest("hex")
              .slice(0, 3);

// account_uuid:HMAC-SHA256 输出取前 16 byte,按 UUID v4 设置 version + variant bit,再 format
const raw = createHmac("sha256", server_secret)
              .update("account_uuid:" + userId.toString())
              .digest()
              .subarray(0, 16);
raw[6] = (raw[6] & 0x0f) | 0x40;  // version = 4
raw[8] = (raw[8] & 0x3f) | 0x80;  // variant = RFC 4122
const account_uuid = formatAsUuid(raw);  // xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
```

3 hex fingerprint 空间(4096)够区分账号(容器路径同样用 3 hex,已实战验证)。绑死 userId 后:

- 同一用户跨 ApiKey 派生值仍**一致**(用户视角:身份是用户不是 key,符合"3 台机器同账号"语义)
- 派生与 OAuth account 选择**完全解耦** — pickUpstream 怎么选/失败/换号都不影响 envelope 形态
- HMAC 密钥服务端独占,客户端无法预测 → 不能被外部利用做账号枚举

### 3.3 不做字节级 100% 对齐,但 PII 是硬边界

`system[2]` 容器路径 = CCB getSystemPrompt static+dynamic + OpenClaude 12KB extra-prompt.md
+ gitStatus 字符串。其中 dynamic sections 依赖 client-side 状态(feature flag /
growthbook gate / mcp instructions / tool set)— **master 拿不全**,真要复刻就要在
master 跑一遍 CCB(组合爆炸 + Bun runtime 依赖)。

外接路径**允许 dynamic section 漂移**,但**强制 strip PII**(见 §3.1 Step 3a)。
边界:

| 类别 | 处理 |
|---|---|
| toolset 差异 / mcp instructions / feature flag 注入文字 | 允许漂移(项目级差异,合理画像) |
| hostname / fqdn / 绝对路径含用户名 / device-id / 用户 claudeMd 片段 | **强制 strip**(H2 PII 边界) |

不变量:

- `system[0]/[1]` 字节一致 → Anthropic 端 attribution 一致
- `system[2..N]` PII 已 strip,允许 dynamic 漂移
- `system[N+1]` server 注入 → 多机一致(OpenClaude 用户级画像稳定)
- `messages[0] <system-reminder>` server 注入 → 多机一致 + PII 不泄
- `metadata.user_id` keys → 与容器路径同形态(3 必有 key)

Anthropic 端看到的画像 = "这个账号在不同项目里用不同 toolset、有稳定 OpenClaude
用户级 attribution"。**合理画像,不是字节级伪装但满足真人语义**。

### 3.4 `cch=00000` attestation 占位

容器路径 CCB 用 Bun 跑,Bun HTTP stack 在字节序列化后原位 rewrite `cch=00000` 为
attestation token。master 是 Node.js,做不到 inline byte rewrite。

但 `cch=00000` 占位符语义本来就是"无 attestation"(`constants/system.ts:64-71`),
master 用 `cch=00000` 占位**不算 break**(Anthropic 端无法区分"占位符 vs 失败 attestation",
两者都是允许的)。**不阻塞**。

### 3.5 ApiKey ↔ OpenClaude 用户身份绑定

✅ **已确认**:`packages/commercial/src/auth/apiKeyRepo.ts:54` `ApiKeyRow.userId: bigint`
就是 v3 商用版用户 ID,= OpenClaude 用户 ID(1:1 映射)。**无需 migration**,直接用。

### 3.6 平台 Context 数据源 — **VolumeContextReader 混合方案 (B')**

v3 商用版每个用户的 USER/MEMORY/SKILLS 实际存在 docker named volume
`oc-v3-data-u<uid>` 里(容器内 `/home/agent/.openclaude/` = volume `_data` 根 =
`OPENCLAUDE_HOME`)。**权威路径定义**在 `packages/storage/src/paths.ts`:

```
<OPENCLAUDE_HOME>/agents/main/USER.md            ← paths.agentUserMd("main")
<OPENCLAUDE_HOME>/agents/main/MEMORY.md          ← paths.agentMemoryMd("main")
<OPENCLAUDE_HOME>/agents/main/skills/<name>/SKILL.md  ← paths.agentSkillMd("main", name)
```

注:agentId 默认为 `"main"`(单 agent 版本约束)。VolumeContextReader 实现读这三类
文件即可,**不要去找 `_data/openclaude/USER.md` 这种不存在的路径**。

读路径分两种场景:

- **master 自托管路径**(用户容器跑在 master 本机):master 进程能直接 read
  `/var/lib/docker/volumes/oc-v3-data-u<uid>/_data/agents/main/USER.md` 等文件
  (前提是 master 进程对 `/var/lib/docker/volumes/` 有读权限,实测 root 可读)
- **远程 host 路径**(用户容器跑在 boheyun-1 等远程 host):master 无法直接读,必须
  走 node-agent 的 mTLS RPC

#### 方案 B' — 抽 VolumeContextReader 接口 + 双实现

```ts
interface VolumeContextReader {
  read(userId: bigint): Promise<{ userMd: string; memoryMd: string; skillsSummary: SkillSummary[] }>;
}

// 本地实现:fs.readFile(`/var/lib/docker/volumes/oc-v3-data-u${userId}/_data/agents/main/USER.md` 等)
//          路径以 packages/storage/src/paths.ts 为权威源
makeLocalVolumeReader(): VolumeContextReader

// 远程实现:GET https://<host>:9443/v1/users/<uid>/openclaude-context (mTLS)
makeRemoteVolumeReader(client: NodeAgentClient): VolumeContextReader

// 调度入口:依据 agent_containers.host_uuid 决定走哪边
makeRoutingVolumeReader(deps: {
  findUserDataHost(userId: bigint): Promise<{ host: ComputeHost; local: boolean }>;
  local: VolumeContextReader;
  remote: (host: ComputeHost) => VolumeContextReader;
}): VolumeContextReader
```

`findUserDataHost` 复用现有逻辑(`packages/commercial/src/compute-pool/queries.ts:1460`,
按 userId 查 `agent_containers` + JOIN `compute_hosts`,返 `{hostUuid, hostStatus,
containerId, containerState}`)。`local` flag 判断:`hostUuid === MASTER_SELF_UUID`(从
master 配置读自身 host_uuid)。

#### 为什么不选纯 A / 纯 D

- **A(DB 镜像)** — 双源一致性挑战大,storage 写路径要插钩子,migration 三张表。
  **长期方案**,留作 Phase 5.2(写联邦完善后再做)
- **D(转发到容器内 gateway)** — wake-up 几十秒延迟 + 容器异常即外接挂,
  **不可接受**(外接 API 用户体感差)
- **C(fs 镜像)** — fs 双源比 DB 双源更难管,**不考虑**

#### node-agent 新 endpoint(权威 response shape)

`GET /v1/users/<uid>/openclaude-context`(mTLS,master client cert)

实现路径:`packages/commercial/node-agent/internal/server/server.go`(node-agent
路由集中挂在 `server.go`,不另立 handler 包)。

response shape(本节为本 plan 唯一权威定义):

```jsonc
{
  "userMd": "string",            // agents/main/USER.md 内容,缺失时 ""
  "memoryMd": "string",          // agents/main/MEMORY.md 内容,缺失时 ""
  "skills": [                    // agents/main/skills/*/SKILL.md frontmatter 抽取
    { "name": "string", "description": "string" }
  ],
  "volumeMtime": "RFC3339"       // 三类文件 max(mtime),用作缓存失效信号;volume 不存在时 null
}
```

实现:node-agent 用 docker volume inspect 拿 mountpoint,然后 `fs.readFile`
+ `fs.stat`。skills 只 parse frontmatter(name + description),不读 body。

错误码:404(volume 不存在 = 用户未首次使用过容器,正常)/ 5xx(读盘失败)。

master 端 LRU 缓存层在 VolumeContextReader **之上**(loader 层,见 §3.7),
两种实现都共享缓存。本地 reader 自己 `fs.stat` 三类文件取 max(mtime),
跟 remote `volumeMtime` 字段同语义。

> **决策点**:本 plan **直接选定 B'**(不留待 Codex 二审决定),理由如上。

### 3.7 缓存策略

`platformContextLoader` 在 VolumeContextReader 之上加缓存层:

- **LRU**:max 1000 entries,key = `userId`,value = `{userMd, memoryMd, skills, mtime}`
- **TTL**:60s soft TTL(过期后下次访问刷新,不阻塞)
- **mtime invalidation**:VolumeContextReader 实现端返回最新 mtime,master 端比对缓存
  mtime;不一致即失效。本地 reader 走 `fs.stat`,远程 reader 走 node-agent endpoint
  在 response 里带 `volumeMtime` 字段
- **主动 invalidate hook**:future Phase 5.2 storage 联邦完善后,memory write 可走
  LISTEN/NOTIFY 推送清缓存(本 plan 不实现,先靠 mtime)
- **冷启动**:LRU 未命中时 RPC RTT 约几十 ms — 外接 API 第一次调可接受,后续命中零成本

**Negative cache**:userId volume 不存在(404)也缓存 30s,避免空用户被反复打读盘。

## 4. 实施 step 拆分

| Step | 内容 | 产出 |
|---|---|---|
| 1 | 调研已完成(archival `arc-mpewiqtu-7843wg`) | — |
| 2a | Plan 初稿 + Codex 一评 | 此 .md v1 |
| 2b | 按 Codex 反馈修订 plan(6 处架构修正:HMAC 派生 / B' / metadata 收紧 / PII strip 边界 / Step 4 检测 / R7-R15) | 此 .md v2 |
| 2c | Codex 二评 plan PASS | Codex verdict ≥ PASS |
| 3 | 抽 VolumeContextReader 公共库(local fs + remote node-agent RPC + routing 调度) | `packages/commercial/src/platform/volumeContextReader.ts` |
| 3' | node-agent 新 endpoint `GET /v1/users/<uid>/openclaude-context`(mTLS) | `packages/commercial/node-agent/internal/server/server.go` 新增 handler + 路由注册 |
| 4 | `platformContextLoader.ts`(LRU + TTL + mtime invalidate + negative cache) | 含 unit test |
| 5 | `platformEnvelopeBuilder.ts`(五步 rewrite + HMAC 派生 fp3/account_uuid + PII strip) | 含 unit test |
| 6 | `anthropicProxy/index.ts` 改造:外接分支调新 builder,删 v1 normalize 调用 | + integ test 改写 |
| 7 | golden 测试:H1(多机一致)+ H2(容器/外接 metadata keys 同形态)+ PII strip 覆盖三类 + RPC failure fallback | 新增 fixture |
| 8 | 删 `externalEnvelope.ts` v1 + Phase 4 残留(`externalEnvelopeV2.ts` 不存在于 v3,无需删) | 净 delete |
| 9 | Codex 二审 code + sg dev 真实流量验收 + `deploy-v3.sh` 上线 | merged to v3 |

## 5. 测试策略

### 5.1 单元测试

- `platformEnvelopeBuilder.unit.test.ts`:
  - system[0]/[1] 强制覆盖客户端值
  - system[2..N] PII strip 三类(hostname / 绝对路径含用户名 / device-id hex / claudeMd marker)
  - system[N+1] 平台 attribution block 注入位置 + cache_control
  - messages[0] `<system-reminder>` 检测命中:string 形态 + text-block 数组形态 + isMeta 检查
  - messages[0] `<system-reminder>` 不命中:role !== user / isMeta === false / 仅 messages[0..] 不扫后续
  - metadata.user_id 收紧到 3 必有 key,**所有 EXTRA_METADATA + L1 4 字段全 strip**
  - 顶层 metadata.session_id 也被 strip
  - 异常路径:client 不发 system / 不发 messages / 不发 metadata
  - HMAC 派生:fp3 = hex digest slice(0,3);account_uuid = UUID v4 形态(version/variant bit 正确)
  - 同 userId 不同 ApiKey 派生 fp3 / account_uuid 一致
- `platformContextLoader.unit.test.ts`:
  - LRU 容量边界
  - TTL 过期
  - invalidate 命令清缓存

### 5.2 集成测试

`packages/commercial/src/__tests__/anthropicProxy.integ.test.ts` 新增 Phase 5 section:

- **H1 测试** — 多机一致性:同 ApiKey 用 3 个不同客户端配置(系列 3 个 fixture body)发请求,
  断言:
  - `system[0]` / `system[1]` / `system[N+1]` byte-level 完全一致
  - `metadata.user_id` **key set 一致**(仅 3 keys:device_id/account_uuid/session_id)
  - `account_uuid` byte-level 跨 3 fixture 完全一致(稳定派生)
  - `session_id` 3 fixture 各不相同且不等于客户端传入值(server-generated)
  - `device_id` 由 auth 阶段覆盖为 pinned_user_id(integ test 走完整 handler 链)
- **H2 测试** — 容器/外接 metadata 同形态:断言外接 outbound `metadata.user_id` keys
  与容器路径 outbound 同形态(都只有 device_id/account_uuid/session_id 三必有 key)。
- **PII strip**:client `messages[0]` 含敏感 claudeMd(hostname、私人 instructions),
  断言 outbound 不含原文。
- **Edge cases**:client 发 system=[] / messages=[] / metadata={} / messages[0] 不是
  `<system-reminder>` / 重复发了 OpenClaude attribution block 等。

### 5.3 删除 Phase 0 baseline drift detection 测试中已不适用的部分

`bd2a994f` 加的 `Phase 0 baseline — envv2 drift detection` 测试是为 envv2 schema(Phase 1
起的迁移工程)写的,Phase 5 不走 envv2 路线,这些测试需要重审。

## 6. 跟 Phase 4 分支的关系

| 维度 | 处置 |
|---|---|
| `feat/envv2-phase4-routing` 分支(local + 远端) | **Abandon**(开 issue 标记 deprecated,留 git 历史) |
| Phase 4 commits b3eb00fd / ca2622d9 / 35cdd118 / 1ddb3dbc / 6fb882ce | 不 cherry-pick,Phase 5 from scratch on `origin/v3` |
| `fingerprint_salt` DB column(Phase 1 加) | **不在 `origin/v3`**(没合),Phase 5 需自己加 migration |
| `envelope_version` DB column(Phase 4 加) | 同上,Phase 5 **不加**(无需 phase 切换 flag) |
| `prefix_templates` DB table + LISTEN/NOTIFY cache | **不需要** — Phase 5 用 server-side 硬编码 prefix(`getCLISyspromptPrefix({variant: 'default'})`)即可 |
| Phase 4 `pickUpstream` 两阶段拆分 | **不需要复用** — Phase 5 envelope rewrite 在 pickUpstream 前(在 preCheck 前,§3.1 Step 1-5 都是 body mutate),pickUpstream 内部不动 |

## 7. 风险与权衡

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | §3.6 master 读不到 per-user OpenClaude context | **已定方案 B'(VolumeContextReader 混合 local fs + remote node-agent RPC)** |
| R2 | 客户端不是 CCB(自己写的 SDK / OpenAI-style 调用)→ `messages[0]` 没 `<system-reminder>` 形态 | §3.1 Step 4 检测条件 fail-safe(不命中即跳过),不破坏 SDK 调用 |
| R3 | 平台 attribution block 体积大(memory 长 + skills 多)→ outbound body 暴涨 → token 估算 / 延迟 / cost | 只注入 USER.md + MEMORY.md core + skills name+description,**不展开 skill body / archival 全文**;LRU 后零成本;builder 内置 32 KB 上限硬拦截 |
| R4 | 客户端同时发了一个伪造的 OpenClaude attribution block(spoof) | §3.1 Step 3 先 strip "OpenClaude 用户级 attribution" 形态匹配的旧块再注入,防 spoof |
| R5 | sg dev 验收时无真实多机环境,只能 mock | 多 fixture body 模拟不同机器画像,UA + hostname + cwd + fs walk 结果都变,断言 outbound 一致 |
| R6 | `<system-reminder>` 字面格式跨 CCB 版本可能漂移 | 检测条件用宽松正则(starts with `<system-reminder>` + contains `# claudeMd`),覆盖主流 variant;Step 4 仅作用于 messages[0] |
| R7 | rewrite 在 pickUpstream 之前,如果后续 pickUpstream 选了不同的 account 池,会不会跟 fp3/account_uuid 错位 | 派生只依赖 userId + server_secret,**完全独立于 OAuth account 选择**;account 切换不影响 envelope 形态 |
| R8 | OPENCLAUDE_HMAC_SECRET env 缺失导致派生 fallback 到弱熵 | startup 阶段强校验(envelope_secret missing 即 process.exit(1)),禁止静默 fallback |
| R9 | system[2..N] PII strip 误伤合法内容(项目级 doc 字面含 "/home/" 等 marker) | 用保守规则:仅匹配 hostname-shape + Users-prefix + Mem-marker 三类;命中即整 block redact,不做局部 regex replace(避免破坏语义);**hostname/fqdn 规则只匹配 OS hostname 形态(短主机名 + 已知 client UA 自报字段),不做通用域名/FQDN 全局匹配**,避免误伤 MCP URL / 项目文档 / 工具描述里的 hostname |
| R10 | node-agent RPC 跨主机超时(host 不通 / 网络抖动) | RPC 设 2s 超时;失败 fallback 到"空平台 context"(仅注入空 USER.md placeholder),保持 H1 多机一致不破;打 metric 告警 |
| R11 | LRU + mtime 间空窗:用户刚 update USER.md,下次外接还命中老缓存 60s | TTL 缩到 60s soft TTL(下次访问后台异步刷新),用户感知最长 1 min;若需要立即生效走 Phase 5.2 LISTEN/NOTIFY |
| R12 | 顶层 metadata.session_id 不在 user_id 里而在 metadata 顶层时被遗漏 | Step 5 显式 strip 顶层 `metadata.session_id` 字段,只保留 `metadata.user_id` 子对象 |
| R13 | applyUpstreamAuth 已经在做 device_id 重写,Step 5 写客户端 device_id 占位会被 schema 拒绝 | Step 5 写"合法占位"(64 hex,跟 schema 兼容);applyUpstreamAuth 阶段照常覆盖为 pinned_user_id;两阶段语义清晰 |
| R14 | 客户端 system 数组里 PII strip 后剩 0 个 block,但 anthropic API 要求 system 至少 1 block | system 始终保有 [0] 和 [1] 强制重写块,strip 只作用 [2..N];最坏情况 [N+1] 注入也 100% 在场,system 数组不会空 |
| R15 | server 生成的 `messages[0] <system-reminder>` 内容跟容器路径文字不完全一致,被 Anthropic 端 NLP 聚类切分 | 文字模板照抄容器路径(`# claudeMd` + `# currentDate` 两段,不含其它 marker);跨用户唯一变量是 USER.md 节选 + 日期,Anthropic 看到的是合理用户差异 |

## 8. 验收硬指标(Codex 评 plan 时要逐条 enforce)

- ✅ §3.6 master 读 OpenClaude context 走 B'(VolumeContextReader 混合)— 已选定
- ✅ HMAC 派生 fp3 / account_uuid 完全独立于 OAuth account.id(rewrite 时机在 pickUpstream 前)
- ✅ H1(多机一致)golden 测试:同 userId 不同客户端 → `system[0]/[1]/[N+1]` byte-level 一致;`metadata.user_id` key set 一致(仅 3 keys);`account_uuid` byte-level 稳定;`session_id` server-generated 不携带客户端值
- ✅ H2(容器/外接 metadata keys 同形态)golden 测试:外接 metadata.user_id 仅 3 keys
- ✅ PII strip 覆盖三类:hostname / 项目 CLAUDE.md / AutoMem 文本片段
- ✅ Step 4 `<system-reminder>` 检测仅作用 messages[0]、支持 text-block 数组、isMeta 检查
- ✅ Step 5 顶层 metadata.session_id strip + 不透传 EXTRA_METADATA
- ✅ node-agent endpoint mTLS 鉴权,与现有 master/node-agent 互认证链一致
- ✅ node-agent 不通时 RPC fallback 到空平台 context,H1 多机一致仍成立
- ✅ `externalEnvelope.ts` v1 完全删除,handler 删除 v1 调用
- ✅ Phase 4 v2 normalize 代码(`externalEnvelopeV2.ts` + L1 派生 + `<external-api-account>` block)在 v3 上不存在(它本来就没合)
- ✅ Codex code review PASS
- ✅ sg dev 实际外接请求 → outbound 用 dump trace 验证 system[0/1/N+1] + metadata 形态符合预期

---

**Plan 状态**:v2.1,已应用 Codex 一评(6 处架构修正)+ 二评(7 处路径/措辞修正)反馈。

**Codex 一评要点 → v2 落地映射**:

| Codex 反馈 | v2 落地位置 |
|---|---|
| fp3/account_uuid 不能依赖 account.id(rewrite 在 pickUpstream 前) | §3.1 时机声明 + §3.2 HMAC 派生 + R7 |
| metadata 透传 EXTRA_METADATA 破坏 H1 | §3.1 Step 5 收紧 + R12 |
| device_id "client value" 措辞误导 | §3.1 Step 5 注释 + R13 |
| §3.3 缺 PII strip 边界 | §3.1 Step 3a + §3.3 表 + R9 |
| Step 4 `<system-reminder>` 检测条件太松 | §3.1 Step 4 全面 refine |
| §3.6 B 不够,应走 B' VolumeContextReader hybrid | §3.6 整章重写 + R10 RPC fallback |
