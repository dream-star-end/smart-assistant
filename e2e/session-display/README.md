# 会话展示 e2e 防回归套件（session-display）

针对"会话展示"类回归（静默丢 turn / 重登后大会话白屏 / 终态收敛错位 / 分页死循环 /
重发双回复）建立的 Playwright e2e 硬门。真浏览器（受信事件）驱动，断言基于**用户可见
行为**（卡片文案 / 元素状态 / testid），辅以 API 校验；超时一律轮询、无死 sleep。

行为契约来源：`docs/rfcs/RFC-v5-durable-turn-dispatch.md` §1/§4/§5/§9。选择器/契约地图见
本目录 `SELECTORS.md`（写 spec 的唯一依据）。

> 独立依赖域：本套件在 `e2e/session-display/` 自带 `package.json` + `node_modules`，
> **不动仓库根 node_modules**，不进 root workspaces。浏览器复用机器上的 ms-playwright
> 缓存（`@playwright/test@1.60` → chromium-1223，已缓存，安装/运行均免下载）。

## 用例清单

| # | spec | 说明 | tag | 依赖 |
|---|------|------|-----|------|
| 1 | `01-login-relogin-display` | 登录→建会话→发消息收回复→登出→重登→列表含该会话+打开消息完整（user/assistant 行齐、顺序对） | `@smoke` | 真 turn |
| 2 | `02-large-session-open` | 大会话打开首屏可交互 < 3s；超预算卷折叠卡出现+可展开 | `@smoke` | **§9**（未部署→skip） |
| 3 | `03-reconnect-inflight` | 发消息后立即断 WS→恢复→回复到达 **或** 明确失败卡+重试；**绝不永久静默** | — | 真 turn |
| 4 | `04-terminal-reconcile` | 回复中途刷新页面→终态正确收敛（spinner 不永挂；回复/失败卡二选一） | `@smoke` | 真 turn |
| 5 | `05-error-projection` | 注入 terminal(not_accepted)+active projection→"消息未开始处理/已确认未计费"卡+重试；revoked 不显示 | — | **§9 + DB 注入**（否则 skip） |
| 6 | `06-archive-paging` | 归档逐页拉取：无重复行 / 空页不谎报 hasMore / 游标严格递减 / 有限步终止 | — | 无（负例亦可自验） |
| 7 | `07-resend-dedup` | 同 clientMessageId 协议级双发→不出双回复、不双计费（服务端幂等 `web:<cmid>:0`） | — | 真 turn(WS) |

`@smoke` 子集（1/2/4）供部署门用：`./run.sh --grep @smoke`。用例 2 未部署 §9 时自动 skip，
不会把 smoke 门判红。

## 环境矩阵

目标环境**全部经 env 注入**，零硬编码账号密码。套件从部署发起机运行，经 ssh 隧道访问
远端 master（远端无浏览器）。

| 变量 | 默认 | 说明 |
|------|------|------|
| `OC_E2E_BASE_URL` | —（隧道模式自动设） | 直达 HTTP 根；设了就**不建隧道** |
| `OC_E2E_SSH_HOST` | `kl-hk` | 隧道目标主机（预发） |
| `OC_E2E_REMOTE_PORT` | `18795` | 远端 app 端口（kl-hk 预发直达 app=18795；生产 kl-mirror=18790） |
| `OC_E2E_PASSWORD` | — | 账号密码（优先）；或 `OC_E2E_PASSWORD_FILE`（本地文件） |
| `OC_E2E_PW_HOST` | `kl-mirror` | 密码单一权威主机（经 ssh 读 `/root/.secrets/v5-canary.password`） |
| `OC_E2E_EMAIL` | `v5-canary@claudeai.chat` | canary/预发专用账号（**绝不用真实用户**） |
| `OC_E2E_TURNSTILE` | `bypass` | bypass 环境占位串（AuthGate `BYPASS_TOKEN` 同值） |
| `OC_E2E_MODEL` | `gpt-5.6-sol` | turn 模型；可换更快模型加速 |
| `OC_E2E_TURN_TIMEOUT` | `120000` | 单轮回复上限 ms |
| `OC_E2E_TTI_BUDGET_MS` | `3000` | 用例 2 首屏可交互预算 |
| `OC_E2E_PG_URL` | — | §9 注入/种子 PG 连接串（**仅预发**）；缺省→用例 2/5 skip-with-reason |
| `OC_E2E_SECTION9` | — | 无 PG_URL 时，`=1` 显式声明 §9 已部署以放行用例 2 的 seed 路径 |
| `OC_E2E_PG_USER_ID` | `c:<numericUserId>` | §9 注入时 `client_sessions.user_id` 形态覆盖 |
| `OC_E2E_RETRIES` | `0` | flake 容忍（部署门建议 1） |

