# RFC: WeChat Channel Broker — v3 Commercial 微信通道根治式重构

| 字段 | 值 |
|---|---|
| 状态 | **APPROVED v4 final** — 全部 4 轮 Codex Plan Review 通过,P1 编码进行中 |
| 起草 | 2026-05-13 |
| Codex r1 | NEEDS-REWORK(4 CRITICAL + 6 IMPORTANT + 5 NIT)→ 全部已并入 v2 |
| Codex r2 | NEEDS-REWORK(1 CRITICAL + 4 IMPORTANT + §10.2 答复)→ 全部已并入 v3 |
| Codex r3 | PASS-with-notes(4 notes)→ 已并入 v3 final |
| Spike 完成 (2026-05-14) | S1 HMAC 派生 / S2 RTT 200-700ms / S3 webchat 无 bind 帧 |
| Codex r4 | **PASS-with-notes**(3 sanity guard)→ 已并入 v4 final |
| 影响范围 | v3 commercial (claudeai.chat) + `packages/channels/wechat`(跨个人版/商业版共用) |
| 当前对应 boss 阻塞问题 | claudeai.chat "微信绑定" 弹窗永远红字 "服务端暂未启用微信通道" |

## 0. TL;DR

把微信通道从容器内"扯出来",放到 HOST master 上做集中 broker。**双向 transport**:容器→master 复用现有 mTLS 18443 出站通道(`v3MasterSink` 等),master→容器走 D3b 通道(self-host 直拨 `bound_ip:18789` / remote-host 走 node-agent tunnel),**不是**双向都走 18443。同时引入(a)富媒体渲染流水线 (b) 多会话指针 + 命令系统 (c) `notify_user` 跨通道主动通知 tool (d) 内置 `wechat-notification` skill。分 4 个 phase 上线,每个 phase 独立可发布。

## 1. 问题陈述

### 1.1 当前症状(boss 反馈三项 + 一项隐患)

| # | 现象 | 根因(代码证据) |
|---|------|------|
| ① | 微信侧只能收发文字,图/视频/音频/文件/图表 全部丢 | `iLink.ts:128-151` 只有 `sendIlinkText`;`manager.ts:204-223` 富 block 全走 `sanitizeForWechat` 剥成纯文本 |
| ② | 微信侧无法选择 / 切换 / 列出 OC 会话 | `manager.ts:74-101` 只有 `/status` + `/new`;peerId = `${userId}:${senderId}` 锁死单 session |
| ③ | 容器内 agent 无内置 skill 了解微信能力 | `/root/.openclaude/agents/main/skills/` 无 wechat-* skill;`entrypoint.ts:186-216` seed-skill 列表只含 codex imagegen |
| ④ | claudeai.chat 微信绑定按钮 100% 失败 | 用户请求经 commercial router → 转发到**容器内 gateway** → 容器内 `wechat.enabled=false` (`entrypoint.ts:265-268`) → `/api/wechat/pair/start` 返 409 `WECHAT_DISABLED` (`server.ts:3328-3335`) |

### 1.2 真正的根因(架构断层)

通道层(channel)与执行单元(container)在 v3 commercial 里**不可避免地被分配到了不同进程**:

- HOST master 进程持有所有用户的状态、长连接基础设施(已有 wechat manager + workers)
- 每个付费用户 = 独立 docker 容器,容器内跑 personal-gateway

而当前 `packages/channels/wechat` 是个 **per-gateway-process** 抽象 —— 它假设 channel adapter 与 sessionManager 在同一进程内通过 `ctx.dispatch` 直接调用。这个假设在个人版成立,在商业版**直接破产**:

- 容器内 gateway 启动 wechat factory? bot_token 需要从 master DB 下放,N 个容器 N 条 long-poll,bot 心跳 / 健康监控分散,容器重启即断连 — **本质上是症状治理,把"通道层 = 进程内对象"这个错误假设强行塞进多容器架构**
- 容器内禁用 wechat、master 启用 wechat? master 的 `ctx.dispatch` 进不到容器的 SessionManager — **就是当前的状态,功能完全断**

**根治方向 = 把通道层提升为跨进程横切关注点**:HOST 持有通道,容器消费,通过明确的 RPC 边界对话。

### 1.3 非目标(本 RFC 不解决)

- 个人微信号 bot 协议本身的合规/封号风险 — 已确认 iLink 是腾讯官方 bot 入口,无风险(boss 2026-05-13 澄清)
- 替换为企业微信 / 公众号 / 微信小程序 — iLink 已是官方 bot,不需要换
- Telegram / Discord / Slack 通道 — 本 RFC 只做 wechat,但**架构抽象(notify_user / channel capabilities / 富媒体渲染流水线)对未来接 Telegram 零成本**
- 多 agent 之间的微信协作(agent A 发消息给 agent B 的微信) — 商业版每用户独立容器,不在 v3 视野
- iLink 协议反向工程 / 新 message_type 探索 — 本 RFC 仅基于已知协议 type=1 文本 + 拟定 type=2/3/4/5 富媒体(实施时再查文档/抓包,见 P2)

## 2. 目标

### 2.1 用户视角验收标准

完成本 RFC 后用户应能体验到:

1. ✅ claudeai.chat 微信绑定按钮可点击,扫码绑定成功,绑定状态显示真实健康度
2. ✅ 微信侧给 OC 发文字 → agent 回复文字,任何方向超长自动分片
3. ✅ agent 输出图表 (chart/mermaid)、HTML preview、绝对路径附件 (图/视频/音频/PDF/文件) → 微信侧能看到真实图片/音视频/文件
4. ✅ 微信侧输入 `/list` → 看到当前 OC 用户最近 N 个 session 列表(短 id + 时间 + preview);`/switch <id>` 切换;`/new [title]` 新建;`/back` 返回上一个;`/here` 查当前;`/help` 命令列表
5. ✅ agent 跑长任务结束,主动 push 微信通知用户(无需用户先发起对话)
6. ✅ 用户开启免打扰时段后,主动 push 在该时段只入会话不推送

### 2.2 系统视角验收标准

1. ✅ bot_token / context_token 不出 HOST,容器内只持有 RPC 凭证
2. ✅ 通道层与会话语义解耦:agent 输出统一为 `RichBlock[]`,通道按 `capabilities` 自动降级
3. ✅ `notify_user(message, options)` 工具语义闭合,未来接 Telegram 零改 agent 侧
4. ✅ 内置 `wechat-notification` skill 通过 seed-skills 机制注入所有用户容器
5. ✅ 频控、心跳、审计、解绑策略全部到位
6. ✅ 不引入新的运维 daemon、不引入第二套监控路径(broker 进 master 进程内)

## 3. 架构总览

### 3.1 三层结构

```
                  ┌───────────────────────────────────┐
                  │  腾讯 iLink Bot (ilinkai.weixin)  │
                  └─────────────────┬─────────────────┘
                                    │ long-poll (官方 bot 入口)
                                    ▼
        ┌───────────────────────────────────────────────┐
        │  HOST master 进程                              │
        │  ┌───────────────────────────────────────┐    │
        │  │ WeChatBroker (新增, 进 master 进程内)   │    │
        │  │  • WechatManager: 持所有 binding 的    │    │
        │  │    iLink long-poll worker (现成)       │    │
        │  │  • RichBlock → wechat 渲染流水线 (新)   │    │
        │  │  • Command 分发器 + session 指针 (新)   │    │
        │  │  • 频控/心跳/审计 (新)                  │    │
        │  └───────┬───────────────────────┬───────┘    │
        │          │ inbound 投递           │ outbound │
        │          │ (新 endpoint)          │ 接收     │
        └──────────┼───────────────────────┼───────────┘
                   │ master → container    │ container → master
                   │ HTTP POST 18789       │ HTTPS mTLS 18443
                   │ (D3b: self-host 直拨  │ (复用 v3MasterSink 现路径,
                   │  / remote-host 经     │  dispatchInternal)
                   │  node-agent tunnel)   │
                   ▼                       ▲
        ┌─────────────────────────────────────────────┐
        │  容器 (每付费用户一个)                       │
        │  ┌──────────────────────────────────────┐   │
        │  │ wechat-inbound handler (新)           │   │
        │  │   → SessionManager.dispatch(...)       │   │
        │  │                                        │   │
        │  │ v3WechatOutbound sink (新)             │   │
        │  │   ← session outbound (channel=wechat) │   │
        │  │   → POST master:18443/wechat-outbound │   │
        │  │                                        │   │
        │  │ notify_user tool (新, agent 可调用)    │   │
        │  │                                        │   │
        │  │ seed-skill: wechat-notification (新)   │   │
        │  └──────────────────────────────────────┘   │
        └─────────────────────────────────────────────┘
```

### 3.2 关键架构决策

