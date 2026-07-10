# v5 管理后台 Aurora 重构 + 告警统一送达(2026-07-10)

boss 需求:①管理后台按用户对话界面的 UI 设计重构,**同一套框架和设计语言**,数据尽可能卡片化、图表化;②全面梳理运维功能和告警功能,让系统运行状态、实时管理更高效;③管理员在企业微信中能及时收到必要的告警。

worktree:`/opt/openclaude/openclaude-v5-admin-aurora-ui`(feat/v5-admin-aurora-ui,基 ad954fcf)。

## 一、现状与根因

**UI**:超管后台=vanilla JS(`packages/web/public/admin.html` 2265 行 + `modules/admin.js` 9662 行,Chart.js UMD),经 gateway legacy 白名单透传(`server.ts:11561-11584`)服务于 `/admin.html`;用户端=`packages/web-react`(React 19 + Vite 8 + Tailwind 4 + Radix)。上一轮(20b56042)只做了 token 级换肤,**框架仍分裂**:两套组件体系、两套图表栈、两套 cache-bust(admin 的 `?v=` 戳在 v5 部署路径不自动执行,是既有裂缝)。

**告警**:两套并行系统,保证等级不对称——
- 系统 A(shell):`v5-monitor.sh`(每 2min 10 项探活)+ `v5-daily-check.sh`(日检)→ 只落 `inbox_messages`(uid=1)+ 日志,**不进 alertChannels,企微收不到**。
- 系统 B(应用内):22 个 EVENTS → `admin_alert_outbox` → 双 dispatcher(shared:iLink/Telegram,gate=controlPlaneEnabled;v5-owned:wecom_bot/wecom_aibot,gate=runtimeChannel)。**零订阅通道时 `enqueueAlert` 直接 skip,不落任何行**(alertOutbox.ts:153-155),告警蒸发;critical 也无 inbox 兜底。
- 小缺口:`health.smoke_failed` 在 v5 声明无发射器;monitor/daily 的 systemd 单元无 `OnFailure=`(监控不自监)。

## 二、方案(最优解,非缝补)

### 2.1 admin 迁 web-react 第二 Vite 入口(同框架同设计语言)

- `packages/web-react/admin.html` 新入口(vite `build.rollupOptions.input` 双入口),`src/admin/` 全新 React 应用,与用户端共享:`components/ui/*` 原语、`styles.css` token、`useTheme`、`lib/api.ts` 的 ApiError/singleflight 刷新原语、chart.js 4.5。
- URL 保持 `/admin.html`(gateway 静态托管天然命中 dist 内真实文件,老书签/肌肉记忆零迁移);页内路由沿用 `#tab=NAME&k=v` hash(深链兼容)。
- **删除整条 legacy 通道**:gateway `legacyAdminStaticPath`/`LEGACY_ADMIN_*`/透传块/`legacyWebRoot` 字段与 cli 装配;删 `packages/web/public/admin.html` + `modules/admin.js`(charts.js/vendor 先 grep 确认无他引再删)。cache-bust 从此统一走 dist 语义(html no-cache + 哈希资产 immutable),`?v=` 戳这类问题在 v5 消失。
- 用户端 `Sidebar` 给 `role==='admin'` 加"管理后台"入口(现状要手敲 URL)。
- 鉴权:admin.html 启动 `api.refresh()`→`getMe`→`role!=='admin'` 跳 `/`(与现状语义一致,不做独立登录)。

### 2.2 页面全量平移 + 卡片化/图表化(21 页,6 分组)

分组/页面/端点以调研清单为准(admin.js `ADMIN_TAB_META` + router.ts 83 条 admin 路由)。设计规范:
- 每页 = PageHeader(标题/描述/主操作)+ KPI StatCard 行(有聚合数据处)+ 图表卡(趋势 line/构成 donut/分布 bar/行内 sparkline)+ DataTable(紧凑密度)+ FilterBar;全部用 ui 原语,禁手写内联样式按钮/输入。
- 原 12 个纯表格页按数据形态补卡片/图表(如 accountGroups 容量构成、egressProxies 状态、plans 档位卡、feedback 状态漏斗、audit 时间线),纯配置页(literature/settings)做表单卡片化即可,不强行上图。
- 图表统一经 `ChartCard`/`useChart` 封装:动态 `import('chart.js/auto')`、CSS token 取色、主题切换重渲染、卸载销毁;30s 轮询统一 `useAdminPoll`(页面隐藏暂停)。
- 移动端可用(sidebar 收纳为 Sheet 抽屉),中文文案,浅深双主题。
- 行为平移以 vanilla admin.js 对应段为权威(各页 agent 精读自己 tab 的实现),操作类(动账/封禁/审核/通道 CRUD)必须功能等价。

