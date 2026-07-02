# v5 全量 cutover 运行手册(boss 发令后执行)

> 当前状态:v5 = ccb 单底座(codex 已彻底删)+ 全新 Aurora React 前端,**灰度上线 + 浏览器 e2e 验证通过**。
> 访问形态:`CF → Caddy:默认→v3 vanilla(现网,零影响)/ X-OC-V5-Secret→v5 React(灰度)`。
> 本手册 = 从"灰度 canary"走到"全量 production(所有付费用户用 v5)"。**未执行任何一步前,现网仍是 v3。**

## ⚠️ cutover 的产品代价(boss 必须明确接受)

1. **gpt-5.5 消失**:v5 是 ccb 单底座,codex/gpt 已彻底删除。现网 gpt-5.5 有真实流量(~154 次/7天)。
   cutover 后这些用户**没有 gpt-5.5**(只剩 claude[OAuth 池现 down]+ glm-5.2/deepseek/minimax 域名模型)。
2. **claude OAuth 账号全 disabled** ~1 月(401/403)。v5 主力靠 glm-5.2/deepseek/minimax(API key)。
   若要 cutover 后提供 claude,需先恢复 claude OAuth 账号。

## 前置条件(cutover 前必须完成)

- [ ] **boss 明确接受 gpt-5.5 移除**(上一节)。
- [ ] **关闭 Turnstile bypass + 验证真实 widget**:v5 env 去掉 `TURNSTILE_TEST_BYPASS=1`(或设 0),
      浏览器实测注册/登录走真实 CF Turnstile 通过(代码已就绪 TurnstileWidget,仅缺关 bypass 后的真实挑战 e2e)。
- [ ] **task#12 v3 channel-aware 重启**(完整双向隔离):把本分支 channel-aware 代码部署到 v3 树
      (`/opt/openclaude/openclaude`)+ 受控重启 v3 → v3 也忽略 v5 容器(其 idleSweep/stopAndRemove/容量计数
      按 channel)。向后兼容,v3 行为不变。需协调"正在改 v3 的另一个 AI" + 定维护窗口。
      (不做的后果:全量后 v3 仍跑,其旧 idleSweep 会清 v5 的 idle 容器[清理本身正常但走 v3 路径]、容量计数偏移;
       非致命但不干净。)
- [ ] **灰度放量策略定**:secret 闸(内测)→ 全量。可选中间档:Caddy 按 user allowlist / 百分比先放一部分。
- [ ] **DR 提醒**:DR=0 无 standby,cutover 前确保共享库已备份。
- [ ] **mutator 归属交接(shared 域)**:见下节「后台 mutator 归属矩阵」。cutover 停 v3 前必须
      把 shared 域 mutator 的执行权移交(要么 v5 放开对应域 + leader 选举,要么保留 v3 实例
      只跑 mutator 不接流量)。**尤其 pendingOrdersExpirer**(markOrderPaid 的价格冻结防线
      明文依赖它)与 finalizeJournalReconciler —— 停 v3 即熄火。
- [ ] **支付回调切流确认**:v5 订单 notifyUrl 已独立(`/api/payment/hupi/callback-v5`,Caddy
      @v5pay 按 path → 18790);cutover 后 v3 侧共享路径 `/api/payment/hupi/callback` 仍需
      保留给存量 v3 pending 订单,直到其全部终态化(60s expirer,最长几分钟)。

## 后台 mutator 归属矩阵(权威源:packages/commercial/src/index.ts schedulerRegistry)

每个后台 scheduler 创建即经 `trackScheduler(name, domain, handle)` 登记(check-schedulers.ts
rule 2 强制),v5 fail-closed 不变量按域断言(shared 域出现在 v5 → 拒启)。

| 域 | 语义 | 谁运行 | 成员 |
|---|---|---|---|
| `shared` | 写共享现网数据(订单/账号池/容器面/邮件) | 仅 controlPlaneEnabled(v3 leader) | lifecycle, idleSweep, volumeGc, orphanReconcile, migrationReconcile, healthPoller, containerEvents, imagePromote, alert, refreshEventsSweep, cooldownRecovery, pendingOrdersExpirer, finalizeReconciler, onboarding, inboxEmail, researchJobs, wechatBroker |
| `v5-owned` | v5 独有数据域(v3 现网树无对应代码) | v5(及 controlPlaneEnabled) | subscriptionRollover(0096:free 月度重置/到期降级) |
| `local` | 纯进程内自愈,无共享副作用 | 所有 channel | accountSlotReaper(slot 租约泄漏回收,防虚假 429) |

隐含假设显式化:**灰度期 shared 域靠"v3 实例活着"代跑**(orders 过期、journal 终态化都由
v3 执行,对 v5 行同样生效)。cutover 时该假设失效,必须按上面前置条件交接。

## 执行(全量 flip)

当前 Caddyfile:`默认 handle → :18789(v3)`;`handle @v5(X-OC-V5-Secret)→ :18790(v5)`。

**flip**:把默认翻到 v5,v3 留 secret 兜底(便于回退/对照):
1. 备份:`cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-cutover.bak`。
2. 改:默认 handle → `:18790`(v5);新增 `handle @v3(header X-OC-V3-Secret 或保留路径)→ :18789` 作回退通道。
   (可用 `scripts/v5-caddy-apply.sh` 的反向版,或手改后 `caddy validate` + `caddy adapt` diff 确认仅默认块翻转。)
3. `systemctl reload caddy`(优雅,不断连);reload 中持续探 `https://claudeai.chat/`(应转 v5 React)+ WS。
4. 烟雾:真实账号登录 v5 React → glm-5.2 对话跑通 + 计费正确;旧 vanilla 经 secret 仍可达(回退对照)。

## 回退(秒级)

`cp /etc/caddy/Caddyfile.pre-cutover.bak /etc/caddy/Caddyfile && systemctl reload caddy` → 默认立即回 v3 vanilla。
(v5 实例不停,数据[共享库]不变;回退仅切流量。)

## cutover 后观察

- v3 现网指标对照(切流量后 v3 应无用户流量,v5 接管);v5 错误率/turn 时延/容器冷启/计费正确性。
- 容器规模(全量用户 → 大量 v5 容器);egress(域名模型上游火山ark/deepseek/minimax 配额)。
- 客户端错误上报(/api/client-errors)+ 帧级 trace(请求ID footer 已上)。

## 已知 production 缺口(非 cutover blocker,可后续迭代)

- IndexedDB 持久已落地(reload 保会话);`getSession ?since` 增量路径已接但需真数据回归。
- admin 控制台本期未 Aurora 重构(仍 admin.html;管理员内部用,UX 割裂可接受)。
- sourcemap 默认产出(可按需关闭不暴露源码)。