| # | 决策 | 选择 | 拒绝的备选 | 理由 |
|---|------|------|----|------|
| D1 | 通道集中在 HOST 还是容器内 | **HOST 集中 (broker)** | 容器内各自跑 worker | 通道是横切关注点,bot_token 不出 host,健康监控统一,容器生命周期不影响长连接 |
| D2 | broker 进程位置 | **master 进程内模块** | 独立 systemd unit / k8s pod | 商业版当前无独立微服务路径,引入第二套部署/监控/重启逻辑代价>收益;未来 N×10 用户量级再考虑 |
| D3 | inbound 应用层协议 | **新 endpoint(协议语义),走容器内 gateway 18789** | 复用 user-chat-bridge 帧透传(模拟 webchat) | 关注点分离;不污染 user WS 状态机 |
| D3b | inbound 物理 transport | **broker → `resolveContainerEndpoint(uid)` → self-host 直拨 `bound_ip:18789` / remote-host 走 node-agent tunnel** | 假想 master 直连容器 18443(错误 — 18443 是容器→master 方向) | Codex r1 CRITICAL#1:复用 userChatBridge 现有 endpoint resolver,remote-host 必经 tunnel 才可达 |
| D3c | inbound 容器内会话建立 + master 元数据同步 | **直接构造 `InboundMessage` 帧调 `dispatchInbound`**(与 telegram / personal-wechat 同 contract),**额外**由 broker 在 dispatch 前调一次 `PUT /api/sessions/:id` 同步 `client_sessions` 元数据到容器 sqlite,容器内 turn 经 v3MasterSink 自动反向写 master sqlite | (旧)模拟 hello/bind 帧 | **S3 spike 颠覆性发现**:v3 中**根本不存在 webchat bind 帧**(`session_repo_bind` 是 GitHub workspace 绑定,与 session 建立无关);`inbound.hello` 只 outbound ring replay;AgentSession 由 `inbound.message` 的 `(channel,peer.id,agentId)` 在 `dispatchInbound` lazy create;`client_sessions` 行**本来就由前端 PUT /api/sessions/:id 写入**,与 ws 帧解耦。Codex r1 CRITICAL#3 关切真实(master/容器 sqlite 必须一致),但归因错位 — 真正的子问题是 **PUT 模拟**,不是 **帧模拟** |
| D3d | master→容器认证 | **复用 bridgeSecret HMAC 派生**(命名空间 `inbound:${containerId}`),与现有 file-proxy `OC_BRIDGE_NONCE` 同型 | (旧候选) (a) `agent_containers.gateway_access_token` 列;(b) supervisor 注入新 env;均需"或落 plaintext 一击穿 / 或 master 持久化 plaintext" | **S1 spike 关键发现**:master 已有 `bridgeSecret`(`/var/lib/openclaude/.v3-bridge-secret`,bridgeSecret.ts:31)作为 master→container 信任根,file proxy `OC_BRIDGE_NONCE = HMAC(bridgeSecret, row.id)` 已在生产稳定;新增 `OPENCLAUDE_INBOUND_NONCE = HMAC(bridgeSecret, "inbound:" + row.id)` 复用同模型,**零 DB migration / 零 master plaintext 存储 / 失败半径不扩**;命名空间扩展能吃掉未来一整类 master→container 通路(admin command / cron / notifications) |
| D4 | outbound 链路(容器 → broker) | **容器侧新 `v3WechatOutbound` sink, POST 到 master 18443** | 走 webchat WS 回流 | 容器内 wechat adapter 不存在,channel=wechat outbound 会被吞;主动 POST 是唯一正确路径 |
| D5 | broker sticky session | **v1 不做长链 + 冷启 UX 必备** | broker 维护 peer→container 长链 | KISS;但 Codex r1 IMPORTANT#1 指出冷启 5-8s 用户会感知 → broker 收 inbound 若 ensureRunning 触发冷启,**inboundDispatcher 返 cold_start outcome,broker 拿到 coldStartReply 后 fire-and-forget `sendText` 发"正在唤醒,稍等"短文**(不入 outbox、不留 pending state、不做后台重试 — 简化首版状态机,用户片刻后重发即可)。v2 性能瓶颈再做长链 + 自动重试 |
| D6 | peerId 模型 | **结构化 `peer.meta = { userId, senderId, sessionId }`** + 序列化 ID 用 base64url(senderId 可能含 ascii 特殊字符) | 维持 `${userId}:${senderId}` 锁死单 session / 裸 colon 拼接 | Codex r1 NIT#1:senderId 理论上可含 `:`,新 schema 需结构化 |
| D7 | 富媒体渲染层 | **`renderForWechat(blocks, capabilities)` 函数签名带 caps 参数,但模块名/位置 wechat 专属** | 现在就上提到 channel-agnostic 公共包 | Codex r1 IMPORTANT#6:caps 抽象保留(为未来留路),但**不预先承诺 Telegram 零成本**;第二个通道接入再上提 |
| D8 | `notify_user` 工具语义 + endpoint | **跨通道统一入口**,channel 是路由参数;**走独立 endpoint `/internal/v3/notify-user`**(不复用 wechat-outbound,见 §4.6);**auto 优先级**:显式 channel > 当前 session 最近输入通道 > 用户偏好默认 > 5min 内活跃通道 > web 入会话**不主动 push** | 简单"5min 内活跃,否则全 fanout" / 复用 wechat-outbound endpoint | Codex r1 IMPORTANT#5 + r2 IMPORTANT#3:fanout 制造噪音;复用会让 wechat-outbound 长出路由 if 违反 SoC |
| D9 | 富媒体协议探索路径 | **三步**:(1) 先查腾讯官方 iLink bot 文档/SDK/示例;(2) "协议能力探针"脚本对测试账号逐 type 发送 + 记 request/response;(3) 抓包补盲区 | 直接抓包 | Codex r1 D9 改进:文档→探针→抓包是标准协议测绘流程 |
| D10 | 频控策略 | **per-binding token bucket, 60/min**,超限降级"消息已记录,回 Web 查看" | 全局 token bucket / 无频控 | iLink 无明确频控文档,per-binding 隔离 |
| D11 | 解绑期间 pending outbox | **drop wechat outbox 但 web 会话留一条系统记录** | keep-for-rebind / fanout 到 web | Codex r1 D11:保留 web 痕迹避免"用户解绑后才发现消息丢了" |
| D12 | scan QR 流程 | **维持现状**(qrcode 单 use + userId match + 10min TTL) | 加 Web 端二次验证码 | 边际收益低 |
| D13 | 回滚机制 | **master `commercial.wechat.brokerEnabled` feature flag**,关闭后:pairing API 返回 disabled / broker 停 worker / 容器侧 sink 探测 broker 不可用 → no-op | 代码 revert + redeploy | Codex r1 CRITICAL#4:已运行容器不会自动回旧镜像,回滚必须运行时可控 |
| D14 | 富媒体降级文案 | **P1 单文字阶段**:富 block 显式降级为"[图表 - 详情见 Web]" + 短链;非透明丢弃 | 静默 strip | Codex r1 D 评论:P1 单文字若静默丢图表,UX 会像"功能残缺" |

## 4. 核心子系统设计

### 4.1 WeChatBroker (master 进程内)

**位置**: `packages/commercial/src/wechat/`(新模块,与 `ws/`、`http/`、`compute-pool/` 平级)

```
packages/commercial/src/wechat/
├── broker.ts              单例,组装 manager + inboundDispatcher + outboundReceiver + notifyReceiver + rate-limiter + healthMonitor
├── inboundDispatcher.ts   wechat inbound → 找容器 → POST /internal/v3/wechat-inbound
├── outboundReceiver.ts    HTTP handler, 接 /internal/v3/wechat-outbound → 调 manager 渲染流水线 → sendText/Image/...
├── notifyReceiver.ts      HTTP handler, 接 /internal/v3/notify-user → channel auto 路由 → quiet hours → 分发到 wechat 出站或 web push (P4)
├── rendererPipeline.ts    RichBlock[] + capabilities → IlinkPart[] 序列(text/image/voice/video/file)
├── commandRouter.ts       /list /switch /new /back /here /help /status 命令分发
├── sessionPointer.ts      wechat_session_pointer 读写 + LRU stack 维护
├── rateLimiter.ts         per-binding token bucket
├── healthMonitor.ts       worker heartbeat + binding.status 实时回写
└── __tests__/             单元 + 集成测试
```

**broker 生命周期**:
- master gateway 启动 (`packages/cli/src/commands/gateway.ts:155`) → 注入 `commercial.broker` 句柄到 Gateway deps
- broker 初始化时复用现有 WechatManager(包内 `packages/channels/wechat`),但 manager 的 `onInbound` 回调改为调 broker 的 `inboundDispatcher`,而不是 `ctx.dispatch`(后者在 master 进程里没意义)
- broker shutdown 时停 manager + 关闭所有 inflight HTTP

### 4.2 Inbound 链路: wechat → 容器

> ⚠ Codex r1 CRITICAL#1/#2/#3 修订:transport / 认证 / 会话绑定语义全部重写。