### 2.3 告警统一送达(消一类问题)

不变量:**任何告警必有落点,critical 双落点**。
1. `enqueueAlert` 兜底(alertOutbox.ts):fan-out 后若零投递行 → 写 `inbox_messages`(uid=1)兜底行;severity=critical 无论通道是否送达,恒加写 inbox 镜像。消除"零订阅蒸发"与 A/B 保证不对称。
2. 系统 A 汇入统一管道:`v5-monitor.sh`/`v5-daily-check.sh` 在既有 inbox INSERT 之外,直接 SQL 复刻 fan-out(参照 v3 `infra/health-smoke/insert-alert.sql` 模式)写 `admin_alert_outbox`——master 挂掉时行照落,恢复后 dispatcher 补投企微(延迟送达语义正确)。新增事件登记进 `alertEvents.ts`:`ops.monitor_check_failed`(critical/warning 按检查项)、`ops.monitor_recovered`(info)、`ops.daily_anomaly`(warning)、`ops.daily_report`(info)。
3. 监控自监:monitor/daily 两个 service 加 `OnFailure=openclaude-v5-alert-fail@%n.service`,新单元跑极简 psql INSERT(outbox+inbox 双写)。
4. `health.smoke_failed` v5 发射器:deploy-v5.sh smoke 失败路径已 fail-closed(人在场),周期性公网 smoke 由 monitor `public_route` 项覆盖——本条登记为"事件声明保留,发射器由 monitor 事件取代",不另建 v3 式 smoke runner(避免第二套机制)。
5. UI 告警中心(系统运营组):通道管理(含 aibot 连接态/绑定态)、outbox 历史(重试)、静默、规则状态(ack)、覆盖率、测试送达,全量平移 18 条 API。

### 2.4 明确不做(登记)

- 佣金/分销运营面(v5 无此域,boss 未提)。
- 新增 admin API 路由:本轮零新增(现有 83 条足够;route-inventory 基线不动)。
- 企微**用户**消息通道(boss 07-06 暂缓令不变;本轮只完善 ops 告警面)。

## 三、文件所有权(并行实施,严禁交叉写)

- **F(地基)**:`packages/web-react/vite.config.ts`、`admin.html`、`src/admin/{main,AdminApp,router,auth}*`、`src/admin/components/**`(StatCard/ChartCard/DataTable/FilterBar/PageHeader/useAdminPoll/adminApi)、`src/lib/api.ts`(仅加导出)。
- **P1 驾驶舱**:`src/admin/pages/dashboard/**`、`src/admin/pages/users/**`
- **P2 账号与调度**:`src/admin/pages/accounts/**`、`accountGroups/**`、`egressProxies/**`
- **P3 运行资源**:`src/admin/pages/containers/**`、`hosts/**`
- **P4 财务与商业**:`src/admin/pages/{ledger,orders,modelOps,plans,org,modelGrants}/**`
- **P5 用户触达**:`src/admin/pages/{feedback,inbox,marketplace}/**`(marketplace 复用既有 `components/marketplace/ReviewPanel`,只读引用)
- **P6 系统运营**:`src/admin/pages/{literature,settings,audit,health,alerts}/**`
- **B1 告警后端**:`packages/commercial/src/admin/{alertEvents,alertOutbox}.ts`、`scripts/v5-monitor.sh`、`scripts/v5-daily-check.sh`、`deploy/v5/*.{service,timer}`、相关测试。
- **B2 gateway 收尾**(集成阶段):`packages/gateway/src/server.ts`、`packages/cli/src/commands/gateway.ts`、删 `packages/web/public/admin.*`;用户端 `Sidebar.tsx`/`App.tsx` 入口。
- 集成者(主 agent):验收 diff、跑测试、分批 commit。

## 四、测试与验收

- `npm run typecheck` 干净;web-react `npx vitest run --no-file-parallelism`;`test:gateway`/`test:storage`;commercial unit 基线失败集 diff(本树 ⊆ 基线)。
- `vite build` 双入口产物核验(dist/admin.html 存在、assets 共享)。
- admin-route-inventory 基线不变(零新增路由断言)。
- Playwright 浅深双主题截图(代表性页面);移动端宽度冒烟。
- 上线后:企微 aibot 真实测试告警送达;monitor 强制单项失败演练看企微推送;/admin.html 线上全 tab 冒烟。

## 五、生效面预分类(deploy)

master(commercial 告警 + gateway 静态收尾)+ **dist**(web-react 双入口)+ scripts/timer 单元(kl-mirror 手动 cp+daemon-reload,timer 不在 deploy 脚本内)。**无迁移、无 runtime image、无 egress 面**。
