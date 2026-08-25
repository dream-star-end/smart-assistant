# V5 selfhost — Claude 订阅号反封运维手册

面向把 Claude Code(CCB)订阅号加入账号池的运维。目标:让每个订阅号在 Anthropic
侧的画像尽量贴近"一个真人用官方 CLI",避免命中 2026 年起针对第三方 harness /
共享代理 / 规避限额的自动风控。

背景复盘(2026-08):订阅号"加一个封一个"的根因是把订阅号当 API 池用,同时:
① 客户端指纹伪装成 SDK 而非官方 CLI;② 多号共用同一出口 IP;③ 单号高并发 +
把限流当故障狂重试。前两类是运维动作能控的,第三类已在代码侧收敛。

## 一、代码侧已落地的措施(随本次发布生效)

| 项 | 效果 | 可调项 |
|---|---|---|
| 真实 `claude-cli/<ver>` UA + `x-app: cli` | 上游看到的是官方 CLI 画像,不再是 SDK | 升级 CCB 时同步 `persona.ts` 里 `CCB_CLI_VERSION` / `CCB_SDK_VERSION` |
| persona 版本锚定实际二进制 | 不再伪造一批不存在的旧版本 | 同上 |
| persona 缺失 fail-closed | 绝不落 undici 默认指纹 | — |
| 上游 429 透传为 429 + Retry-After | 客户端按限流退避,不当故障重试 | — |
| 容器 `CLAUDE_CODE_MAX_RETRIES=2` | 封顶重试放大 | `v3supervisor.ts` env |
| 容器 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | 关旁路遥测,出口形态单一 | 同上 |
| `session_pin_mode=enforce`(默认) | 一会话粘一号,消除多 account_uuid 关联 | `PUT /api/admin/settings/session_pin_mode` = `observe`/`off` 可回退 |
| persona 按 `accept_language` 映射时区 + 代理改写 body 本地日期 | 上游看到的"今天日期"与账号语言/地域自洽 | 升级映射见 `persona.ts` `ACCEPT_LANGUAGE_TIMEZONE` |

> 时区说明:CCB 会把本地日历日期(`Today's date is …`)写进发往 Anthropic 的
> messages。旧部署把 CCB 进程钉 `Asia/Tokyo`(为已废弃的日本旁路出口),与账号
> 语言/住宅 IP 地域对不上。现在代理按每账号 `persona.timezone`(跟 `accept_language`
> 一致)改写这个日期,所以**加号时选的住宅 IP 地域,尽量和 persona 语言/时区同区**
> (en-US→美东、zh-CN→上海、ja-JP→东京、en-GB→伦敦、de-DE→柏林),三者才完全自洽。
> 残留:WebSearch 工具提示里的"当前月份"仍按容器 TZ,信号弱,暂未改写。

`session_pin_mode` 若需先观察再全量,可临时切 `observe` 跑 1~3 天看
`session_pin_observe` 日志的 divergent 占比,再回 `enforce`。

## 二、运维侧必须遵守(C2:养号 + 地域一致性)

代码只能把"技术指纹"做干净;下面这些是账号本身的合规画像,必须人工保证。

### 1. 一号一独立住宅 IP(强烈建议,当前未在 schema 强制)

- 每个订阅号绑一个**独立**的住宅/家宽出口(`egress_proxy_id`),不要多号共用一个 IP。
  "同一 IP 上挂多个 Max/Pro"是号商的典型信号。
- IP 要**地域稳定**:不要频繁跳区、不要数据中心 IP、不要频繁换 VPN 节点。
- schema 目前允许多号共用一个 `egress_proxy_id`(历史为复用住宅 IP 设计),所以这条
  靠运维纪律保证;后续可加 `UNIQUE(egress_proxy_id) WHERE provider='claude'` 固化。

### 2. 养号:新号低频预热

- 新号加入后**先低频用几天**(每天少量真实对话)再逐步上量,不要一进池就打高并发。
- 避免"注册当天 / 刚续费 / 刚改付款方式"就立刻上高负载 —— 付款变更叠加异常活动是
  已知的误封触发点。

### 3. 地域一致性

- **注册地域、付款地域、出口 IP 地域尽量一致**。三者冲突(如账号注册地 A、付款卡地 B、
  出口 IP 地 C)会被风控当高风险。
- 出口 IP 所在区必须是 Anthropic 支持区;不要用不支持区(如中国大陆)直连的 IP。
- 付款方式:避免虚拟卡 / 预付卡 / 频繁更换付款方式。

### 4. 不要做的事

- 不要多个真人共享同一订阅号。
- 不要为绕限额在多个号之间来回切(enforce 已在会话内阻止静默切号)。
- 不要把订阅号当对外转售 / 多租户 SaaS 的公共池。这类用途请改用 Anthropic Console
  API key(按量计费,不受订阅风控)。

## 三、加号后自检清单

1. 该号 `egress_proxy_id` 指向一个**未被其它 claude 号占用**的住宅代理。
2. 出口 IP 地域 = 账号注册/付款地域,且在支持区。
3. 先低频跑一两天,观察 `claude_accounts` 的 `health_score` / `fail_count` /
   `last_error` 无异常增长。
4. 若被限流:看到的是正常 429 + Retry-After(退避),不是账号被 disable。
   `status='disabled'` 或收到"account disabled after automatic review"才是被封,
   此时**不要**立刻新建号顶上(会被判定 ban evasion),先走官方申诉。

## 四、灰区提示

自建网关聚合订阅号本身处于 Anthropic 消费者条款的灰区。上述措施把技术与画像风险
压到最低,但不能把"违反条款"变成"合规"。对高频 / 自动化 / 多用户并发的流量,
最稳的兜底仍是切 Console API key。