```
[iLink]
   │ getupdates poll
   ▼
[WechatWorker.loop]                          packages/channels/wechat/src/worker.ts (现成)
   │ msg parsed
   ▼
[manager.handleInbound]                       packages/channels/wechat/src/manager.ts (现成,hook 改造)
   │ commercial mode 下走 broker.onInbound(evt),不走 ctx.dispatch
   ▼
[broker.inboundDispatcher.dispatch]           packages/commercial/src/wechat/inboundDispatcher.ts (新)
   │ 1. 命令分流: text 以 / 开头 → commandRouter (本地处理,不入容器)
   │ 2. 否则查 wechat_session_pointer → current_session_id (无则:master 在 master sqlite client_sessions 写新 web-visible row,写 pointer)
   │ 3. resolveContainerEndpoint(userId)  ← 复用 userChatBridge.ts:1525-1531
   │    返回 { host, port, tunnel?, containerId }
   │ 4. ensureRunning: 若 stopped → dispatcher 返 cold_start outcome (含 coldStartReply 文案) → broker 走 fire-and-forget sendText 把 "正在唤醒容器,稍等几秒" 直接推给用户(**不入 outbox / 不留 pending state**,用户片刻后重发即可)
   │ 5. **client_sessions 同步(D3c 关键步骤)**:broker 先调一次 PUT /api/sessions/:sessionId(等同模拟前端首次同步)走 router → 容器 sqlite,确保 turn 启动前两侧 sqlite 都有这条 row
   │ 6. 容器 ready 后,选择 transport (D3b):
   │    - self host:   POST http://${bound_ip}:18789/internal/v3/wechat-inbound
   │    - remote host: POST 经 node-agent tunnel 到容器 18789(复用 rpcCall infra)
   │    认证: D3d — HMAC 派生 nonce (header: X-OpenClaude-Inbound-Nonce + X-OpenClaude-Container-Id)
   ▼
[container handler: wechat-inbound]           packages/gateway/src/v3WechatInbound.ts (新)
   │ verify (checkInboundBypass): 源 IP === TRUST_BRIDGE_IP + container-id 匹配 + timingSafeEqual(nonce, HMAC(bridgeSecret,'inbound:'+containerId))
   │ **直接构造 InboundMessage 帧**(与 telegram / personal-wechat 同 contract,S3 spike 颠覆性发现:不存在 hello/bind 仪式)
   │   { type:'inbound.message', channel:'wechat', peer:{id,kind:'dm',meta}, agentId, content, idempotencyKey, ts }
   │ 调 gateway.dispatchInbound(frame)
   │ AgentSession 由 (channel, peer.id, agentId) 在 SessionManager lazy create / attach
   │ turn 启动 → assistant 回复经 v3MasterSink 自动写回 master sqlite(现成机制,server-authored)
   │ outbound 经 v3WechatOutbound sink POST 回 master broker (见 §4.3)
```

**HTTP contract**:

```
POST http://${containerBoundIp}:18789/internal/v3/wechat-inbound
X-OpenClaude-Container-Id: <agent_containers.id>     (D3d)
X-OpenClaude-Inbound-Nonce: <HMAC(bridgeSecret,'inbound:'+containerId)>  (D3d, base64url 32B)
Content-Type: application/json
X-Request-Id: <uuid>                                 (追溯)

{
  "wechatBindingUserId": "u-12345",
  "wechatSenderId": "wx-fromUser",                (base64url 编码避特殊字符)
  "wechatMessageId": "seq-87",                    (idempotencyKey 用)
  "sessionId": "sess-abc",                        (pointer 解析后的目标,必填 — master 已保证 sqlite 两侧 row 存在)
  "agentId": "main",                              (写回 master 需 agentId)
  "traceId": "trc-...",
  "content": {
    "kind": "text",
    "text": "你好,帮我看看今天的 PR"
  },
  "rawItemTypes": [1],                            (iLink 原始 type list,审计用)
  "wechatTs": 1762345678000
}

→ 200 { "ok": true, "dispatched": true }
→ 202 { "ok": true, "coldStarting": true, "retryAfterMs": 3000 }   (容器进程在但 bootstrap 未完;P1 broker **不**做后台重试)
→ 401 invalid nonce(checkInboundBypass 失败)
→ 503 { "code": "CONTAINER_UNREACHABLE" }                            (broker 标 degraded)

**P1 冷启处理语义(D5 + R5)**:202 是容器告知"我已起来但仍在 bootstrap"。dispatcher 解析 body 里的 `retryAfterMs / retryAfterSec`,**只用作 reflection 文案的可选信息**(非必填),返 `{kind:'cold_start', coldStartReply}` outcome 给 broker;broker fire-and-forget `sendText(coldStartReply)` 推给用户,**不入 outbox / 不留 pending state / 不做后台重试** — 简化首版状态机,用户片刻后重发即可。"broker 自动重投递" 留到 P1.7+ 接 pending-inbound 状态机时再加。
```

**幂等性**: `wechatMessageId` 进容器内 sessionManager 的 idempotencyKey,重投递安全。

**为什么走容器 18789(而非 18443)**: 18443 是 **master 上的 mTLS listener**(`packages/commercial/src/index.ts:941`),容器 → master 反向入口;master → 容器没有 18443 通道,只能走 node-agent tunnel 到容器自身 gateway 端口 18789(`userChatBridge.ts:1525` 样板)。

**为什么不模拟 hello/bind 帧(S3 spike 修正)**: S3 调研代码证实:
- v3 没有"webchat bind 帧",`session_repo_bind`(`server.ts:4144-4152`)是 GitHub workspace 绑定,与 session 建立无关
- `inbound.hello`(`server.ts:4122-4140`)只做 outbound ring replay + `clientsByPeer` 注册,**不创建 AgentSession**
- AgentSession 由 `inbound.message` 的 `(channel, peer.id, agentId)` 三元组在 `dispatchInbound`(`server.ts:5104`)**lazy create**
- `client_sessions` 行本来就由**前端 PUT /api/sessions/:id**(`server.ts:1580-1689`)主动写入,与 ws 帧解耦
- 现成证据:telegram (`packages/channels/telegram/src/index.ts:56`) + personal wechat manager (`packages/channels/wechat/src/manager.ts:108`) 都**直接 `ctx.dispatch({type:'inbound.message',...})`**,从不发 hello/bind,session 照样建/复用

Codex r1 CRITICAL#3 关切真实(必须 master/容器 sqlite 一致),但归因错位 — 真正子问题是 **PUT 模拟**(broker 主动写 client_sessions 元数据),而**不是帧模拟**。本 §4.2 修正后两个语义都覆盖。

### 4.3 Outbound 链路: 容器 → wechat

```
[Agent → SessionManager.broadcast(outboundMessage)]
   │ outbound.channel='wechat' (从 inbound 继承)
   ▼
[Gateway.deliver]                  packages/gateway/src/server.ts:5958 (改造)
   │ 容器内无 wechat adapter,改走 v3WechatOutbound sink
   ▼
[v3WechatOutbound.send]           packages/gateway/src/v3WechatOutbound.ts (新, 仿 v3MasterSink.ts)
   │ POST master:18443/internal/v3/wechat-outbound
   │ 失败入 outbox.jsonl, replay 时重试
   ▼
[broker.outboundReceiver]          packages/commercial/src/wechat/outboundReceiver.ts (新)
   │ verify identity → 拿到 containerId → 反查 user_id
   │ 限频检查 (rateLimiter.consume(user_id))
   │ 富 block → rendererPipeline.render(blocks, WECHAT_CAPS)
   │ → 多个 IlinkPart (text/image/voice/...)
   ▼
[WechatManager.sendParts]          packages/channels/wechat/src/manager.ts (改, 替代当前 send 内联 sanitize)
   │ part.kind=text → worker.sendText
   │ part.kind=image → worker.sendImage (新)
   │ part.kind=voice → worker.sendVoice (新)
   │ ...
   ▼
[iLink sendmessage] (per part)
```

**HTTP contract**:

```
POST https://master:18443/internal/v3/wechat-outbound
Authorization: Bearer oc-v3.<containerId>.<secret>     (容器 → master 方向,复用现有 containerIdentity)
Content-Type: application/json
X-Request-Id: <uuid>

{
  "sessionId": "sess-abc",
  "agentId": "main",
  "channel": "wechat",
  "peer": {
    "kind": "dm",
    "meta": {                                          (结构化, 避裸 colon 拼接)
      "userId": "u-12345",
      "senderId": "wx-fromUser",                       (base64url)
      "sessionId": "sess-abc"
    }
  },
  "blocks": [
    { "kind": "text", "text": "已完成,这是结果:" },
    { "kind": "chart", "data": {...} },
    { "kind": "attachment", "path": "/workspace/.../report.pdf", "mime": "application/pdf" }
  ],
  "outboundId": "out-87654",                           (idempotencyKey)
  "createdAt": 1762345678000,
  "traceId": "trc-..."
}

→ 202 { "ok": true, "scheduled": true, "rateLimit": { "remaining": 47, "resetAt": 1762... } }
→ 429 { "code": "RATE_LIMIT" }
→ 503 { "code": "WECHAT_DOWN", "fallbackToWeb": true }
→ 401 invalid identity
```