### 目标环境现状（2026-07-18）

- **kl-hk 预发**：运行 `rel-b10fb176`（07-13，**pre-durable-turn**），且**无 canary 账号**。
  跑预发前需：①部署本批（含迁移 0170）；②在预发 PG（15433）种一个 canary 账号并用
  `OC_E2E_PASSWORD` 注入；③如需 §9 用例，隧道预发 PG 后设 `OC_E2E_PG_URL`。
- **kl-mirror 生产**：canary 账号可用（与部署 smoke/journey 门同账号），app=18790。自验就是
  打这里（§9 尚未上生产 → 用例 2/5 skip）。

## 运行

```bash
cd e2e/session-display
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install     # 首次；装进本目录 node_modules

# 默认打 kl-hk 预发（需预发已具备账号/§9，见上）
./run.sh

# 只跑 smoke 子集（部署门）
./run.sh --grep @smoke

# 打生产 canary 自验
OC_E2E_SSH_HOST=kl-mirror OC_E2E_REMOTE_PORT=18790 ./run.sh

# 跑单条
./run.sh 03-reconnect-inflight.spec.ts

# 已有直达地址（不建隧道）
OC_E2E_BASE_URL=http://127.0.0.1:18790 OC_E2E_PASSWORD=… ./run.sh
```

`run.sh`：校验依赖 → 建隧道（或直达）→ 读密码 → 隧道就绪轮询 → 串行跑 → 汇总
PASS/FAIL/SKIP + skip 原因。报告落 `reports/html/index.html`（`npm run report` 打开）、
`reports/results.json`。

## 数据安全与清理

- 只用注入的 **canary/预发专用账号**，断言全部作用于该账号自己的会话（鉴权分租），
  `setOffline`/`reload` 只影响本浏览器页，对服务端与他人零影响。
- 种子会话一律 `e2e-` 前缀（`OC_E2E_SESSION_PREFIX` 可改），每条用例注册 `track()`
  → 结束自动 `DELETE`；§9 注入额外 `cleanupSeed()` 清 dispatch/projection。

## 接部署门（建议接线点）

`@smoke` 子集是硬门候选，与既有两道门互补：
- `scripts/v5-smoke-turn-canary.mjs`（WS 三信号）——协议层；
- `scripts/v5-e2e-journey-canary.mjs`（附件/目标旅程）——UI 交互层；
- **本套件 `@smoke`**——会话**展示/持久化/重连收敛**层（既有门的盲区）。

推荐接线（`v5-commercial-deploy` 部署后 smoke 阶段，参照 journey canary 的失败语义）：

```bash
# 部署机上、部署后 smoke 阶段
( cd e2e/session-display && OC_E2E_SSH_HOST=kl-mirror OC_E2E_REMOTE_PORT=18790 \
    OC_E2E_RETRIES=1 ./run.sh --grep @smoke )
# 退出码非 0 = 门失败。第一期建议 fail-loud **不进自动回滚链**（UI 断言有文案/选择器
# 漂移的假阳性面，与 journey canary 同档），跑稳（连续两周零假阳性）后再升级进
# validation_failure 链。紧急豁免用显式开关（不默认关）。
```

落到 §9 上线后的预发回归：部署预发（含 0170）→ 隧道预发 PG 设 `OC_E2E_PG_URL` →
`./run.sh`（用例 2/5 转为真跑）。

## 维护须知

- 关键节点已在 `packages/web-react` 补 `data-testid`：`user-row` / `assistant-row` /
  `message-text`（user 气泡）/ `collapse-card`（§9 折叠卡）。assistant 正文仍走既有稳定
  `.prose`（避免侵入共享 `Markdown` 组件）。改这些组件时保持 testid。
- 文案类断言（错误卡"消息未开始处理/已确认未计费"、折叠卡"本轮完整输出…"）来自 §5/§9
  契约；前端改文案需同步 `lib/ui.ts` 的 `TEXT`/选择器。
- §9 DB 注入（`lib/seed.ts`）依据迁移 0170/0147/0134 的 schema，**尚未在 §9 环境实跑
  校验**；§9 落预发后按实际 schema 复核 seed（用例会 skip-on-seed-failure，不制造假失败）。
