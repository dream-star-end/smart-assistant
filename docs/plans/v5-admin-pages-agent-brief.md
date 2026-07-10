# v5 admin 页面组 agent 共享作业规范(P1-P6)

工作树 `/opt/openclaude/openclaude-v5-admin-aurora-ui`(feat/v5-admin-aurora-ui)。**不要 git commit;不要 npm install;只改自己名下 `packages/web-react/src/admin/pages/<key>/**` 目录**(替换地基放的 stub `index.tsx`,可在自己目录内自由加文件)。registry.tsx/AdminShell/components/lib 归地基所有,只读;发现地基缺口写进报告,勿自行改。

## 行为权威
旧版 vanilla 实现 = 行为平移权威:`packages/web/public/modules/admin.js`(9662 行)。**精读自己 tab 的段落**(锚点:`TABS` 注册 :412,`ADMIN_TAB_META` :436;各 tab `*_STATE` 常量:DASH 699/USERS 1445/ACCOUNTS 2556/EGRESS_PROXY 3446/CONTAINERS 3658/LOGS_MODAL 3952/LEDGER 4015/ORDERS 4317/MODEL_OPS 4629/ORG 5416/MODEL_GRANTS 5776/FEEDBACK 5950/HEALTH 7423/ALERTS 7735/HOSTS 8951;其余 tab grep `render<Name>Tab`)。操作类功能(动账/封禁/审核/CRUD/导出)必须功能等价;展示类允许按下述设计规范重组升级。后端 API 一律用现有 `/api/admin/*` 端点,**零新增路由**;参数/响应形状以 vanilla 调用处 + `packages/commercial/src/http/` handler 为准,拿不准就读 handler。

## 地基用法(先读 `src/admin/components/index.ts`、`src/admin/lib/`,再看 `src/admin/__tests__/` 的既有测试模式)
- 导入:`import { PageHeader, StatCard, StatCardRow, ChartCard, useChart, lineConfig, barConfig, donutConfig, sparklineConfig, DataTable, Pagination, FilterBar, SearchInput, SelectFilter, RangePreset, SectionCard, KeyValue, CopyChip, TimeAgo, LevelBadge } from "../../components"`;UI 原语 `import { Button, Badge, Modal, Sheet, Tabs, Input, Switch, EmptyState, useConfirm, usePrompt, useToast, ... } from "../../../components/ui"`。**禁止手写内联样式按钮/输入,一律用原语**。
- 数据:`adminGet<T>('/stats/dau', { window:'7d' })`(相对路径自动前缀 `/api/admin`)、`adminSend('POST','/users/:id/credits',{...})`、CSV 用 `adminText`;错误统一 `ApiError`。
- 轮询:`useAdminPoll(() => adminGet(...), { intervalMs:30000, deps:[...] })`(隐藏暂停/切回补拉/在飞废弃)。仅原版有自动刷新的 tab 用(dashboard/hosts/accounts/health/pricing 30s);其余首载+手动刷新。
- 图表:`useChart(ref, theme => lineConfig(theme, {...}), [data])` + `<ChartCard>`;颜色自动走 CSS token,主题切换自动重绘。

## 设计规范(卡片化/图表化)
- 页面骨架:`PageHeader`(标题/描述/右侧主操作)→ KPI `StatCardRow`(有聚合数据处)→ 图表卡 → `FilterBar` + `DataTable`(+`Pagination`,后端 offset/limit)。
- 图表选型:趋势=line,对比/分布=bar,构成(≤6 类)=donut,行内趋势=sparkline。**只给有数据形态价值的地方上图**,纯配置/表单页做卡片化分区(SectionCard)即可,不硬凑图表。
- 破坏性操作(删除/封禁/动账/下架)必须 `useConfirm`/`usePrompt` 确认,结果 `useToast` 反馈;加载态骨架,空态 `EmptyState`;详情用 `Modal` 或 `Sheet`(信息多用 Sheet)。
- 全中文文案(沿用旧版措辞);数字 tabular-nums(StatCard 内置);时间用 `TimeAgo`;severity/status 用 `LevelBadge`/`Badge`。
- 移动端可用:表格外层容器横向滚动(DataTable 内置),卡片栅格响应式;不做桌面独占布局。

## 测试与验证(实跑,报告贴结果)
- 每页至少:渲染冒烟(mock adminApi:`vi.mock("../../lib/adminApi", ...)`,模式参照 `src/admin/__tests__/adminApi.test.ts` 及组件测试)+ 关键交互 1-2 条(过滤/确认弹窗/动作调用了正确端点)。测试放自己 `pages/<key>/__tests__/` 下。
- 跑:`cd packages/web-react && npx vitest run --no-file-parallelism src/admin/pages/<key>`(**必须 --no-file-parallelism**)。
- 类型:集成者统一跑 tsc 把关;你可自查 `npx tsc -b`(可能与并行 agent 争用 tsbuildinfo,失败重试一次即可,别恋战)。

## 报告要求
文件清单(含行数)/ 与 vanilla 的功能对等清单(逐功能 ✅/裁剪注明理由)/ 用到的端点 / 测试实跑结果 / 发现的地基缺口或后端形状与预期不符之处。