**outbox 职责边界**(Codex r1 IMPORTANT#4):
- **容器内 `outbox.jsonl`**: container → master 传输失败重试。master 一旦返 202,容器从 outbox 删除。
- **master 内 `wechat_outbox` PG 表**: master 已接收后,iLink 发送重试。一旦 iLink ACK 即删。
- 两边不持有同一条消息的生命周期,避免重复发送。`outboundId` 跨边界保持一致用作 idempotency 锚。

### 4.4 RichBlock 富媒体渲染流水线

**位置**: `packages/commercial/src/wechat/renderForWechat.ts`

> Codex r1 IMPORTANT#6:caps 参数保留(为未来留路),但模块名/路径 wechat 专属;**不预先承诺 channel-agnostic**,第二个通道接入时再上提到公共包。

```ts
interface ChannelCapabilities {
  text: boolean
  image: boolean
  video: boolean
  voice: boolean
  file: boolean
  markdown: boolean        // wechat 为 false
  maxTextLen: number       // wechat: 1800
  maxFileBytes: number     // wechat 上传素材的大小限制(P2 spike 确认)
}

const WECHAT_CAPS: ChannelCapabilities = {
  text: true, image: true, video: true, voice: true, file: true,
  markdown: false, maxTextLen: 1800, maxFileBytes: 10 * 1024 * 1024,  // 10MB 占位
}

// 入: RichBlock[](已有抽象,packages/protocol/src/outbound.ts)
// 出: IlinkPart[]  (text | image_path | voice_path | video_path | file_path)
async function renderForWechat(blocks: RichBlock[], caps: ChannelCapabilities): Promise<IlinkPart[]>
```

**渲染规则**:

| RichBlock kind | wechat 渲染 | 实现细节 |
|---|---|---|
| `text` | sanitize(markdown→plain) → split(maxTextLen) | 复用现有 `sanitizeForWechat` |
| `tool_use` (final) | 单行 `🔧 friendlyToolName` | 复用现有逻辑 |
| `tool_result`, `thinking` | 丢弃 | 同上 |
| `chart` | server-side `chart.js` → PNG → image_path | **P2 新增**:`packages/web/public/vendor/chart.umd.min.js` headless 渲染(或 node-canvas) |
| `mermaid` | mermaid-cli → PNG → image_path | **P2 新增**:`@mermaid-js/mermaid-cli` |
| `htmlpreview` | headless playwright → PNG | **P2 新增**:复用容器内 playwright |
| `attachment` (path) | MIME 嗅探 → image/video/voice/file | **P2 新增** |
| `attachment` (path, >maxFileSize) | 转 short link + 文字提示 | maxFileSize wechat 待查 |

**降级路径**:任意 step 失败 → 转纯文本 "[图表]" / "[文件: 文件名]" + 文字 hint "完整内容回 Web 查看 <短链>"

### 4.5 多会话指针 + 命令系统

**新表**: `packages/commercial/src/db/migrations/0064_wechat_session_pointer.sql`

> 注:**本节展示 P3 终态 schema**(含 lru_stack)。P1 实际只 migrate `binding_user_id / current_session_id / updated_at` 三列(见 §7 Phase 1 改动 #5);`lru_stack` 列在 P3 migration 增量补上。

```sql
-- P3 终态(P1 不含 lru_stack 列)
CREATE TABLE wechat_session_pointer (
  binding_user_id TEXT PRIMARY KEY,        -- = wechat_bindings.user_id (= commercial uid)
  current_session_id TEXT NOT NULL,
  lru_stack JSONB NOT NULL DEFAULT '[]',   -- 最近 5 个 session_id, 最新在末尾(P3 才有)
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_wsp_session ON wechat_session_pointer(current_session_id);
```

**注**:虽然 wechat_bindings 在 master SQLite 而 agent_containers 在 PostgreSQL,但 wechat_session_pointer 只关心 binding ↔ session 映射,**放 PostgreSQL** 是因为 broker 在 master 进程内,跟 commercial 数据库一起更新一致。session_id 跨 DB 一致性由"session 是 first-class app 概念"保证。

**命令列表**:

| 命令 | 行为 | 实现位置 |
|---|---|---|
| `/list [n=10]` | 列最近 n session,带短 id (sess-A1B2) + 时间 + preview | commandRouter:`listSessionsForBinding` |
| `/switch <short-id>` | 解析短 id → 校验属于该 user → 设 pointer + push lru | commandRouter:`switchSession` |
| `/new [title]` | 走 commercial new session API → 设 pointer | commandRouter:`createNewSession` |
| `/back` | lru_stack pop → 设 pointer | commandRouter:`switchBack` |
| `/here` | echo current pointer + session title + last activity | commandRouter:`whereAmI` |
| `/help` | 列所有命令 + 短描述 | commandRouter:`help` |
| `/status` | 维持现状(binding 状态) | 现有逻辑 |
| `/new` (无 title) | 维持现状但走新路径 | 改造现有 |

**出站消息前缀策略**:

- pointer 在最近 10min 内有变更 → 该 binding 下一次出站消息首条加前缀 `[sess-A1B2 · 标题]`,之后不加
- 永久前缀会噪音,完全不前缀会困惑 — 时间窗口平衡

### 4.6 `notify_user` agent tool

**位置**: `packages/commercial/agent-sandbox/runtime/notifyUser.ts` (新)

实际作为 MCP tool 注入到容器内 agent。

```ts
// Tool schema
{
  name: "notify_user",
  description: "主动给用户推送消息(跨通道)。用于 agent 完成长跑任务、需要用户确认、异步事件触发等场景。",
  input_schema: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string", description: "消息内容,会按通道能力自动渲染" },
      attachments: {
        type: "array",
        items: { type: "string", description: "绝对路径,支持图片/视频/音频/文件" }
      },
      channel: {
        type: "string",
        enum: ["wechat", "web", "auto"],
        default: "auto",
        description: "auto = 按下面 5 步优先级链;无可用通道时入会话不主动 push(避免噪音)"
      },
      sessionId: { type: "string", description: "默认当前 session" },
      silent: { type: "boolean", default: false, description: "免打扰时段仅入会话不推送" },
      expiresAt: { type: "number", description: "Unix ms,过期不推送" }
    }
  }
}
```

**实现**(Codex r2 IMPORTANT#3:不再复用 wechat-outbound,**走独立 endpoint** `/internal/v3/notify-user`):
- 容器内 `notify_user.execute()` 构造 `{ message, attachments, channel, sessionId, silent, expiresAt, traceId }` → POST master `/internal/v3/notify-user`(走 D3b transport + D3d 认证,与 wechat-outbound 同路但 schema 不同)
- 为什么独立 endpoint(而非复用 wechat-outbound):
  - wechat-outbound 语义 = "已知目标通道是 wechat,把这个 RichBlock 渲染发出去",input 是 RichBlock[]
  - notify-user 语义 = "我不一定知道发哪,你帮我按策略选通道",input 是 message + channel preference,**包含路由决策**(auto 链 + quiet hours + expiresAt 过期判定)
  - 复用会让 wechat-outbound handler 长出一堆 if(channel==='auto'),违反 SoC;独立 endpoint 内部再 dispatch 到 wechat-outbound(channel='wechat' 时)或 web push(channel='web' 时)
- broker `/internal/v3/notify-user` 处理流程:
  1. 校验 D3d Bearer + zod schema
  2. 计算 `targetChannel` —— **channel='auto' 优先级链**(Codex r1 IMPORTANT#5):
     a. 显式 channel 参数 → 用
     b. 当前 session 最近输入 channel(查 session.last_inbound_channel)→ 用
     c. user_preferences.default_notify_channel(若有)→ 用
     d. 最近 5min 内 wechat 活跃(wechat_session_pointer.updated_at < 5min)→ wechat
     e. **fallback = 写入会话但不主动 push**(不 fanout 避免噪音)
  3. quiet hours 判断 + silent flag → 决定 push 或仅写会话
  4. expiresAt 已过 → 不发,返回 `{ ok: false, reason: 'expired' }`
  5. 分发:`targetChannel === 'wechat'` → 调 broker 内部 wechat 出站逻辑(底层共用 manager.send,但**不**经过 outboundReceiver 的 HTTP handler——直接函数调用);`targetChannel === 'web'` → 走 web push(P4 实现时见现有 web push 路径)

### 4.7 内置 `wechat-notification` seed skill

**位置**: `packages/commercial/agent-sandbox/ccb-baseline/skills/wechat-notification/SKILL.md` (新)

> Codex r1 IMPORTANT#2:**不要走 entrypoint.ts seed 路径**(那条是 codex system skills 专属)。Commercial 平台 baseline skills 是通过 `/run/oc/claude-config/skills` **只读挂载 + manifest 校验**分发的,P4 实施时确认 baseline skill manifest 流程并把 wechat-notification 加入。这条 entry 不混进 codex imagegen seed。

skill 内容(摘要):

```markdown
---
name: wechat-notification
description: 通过 notify_user 工具主动给微信推送消息的规约
type: skill
---

# WeChat 主动通知

何时该主动 push:
- 用户委托的长跑任务完成(代码生成、数据处理、爬虫)
- 异步事件触发(scheduled task 到点、外部 webhook 收到)
- 需要用户确认决策(发现高风险操作前)
- agent 主动想到一件用户可能想知道的事

用法:
notify_user({
  message: "你的 PR #123 review 已完成,3 处 nit + 0 处 blocker",
  channel: "auto",
  attachments: ["/workspace/review-report.md"]
})

风格:
- 短(微信用户在手机上看)
- 有信息量,不是"任务完成了"这种空话
- 富附件优先:图、表、文件比纯文本好
- 链接回 Web 看详情比硬塞长文本好

不该 push 的场景:
- 用户正在 Web 实时对话(已在看屏幕,push 是噪音)
- 频繁低价值通知(进度条更新)
- 用户已设置该场景免打扰
```

### 4.8 频控、心跳、审计、解绑、reconcile

| 子系统 | 设计 |
|---|---|
| 频控 | per-binding token bucket(60 token / min,稳态 1/s),消费失败 → broker 返 429,容器 outbox 重试一次后丢弃 + 容器内本会话回退一条 "微信侧已限流,完整内容看 Web" |
| 心跳 | 每 30s 检查 `worker.isRunning()` 与上次 lastEventAt;<2min 内有 inbound 视为健康;否则 broker 标 `binding.status='degraded'`(新 enum,见 §5.2),前端 modal 显示橙色 + 文案"微信通道连接不稳定,消息可能延迟"(NIT#5 文案) |
| 审计 | iLink 入站原始 payload 入新表 `wechat_inbox_raw(binding_user_id, message_id, sender_id, item_types, raw_jsonb, ts)`,**结构化关键字段**便于索引/排障(NIT#3),7 天 TTL 定时清理 |
| 解绑 | DELETE `/api/wechat/binding` 时 broker.cleanupBinding(uid): 停 worker + 删 pointer + drop pending wechat outbox + **web 会话留一条系统记录"微信绑定已解除,N 条 pending 消息未发送"**(D11 改进)+ 关闭 worker |
| 免打扰 | `user_preferences.wechat_quiet_hours JSONB = [{startMin, endMin}]`(本地时区,minutes from midnight);broker.outboundReceiver 在 quiet 时间内对 silent=true 的消息只入 session 不发 wechat |
| **reconcile**(新, Codex r1 IMPORTANT#3) | broker 启动时 + 每 30s 周期性: (a) 删 orphan pointer(binding 不存在);(b) pointer 查询始终先校验 binding 仍 active,失活立即降级"通道未启用"提示;(c) wechat_outbox 重启时回放 pending 但 >24h 老 entry drop |

### 4.9 观测

broker 暴露 metrics(复用现有 prom registry):

> Codex r1 NIT#4:**binding 不进 label**(基数高),进结构化日志和 audit 表。label 只用枚举状态/类别。

- `oc_wechat_inbound_total{result="dispatched|cmd_local|coldstart|unreachable"}`
- `oc_wechat_outbound_total{part_kind="text|image|voice|video|file"}`
- `oc_wechat_render_duration_ms{block_kind}`
- `oc_wechat_rate_limit_hits_total` (counter, 无 label)
- `oc_wechat_worker_running_count` (gauge,运行中 worker 数)
- `oc_wechat_worker_degraded_count` (gauge,degraded 状态 worker 数)
- `oc_wechat_cold_start_total` (counter, 容器冷启次数)

## 5. 数据模型变更

### 5.1 新表

| 表 | DB | 用途 |
|---|---|---|
| `wechat_session_pointer` | PostgreSQL (commercial) | binding ↔ current session + lru stack;reconcile 删 orphan |
| `wechat_inbox_raw` | PostgreSQL (commercial) | 入站审计;结构化关键字段(message_id, sender_id, item_types)+ raw_jsonb;7 天 TTL |
| `wechat_outbox` | PostgreSQL (commercial) | master 已接收的出站 pending,iLink 发送重试;成功即 delete;>24h 启动时 drop |
| `user_preferences` (扩列) | PostgreSQL (commercial) | 新增 `wechat_quiet_hours JSONB`、`default_notify_channel TEXT` 两列 |

### 5.2 现有表改动

| 表 | 改动 |
|---|---|
| `wechat_bindings` (master SQLite) | `status` enum 加 `'degraded'`(健康监控用) |
| `agent_containers` (PostgreSQL) | (条件性,见 D3d)若选方案 (a):加 `gateway_access_token TEXT`(master→容器 inbound 认证用),由 v3supervisor.ts 在 container provision 时持久化 |

### 5.3 跨 DB 一致性

- session_id 是 first-class app 概念,跨 SQLite/PostgreSQL 保持同一字符串,无 join 需求
- wechat_bindings (SQLite) 与 wechat_session_pointer (PG) 由 broker.reconcile 周期性对账(见 §4.8)
- 解绑(DELETE binding)走 broker.cleanupBinding,事务上不保证 SQLite/PG 同时成功,但 reconcile 30s 内自愈

### 5.3 Migration 文件

`packages/commercial/src/db/migrations/0064_wechat_broker.sql`

## 6. 文件清单(完整)

### 6.1 新建

```
packages/commercial/src/wechat/
├── broker.ts
├── inboundDispatcher.ts
├── outboundReceiver.ts
├── rendererPipeline.ts
├── commandRouter.ts
├── sessionPointer.ts
├── rateLimiter.ts
├── healthMonitor.ts
└── __tests__/{broker,inbound,outbound,renderer,command,rateLimit}.test.ts

packages/commercial/src/db/migrations/
└── 0064_wechat_broker.sql

packages/commercial/agent-sandbox/seed-skills/
├── wechat-notification/SKILL.md

packages/commercial/agent-sandbox/runtime/
└── notifyUser.ts                       # MCP tool 实现

packages/gateway/src/
├── v3WechatInbound.ts                   # 容器内 inbound handler
└── v3WechatOutbound.ts                  # 容器内 outbound sink

packages/channels/wechat/src/
├── iLinkMedia.ts                        # sendImage/sendVideo/sendVoice/sendFile (P2)

docs/v3/
├── wechat-broker-design.md              # 本 RFC
```

### 6.2 改动

```
packages/commercial/src/index.ts                              # dispatchInternal 新增 path 分流;wireup broker
packages/commercial/src/http/router.ts                        # 路由 / API /wechat/* 不变,但内部转发改走 broker 做 inbound
packages/channels/wechat/src/manager.ts                       # commercial mode 下 handleInbound 走 broker hook;send 走 broker
packages/channels/wechat/src/index.ts                         # export 新增的 broker hook 类型
packages/channels/wechat/src/iLink.ts                         # 新增 sendImage/Video/Voice/File (P2)
packages/cli/src/commands/gateway.ts                          # 注入 commercial.broker 句柄到 Gateway deps
packages/gateway/src/server.ts                                # Gateway.deliver 对 channel=wechat 走 v3WechatOutbound
packages/commercial/agent-sandbox/runtime/entrypoint.ts       # 删除 wechat.enabled=false 硬编码;seed-skills 遍历
packages/web/public/modules/wechat.js                         # 显示 degraded 状态;后续 P3 加 session 列表入口
packages/storage/src/wechatBindings.ts                        # status enum 加 'degraded'
```

## 7. Phase 划分

每个 phase **独立可上线**(灰度 → 全量),不依赖后续 phase。

### Phase 1 — Broker 化 + 文字通路(P0)

**目标**: claudeai.chat 微信绑定按钮可用,文字双向收发跑通,feature flag 可回滚

**P1 spike 状态(全部已完成,2026-05-14)**:

| Spike | 状态 | 结论 |
|---|---|---|
| **S1 — D3d 认证** | ✅ 完成(子 agent 调研报告) | **复用 bridgeSecret HMAC 派生**:`OPENCLAUDE_INBOUND_NONCE = HMAC(bridgeSecret, "inbound:" + containerId)`,与 file-proxy `OC_BRIDGE_NONCE` 同型;**零 DB migration,零 master plaintext 存储**;命名空间扩展未来吃整类反向通路 |
| **S2 — 远端 RTT** | ✅ 完成(Tokyo GCE→boheyun 实测) | ICMP ~190-200ms / mTLS handshake ~310-470ms(2 RTT);**冷连 ~500-700ms,热连 keep-alive ~200-300ms**;不需要 warm pool;broker 必须维护 keep-alive 连接池;用户单次往返体感 1-3s 可接受 |
| **S3 — webchat 帧契约** | ✅ 完成(颠覆性发现) | **v3 不存在 webchat bind 帧**,hello 不建 session;AgentSession 由 `inbound.message` 三元组 lazy create(server.ts:5104+5181);telegram + personal-wechat 已用此契约。**正解 = 不模拟 hello/bind,直接构造 InboundMessage** + 单独 PUT /api/sessions 同步元数据。D3c 已据此重写 |

**改动**:

1. 新建 `packages/commercial/src/wechat/` 骨架(broker + inboundDispatcher + outboundReceiver + notifyReceiver + rateLimiter + healthMonitor,仅文字 part)
2. 新建容器侧:
   - `packages/gateway/src/v3WechatInbound.ts` — HTTP handler,内部**直接构造 InboundMessage 帧调 `gateway.dispatchInbound(frame)`**(与 telegram 同 contract,不模拟 hello/bind);verify 走新 `checkInboundBypass()`(与 `checkBridgeBypass` server.ts:2089-2130 同构)
   - `packages/gateway/src/v3WechatOutbound.ts` — channel=wechat 出站 sink,POST master 18443/internal/v3/wechat-outbound(仿 v3MasterSink.ts)
3. 改造 `entrypoint.ts:265-268` 删除 wechat 硬编码 false,改为读 master 下发的 channel config
4. 改造 `channels/wechat/src/manager.ts`:commercial mode 下 inbound 走 broker hook(`broker.onInbound(evt)`),send 走 broker;personal 模式行为不变
5. **Master→container 认证(D3d HMAC 派生)**:
   - `v3supervisor.ts:1614-1621` env 注入块新增 `OPENCLAUDE_INBOUND_NONCE = HMAC(bridgeSecret, "inbound:" + row.id).toString('base64url')`
   - master 侧 `bridgeSecret.ts` 暴露 helper `computeInboundNonce(containerId)` 返回**统一 base64url 32B**(不要复用 file-proxy 的 hex 64 format,Codex r4 提醒避免编码混用)
   - 容器 `server.ts` 新增 `checkInboundBypass(req)`:源 IP === `OPENCLAUDE_TRUST_BRIDGE_IP` + `X-OpenClaude-Container-Id` === env `OC_CONTAINER_ID` + `timingSafeEqual(headerNonce, env.OPENCLAUDE_INBOUND_NONCE)`(domain separation:`HMAC(s,'inbound:'+id)` vs file-proxy 的 `HMAC(s, id)` 输出空间不重叠,Codex r4 确认安全)
   - **零 DB migration**(D3d 选项 B' = 复用 bridgeSecret,见 §3.2 D3d)
6. **Migration `0064_wechat_pointer_outbox_audit.sql`**:
   - 最小 `wechat_session_pointer`:`binding_user_id PK (= wechat_bindings.user_id), current_session_id, updated_at`(P3 增 `lru_stack jsonb`)
   - `wechat_outbox`(iLink send 重试队列)+ `wechat_audit`(入站原始 payload)
   - **不**新增 `client_kind='wechat'` enum(Codex r3 §10.2 #2 答案:扩 schema 收益不抵)
7. **client_sessions 同步(D3c 关键步骤,Codex r4 落 3 个 guard)**:

   **关键事实(Codex r4 调研)**:
   - PUT `/api/sessions/:id` 在 `server.ts:1322` 过 `checkHttpAuth`,**不能用前端 JWT 鉴权**;broker 走 PUT 模拟前端会被 401(broker 不持有用户 JWT)
   - 现有 v3MasterSink durable write 在 `sessionManager.ts:1819` gate `session.channel === 'webchat'`,**wechat channel 不会自动写 master sqlite**

   **P1 实现(避开两个隐藏断点)**:容器侧 `/internal/v3/wechat-inbound` handler 内**一次性**完成两件事(都用 D3d nonce 鉴权,绕开 PUT 鉴权问题):
   - (a) 直接调容器内 `upsertClientSession({id: sessionId, userId: 'c:'+commercialUid, originChannel: 'wechat', ...})` 写容器 sqlite(等同 PUT handler 的核心,但不过 checkHttpAuth)
   - (b) 构造 `InboundMessage` 帧调 `gateway.dispatchInbound(frame)`

   broker 这侧顺序(**PUT 后 INSERT** —— Codex r4 推荐反序,失败不留 master 孤儿):
   - **Step 1**:broker POST 容器 `/internal/v3/wechat-inbound`(handler 内做 (a)+(b))→ 200 才继续
   - **Step 2**:200 后 broker 在 master sqlite INSERT `client_sessions` row + 写 `wechat_session_pointer`(单事务)
   - **Step 3**:turn 完成后 v3MasterSink 反向写 master sqlite turn 内容 — **必须把 sink gate 扩展为允许 channel='wechat'**(在 `sessionManager.ts:1819` gate 加 `|| session.channel === 'wechat'`)

   **失败回滚**:Step 1 fail → dispatcher 啥也不写,返 `transport_failed`/`container_rejected` outcome;**P1.6 broker.ts 不入 pending、不自动重投递,直接透传给上游 caller**(P1.7+ pending-inbound 状态机引入后再加 outbox retry);Step 2 fail(罕见,master sqlite 本地 INSERT)→ broker 把容器 sqlite 那条 row soft-delete(再调一次 inbound endpoint 的 delete-orphan 路径)

   **reconcile 扩展(§4.8)**:除了清孤儿 pointer / binding,新增"扫 master sqlite `client_sessions` 中 `originChannel='wechat'` 但无对应 `wechat_session_pointer.current_session_id` 的孤儿 row,soft-delete"
8. 健康监控雏形(worker.isRunning() + binding.status='degraded')
9. **feature flag `commercial.wechat.brokerEnabled`**:master config + 运行时可切,关闭 = pairing API 返 `WECHAT_DISABLED`、broker 停 worker、容器 sink 探测后 no-op
10. **冷启 UX**(D5):broker.inboundDispatcher 收 inbound 若 ensureRunning 触发冷启 → dispatcher 返 `cold_start` outcome → broker fire-and-forget `sendText("正在唤醒...,稍等几秒")` 直接推给用户;**本条反射消息不进 outbox(outbox.session_id NOT NULL,反射没有 wsess) / 不留 pending state / 不做后台重试** — 用户片刻后重发即可走正常 dispatch 流程
11. **P1 富媒体降级文案**(D14):容器侧 channel=wechat outbound 含非 text block 时,renderForWechat 早期降级返 `"[图表 - 详情见 Web]"` + `<短链>`(P1 阶段不真渲染图,只显式降级避免静默丢失)
12. **inbound POST keep-alive 连接池**(S2 数据驱动):broker → 远端 host 的 HTTP POST 必须 keep-alive(冷连 600ms vs 热连 200ms 差 3x);超时 5s,失败 1 次退避重试

**验收**: dev 灰度 1 个用户(boss 自己绑微信)→ 微信发文字 → agent 回文字 → 跑 1 天无 worker crash;feature flag 关闭 → 微信通道完全 no-op 不报错;**`wechat_session_pointer` 表中 boss binding 对应 1 行 current_session_id,该 session 出现在 master web 端会话列表,点开能看到微信触发的 turn 历史**(P1 不要求 session id deep link)

### Phase 2 — 富媒体(P1)

**目标**: 微信能看到图、音视频、文件、图表

**改动**:
1. `iLink.ts` 抓包/查文档,实现 `sendImage/Video/Voice/File`(协议 type code 待 P2 启动时确认)
2. `rendererPipeline.ts` 全套渲染规则
3. chart/mermaid server-side 渲染基础设施(node-canvas + chart.js, mermaid-cli)
4. attachment MIME 嗅探 + 大小限流

**验收**: agent 主动输出图表/截图/附件 → 微信侧能看到真实媒体 + 失败降级为文字提示

### Phase 3 — 多会话指针 + 命令系统(P1)

**目标**: 微信侧能选择/切换/列出 OC 会话

**改动**:
1. `wechat_session_pointer` 表扩展 migration:P1 已有的单 current_session_id 行扩展为多会话 LRU 列表(`sessions` jsonb 列 + `last_used_at`,current 仍是 head)
2. `commandRouter.ts` 实现全部命令(`/list /switch /new /back /here /help`)
3. **peer 模型走结构化 meta**(D6 决策,Codex r2 IMPORTANT#2):AgentSession.peer = `{ id: <stable hash>, meta: { channel:'wechat', userId, senderId (base64url), sessionId } }`;不要回退到裸字符串拼接 `${userId}:${senderId}:${sessionId}`(命令系统切换 session 时 peer.meta.sessionId 字段更新,**不重建 session,只更新 router 内绑定**)
4. 出站前缀策略(switch 命令后 N 分钟显示当前 session 标签)
5. 前端 wechat.js 加 "查看当前会话指针" 入口(可选)

**验收**: 微信侧 `/list /switch /new /back /here /help` 全部按预期工作;切换 session 后 SessionManager 复用 master 下发的 sessionId(不创建容器本地 session)

### Phase 4 — 主动通知 + 内置 skill(P1)

**目标**: agent 能主动 push 微信,容器内 skill 已注入

**改动**:
1. `notify_user` MCP tool 实现 + 注册
2. **基线 skill 注入**:把 `wechat-notification` skill 放在 `packages/commercial/agent-sandbox/ccb-baseline/skills/wechat-notification/`(SKILL.md + manifest),由 supervisor/entrypoint 启动时拷贝到容器 `/root/.openclaude/agents/main/skills/`(沿用现有 baseline 注入机制,**不**走 `entrypoint.ts:186-216` 的 codex imagegen seed-skill 路径,那是另一条独立链路)
3. broker 加 **独立** `/internal/v3/notify-user` endpoint(D3b transport + D3d 认证,**不**复用 wechat-outbound,见 §4.6 实现说明)
4. 免打扰时段 + `user_preferences.wechat_quiet_hours`
5. channel='auto' 路由策略(按 §4.6 的 5 步优先级链)

**验收**: agent 跑长任务结束主动 push 微信成功;开启免打扰时段后 push 只入会话不推送;`docker exec <container> ls /root/.openclaude/agents/main/skills/wechat-notification/SKILL.md` 存在

### 横切(每 phase 嵌入)

- 频控 token bucket(P1 雏形,P2-P3 调参)
- 审计入站原始 payload(P1 就上)
- 解绑策略(P1 就上)
- 观测 metrics(P1 起,每 phase 加 metric)
- 单元 + 集成测试,每个 phase 测试覆盖率 ≥ 70%
- Codex Code Review 每个 phase 走一遍

## 8. 风险 + 回滚

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| R1 | iLink 富媒体协议 type code 不正确 | P2 推图失败 | 抓包验证 + 灰度单用户 + 失败降级为文字 hint(§4.4 capability matrix + D14) |
| R2 | broker 内存泄漏(N×长连接 + N×Map) | master 进程 OOM | 心跳监控 worker count + reconcile 每 30s 一次,leak 测试 |
| R3 | **master → container HTTP POST 远端 host 不可达(D3b transport 风险,Codex r1 CRITICAL#1 反馈衍生)** | inbound 帧到达 master 但无法投递到容器,用户消息丢失或延迟 | (a) **S2 spike 实测数据(2026-05-14)**:Tokyo GCE → boheyun 美国轻量,ICMP ~190-200ms,mTLS 握手 310-470ms(2 RTT),冷连 HTTP POST ~500-700ms,**keep-alive 热连 ~200-300ms**,**用户单次往返体感 1-3s**;(b) broker 必须维护**到每个远端 host 的 keep-alive HTTP 连接池**,timeout 5s,失败 1 次退避重试;(c) 不需要 warm pool(冷启动主导是 ensureRunning 而非网络);(d) node-agent tunnel 失败 → **P1.6 (slice 4c) 不做后台 retry**,dispatcher 返 `transport_failed` outcome,broker 透传给上游 caller(P1 manager 调用方),无 inbound 入 pending 队列;**P1.7+** 接 pending-inbound 状态机时再加 broker outbox `inbound_pending` 重试路径;(e) 连续失败 N 次置 binding `degraded`,前端橙色 + "微信通道连接不稳定,消息可能延迟";(f) **不**回填 sendIlinkText 错误提示(避免重发触发垃圾回复) |
| R4 | **client_sessions 行在 master sqlite + 容器 sqlite 两侧不一致(S3 修正后的真正风险面)** | turn 能跑但 master web 端会话列表看不到 wechat 触发的 session,或容器 sqlite resume 时找不到行 | (a) D3c 决策:broker 在 dispatch 前**主动调 PUT /api/sessions/:id**(模拟前端 sync)→ 容器 sqlite upsert;(b) master sqlite 这侧由 broker 写 pointer 时同步 INSERT client_sessions row(user_id 字节级对齐 web owner id 含 `c:` 前缀);(c) turn 内容由 v3MasterSink 自动反向写 master sqlite(现成机制);(d) §4.8 reconcile 30s 校验 pointer→session 存活,孤儿清理;(e) 容器内 AgentSession 是 in-memory `Map<sessionKey, AgentSession>`,重启 SessionManager 即弃,**不**被视作权威源(主权威 = 两侧 sqlite client_sessions 行) |
| R5 | 容器 ↔ master 18443 TLS handshake 失败率上升(container → master 方向已生产稳定) | outbox 写回丢失 | 容器侧 outbox.jsonl 本地重试 + master 侧已有 retry 机制(`v3MasterSink` 在生产稳定运行) |
| R6 | sessionPointer 跨 DB 一致性(SQLite ↔ PostgreSQL) | 切错会话 | session_id 是 first-class app 概念,跨 DB 都用同一字符串 id,无 join;reconcile 自愈 |
| R7 | 用户已绑定但 P1 上线前不知道功能改变 | UX 困惑 | P1 上线发 changelog(boss 亲笔)+ 第一次入站时 broker 主动推一条"功能已升级"提示 |
| R8 | feature flag 关掉后已分发容器仍跑旧逻辑 | 回滚不彻底 | D13 决策:flag 是 master 侧权威源,broker / pairing API / 容器侧 sink 探测 broker 不可用 → no-op,**不依赖容器重启**就能 disable 入站 |

**回滚策略(D13 feature flag 驱动,禁止依赖 redeploy / 改镜像)**:

每个 phase 独立可回滚,所有回滚动作**必须 master 进程运行时可执行**。禁止依赖"改 entrypoint.ts 硬编码 + 构镜像 + 滚动重启所有用户容器"——这条路径生产环境根本走不通(已分发容器不会自动回到旧镜像,boss 也不能为回滚强行 reset 用户)。Codex r1 CRITICAL#4 已明确否决这条退路。

| Phase | 回滚开关 | 行为 |
|---|---|---|
| P1 | `commercial.wechat.brokerEnabled = false` | (a) `/api/wechat/pair/*` 返 409 disabled;(b) WechatManager 停所有 worker;(c) 容器侧 `/internal/v3/wechat-inbound` 收不到任何投递(broker 不再发);(d) 容器侧主动 POST `/wechat-outbound` → master 返 403,容器 sink 进降级模式(写本地 outbox 不重试) |
| P2 | `commercial.wechat.richMediaEnabled = false` | broker capability matrix **只关 image/video/voice/file/markdown 等富媒体能力,text 保持 true**(Codex r2 IMPORTANT#4);renderForWechat 检测到非 text block → §4.4 D14 fallback 文案触发;**纯文本路径 100% 不受影响**(P1 文本通路完全独立运行),这是 P2 上线对 P1 已绑定用户**零回归**的关键保障 |
| P3 | `commercial.wechat.multiSessionEnabled = false` | broker 不解析 `/list /switch /new /back /here`,全 fallback 到 P1 单 session;wechat_session_pointer 不清空(下次开启复用) |
| P4 | `commercial.wechat.notifyEnabled = false` | `notify_user` tool 返 `{ ok: false, reason: 'disabled' }`;baseline seed skill 仍在容器内,下次开启即可用,无需重新分发 |

**Flag 落地位置**:master `commercial.json` 配置 + `WechatManager.reload()` 热重载(无需 master 重启);容器侧**不**直接读 flag,统一由 master 网络层 enforce(broker 不发就是关,容器 POST 被拒就是关)。这是 D3d 决策的对称——master 是 SoT,容器是 follower。

## 9. 不在本 RFC 范围(明确画线)

- ❌ 替换 iLink 为企业微信 / 公众号 / 小程序客服 — iLink 已是腾讯官方
- ❌ 通用 cross-channel notification bus 跨 user / 跨 agent — `notify_user` 只服务"当前 session 的 agent → 当前 user"
- ❌ broker 跨 master 进程多实例 HA — 商业版当前是单 master,未来 HA 时再做 leader election + token versioning(worker.ts:88-102 已留出该假设的备注)
- ❌ wechat 群聊场景 — 当前 iLink bot 只支持 1:1 DM
- ❌ wechat 表情/动图/位置/红包等异型消息类型 — 入站全部 ignore,出站不发

## 10. 待 Codex Plan Review 决策

### 10.1 Codex r1 反馈处置状态

| Codex r1 条目 | 处置 | 落地位置 |
|---|---|---|
| CRITICAL#1 inbound 用错端口 18443 | ✅ 已修:改走容器内 18789 + node-agent tunnel | §4.2 + D3b + R3 |
| CRITICAL#2 复用 `oc-v3.<containerId>.<secret>` 方向反了 | ✅ 已修:拆出 D3d 单独定义 master → container 认证(P1 必须 spike S1) | §4.2 + D3d |
| CRITICAL#3 `sessionManager.dispatch` 会切到容器本地 session | ✅ 已修:走 webchat hello/bind 复用,master sessionId 唯一权威 | §4.2 + D3c + R4 |
| CRITICAL#4 回滚不可运行时执行 | ✅ 已修:D13 feature flag 化,全 phase 回滚不需重镜像 | D13 + §8 |
| IMPORTANT#1 冷启动 UX | ✅ 已修:`正在唤醒` + retry | D5 |
| IMPORTANT#2 seed skill 注入路径错 | ✅ 已修:走 ccb-baseline/skills,不走 codex imagegen seed | §4.7 + Phase 4 |
| IMPORTANT#3 pointer reconcile 缺失 | ✅ 已加 §4.8 | §4.8 |
| IMPORTANT#4 outbox 边界 | ✅ 已明确 transport vs iLink 两层 | §4.3 |
| IMPORTANT#5 notify_user auto 策略 | ✅ 已展开 5 步优先级链 | §4.6 |
| IMPORTANT#6 renderer 跨通道承诺过头 | ✅ 已改 renderForWechat 名 | §4.4 |
| NIT#1~5 | ✅ 全部已并入 | 各章节 |

### 10.1b Codex r2 反馈处置状态(本轮新增)

| Codex r2 条目 | 处置 | 落地位置 |
|---|---|---|
| CRITICAL P1 sessionPointer 缺失断了 session 权威链 | ✅ 已修:P1 引入最小 `wechat_session_pointer` (单 current_session_id),P3 扩展为多 session LRU | Phase 1 改动 #5 + Phase 3 改动 #1 |
| IMPORTANT#1 S1 缺 token 注入/读取/轮换 spike | ✅ 已修:S1 spike 必须完整闭环验证生成→注入→读取→轮换→已运行容器兼容 | Phase 1 S1 |
| IMPORTANT#2 P3 peerId 回退到裸拼接 | ✅ 已修:Phase 3 改动 #3 明确走结构化 peer.meta(D6),禁止裸拼接 | Phase 3 改动 #3 |
| IMPORTANT#3 notify_user endpoint 冲突 | ✅ 已修:走独立 `/internal/v3/notify-user` endpoint,§4.6 给清晰 SoC 论证 | §4.6 + D8 + Phase 4 #3 |
| IMPORTANT#4 P2 rollback "全 false" 把 text 也关 | ✅ 已修:richMediaEnabled=false 只关富媒体,text 保持 true | §8 回滚矩阵 P2 行 |
| §10.2 D3d 选型答案 | ✅ 已采纳:DB 持久化 token 是 P0 倾向选项,纯 env 标记为劣 | Phase 1 S1 |
| §10.2 P2 对 P1 用户影响 | ✅ 已采纳:richMedia 关 text 不关,默认灰度开启,零回归 | §8 回滚矩阵 P2 行 |
| §10.2 sticky/warm pool / D11 / P3+P4 串行 / R3 UX | ✅ 已采纳 Codex 建议(无 RFC 文本修改,作为 phase 实施期决策依据) | — |

### 10.1c Codex r3 反馈处置状态(本轮新增,已 PASS)

| Codex r3 note | 处置 | 落地位置 |
|---|---|---|
| TL;DR + 架构图说"双向 mTLS 18443" 与 D3b 矛盾 | ✅ 已修:TL;DR 明确双向 transport 不对称,架构图标注 master→container 走 18789 | §0 + §3.1 ASCII |
| pointer schema `binding_id` 应改 `binding_user_id` 对齐 wechat_bindings PK | ✅ 已修:Phase 1 schema 已用 `binding_user_id`,§4.5 三列 P1 / 终态 LRU 区分 | Phase 1 #5 + §4.5 |
| §4.5 仍展示终态 LRU schema 易误导 | ✅ 已修:§4.5 顶部加 Note,标注 lru_stack 是 P3 增量 | §4.5 |
| P1 client_sessions row user_id 必须与 web/internalServerAuthored 一致 | ✅ 已记入 Phase 1 #5 实施提醒(含 `c:` 前缀字节对齐) | Phase 1 #5 |
| §10.2 P1 pointer schema 最小化 | ✅ 已采纳:三列足够 | Phase 1 #5 |
| §10.2 P1 不新增 client_kind enum | ✅ 已采纳:metadata.originChannel='wechat' | Phase 1 #5 |
| §10.2 P4 web push 路径决策延后 | ✅ 已采纳:P4 时再决定,fallback 写会话不主动 push | §4.6 |
| §10.2 P1 验收措辞 | ✅ 已采纳:改"出现在 web 会话列表 + 能看 turn 历史",不要求 deep link | Phase 1 验收 |

### 10.1d Spike S1/S2/S3 完成后的 v4 重写状态(2026-05-14)

| Spike 项 | 调研结论 | RFC 文本变更 |
|---|---|---|
| **S1 D3d 认证** | 复用 master 已有 `bridgeSecret`(`v3supervisor.ts:1614-1621` + `bridgeSecret.ts:31`)HMAC 派生,与 file-proxy `OC_BRIDGE_NONCE` 同型 | D3d 改写为 B'(HMAC 派生);Phase 1 改动 #5 详写注入位置;§4.2 verify 流程更新为 checkInboundBypass |
| **S2 远端 RTT** | Tokyo GCE→boheyun:ICMP 190ms / mTLS 握手 310-470ms / 冷连 600ms / **热连 keep-alive 200-300ms** | §8 R3 替换为实测数字;Phase 1 改动 #12 新增"broker 必须 keep-alive 连接池";D5 sticky session 维持原决策(不上 warm pool) |
| **S3 webchat 帧契约** | **颠覆性**:v3 不存在 webchat bind 帧;`hello` 不建 session;AgentSession 由 `inbound.message` lazy create;telegram + personal-wechat 已用此 contract;`client_sessions` 由前端 PUT 写 | D3c 完全重写(从"模拟 hello/bind"改为"直接构造 InboundMessage + 单独 PUT 模拟");§4.2 inline 流程图重写;R4 重写为 sqlite 两侧一致性;Phase 1 改动 #7 新增 client_sessions 同步具体步骤 |

### 10.2 r3 仍待 Codex 判断的开放问题(本轮新增,r1+r2 已回答的不再列)

1. **P1 sessionPointer 最小化是否真的最小**:目前 schema = `binding_id PK, current_session_id, updated_at`。是否还需要加 `created_at` 或 `last_inbound_at` 字段?(P3 才会用 LRU,P1 阶段是否真需要)
2. **P1 session 创建归属语义**:inbound 抵达 broker 而 pointer 不存在时,master 创建的 webchat-class session 应归属哪个 `client_kind`?候选 (a) `'wechat'` 新增 enum 值;(b) 复用 `'webchat'` 但 metadata 标记 `originChannel='wechat'`。哪个更对仓内既有 session schema?
3. **D8 notify-user endpoint 与 webchat push 路径的具体边界**:P4 实施时 web push 的现有路径是什么?notify-user endpoint 在 channel='web' 时是直接调 `userChatBridge.broadcast()` 还是走另一条 web notification bus?
4. **§7 P1 验收的 master web 端 + wechat session 共视**:`docker exec ... ls SKILL.md` 这条验收只对 P4 有意义,P1 验收里"master web 端打开 = 同一 session 历史"是否过于乐观?有现成的 session id → web 端 URL 的方式吗?
5. **本版还有其他遗漏的设计漏洞吗?**

---

**附录 A: 与个人版的关系**

`packages/channels/wechat` 是个人版/商业版共用 workspace package。本 RFC 的改造对个人版的影响:

- 个人版仍可以"all-in-one"模式跑 wechat(同一进程内 manager + sessionManager.dispatch 直连),broker 只是商业版的额外抽象层
- `manager.ts` 改造引入 `commercial?: { broker?: ... }` 注入点,无 commercial 时维持现有行为
- 个人版 boss 想用 wechat 时:翻 `wechat.enabled=true`,跟以前一样工作

**附录 B: 实施细节预留**

- P1 起头时:先 spike 一下 master ↔ container 的 18443 RTT(boheyun 远端 host 场景下,跨广域网延迟会 >100ms),决定 sticky session 是否需要提前
- P2 起头时:先抓 iLink 协议,确认 sendImage 接口形状;若官方文档可达更佳
- P3 起头时:先做用户调研,问问 boss 偏好"前缀总是显示"还是"仅切换后 10min 显示"

---

**Sign-off**:

- Author: Claude (Opus 4.7), 2026-05-13 → spike + v4 2026-05-14
- Reviewer: Codex (Plan Review) — r1 NEEDS-REWORK ✅ → r2 NEEDS-REWORK ✅ → r3 PASS-with-notes ✅ → **r4 PASS-with-notes** ✅(全 4 轮通过)
- Approver: boss — 2026-05-14 授权"按你的想法来,我只验收成果",P1 实施进行中
