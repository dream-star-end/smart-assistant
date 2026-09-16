# settings · 设置中心 / ChatGPT 直连 / 组织中心 / 支付 · 归档摘要

> 正文：[`docs/audit/settings.md`](../settings.md)（模块负责人维护；本文只做摘要与索引，不复制原文）。
> 任务：t-40「A·settings 审计」→ t-41「B·settings 修复」→ t-426「补丁①·settings ConnectorsTab 承接 manage M-09/18/20/21 等」→ t-628「二期·settings 遗留 P3 收尾」（已完成）。
> 分支 `feat/v5-selfhost-audit-settings`，HEAD `5eac1b807`，基线 `210b9967`（补丁①起合入过 integration `43b7cd3a4`）。
> 集成：settings-B + 补丁①（@`c0efc9c91`）由集成② `5e5ed6925` 合入；二期 `8b2636e94`…`5eac1b807` 待集成③。

## 1. 审出问题（P1 0 / P2 12 / P3 31，共 43）

| 严重度 | 编号与要点 |
|---|---|
| P2 | SET-01 续费 / 切换无确认直接下单 · SET-02 静态快捷键分区误挂偏好加载态 · SET-03 全 0 数据仍画假坐标轴 · SET-04 未绑看板时用量被 `blocked` · SET-05 Telegram 死开关 · SET-06 移动端统计卡断字 · SET-07 表格状态列竖排 · SET-08 移动端浏览器引导 Tab 截断 · SET-09 组织充值到账积分不可核对 · SET-10 承诺不存在的组织改名 · SET-11 多处触控 < 44px · SET-12 admin 7 分区窄屏孤项 |
| P3 | SET-13 进度条语义与文字相反 · SET-14 低余额三重 CTA · SET-15 红卡硬编码套餐价格 · SET-16 未知 reason 裸露 · SET-17 收支趋势同轴 · SET-18 到期日期折行 · SET-19 免费档「—」无解释 · SET-20 Windows 显示 ⌘ · SET-21 原生 select · SET-22 通知开关无 hint · SET-23 复制失败无提示 · SET-24 输入法回车误建密钥 · SET-25 明细状态裸露后端码 · SET-26 「(未知)」术语不一致 · SET-27 三份 Stat 卡 · SET-28 上限只变红无文字 · SET-29 时间格式不统一 · SET-30 ASCII 标点 · SET-31 二维码无 onError · SET-32 双份轮询 · SET-33 多余空格 · SET-34 向导空洞 · SET-35 步骤指示消失 · SET-36 「可安装」也用 ✓ · SET-37 uppercase 改写术语 · SET-38 成员行信息丢失 · SET-39 成员列表无搜索分页 · SET-40 禁用开关无解释 · SET-41 单分组仍渲染标题 · SET-42 关于页无版本 / 更新检查 · SET-43 死代码 |

→ 逐条定位与截图见正文 [§3 问题清单](../settings.md#3-问题清单)；不修 / 暂缓项见 §5。

## 2. 修复情况（P2 12/12 · P3 29/31 → 二期后归属内 100% 处置）

| 提交 | 内容 | 覆盖编号 |
|---|---|---|
| `32804b476` | 壳层与偏好分区按审计落地 | SET-02/05/12/20/21/22/23/41/42 |
| `d3201a8a8` | 用量 / API 接入统一统计卡与状态文案 | SET-03/04/06/07/11/24/25/26/27/28/30/37 |
| `a8f1d93ca` | 计费与支付按审计落地 | SET-01/13/14/15/16/17/18/19/31/43 |
| `df6b2c106` | 组织中心按审计落地 | SET-09/10/11/21/30/33/34/35/36/38/39/40 |
| `5bce50f48` | ChatGPT 直连移动端 Tab 与时间格式 + 修复记录 | SET-08/29/30 |
| `138accab4`（补丁①） | `ConnectorsTab` 承接 manage M-09/18/20/21（窄屏动作簇下沉、accountHint 去重、目录降级可见、备注名失焦提交） | manage M-09 M-18 M-20 M-21 |
| `9582b5eb5`（补丁①） | `manage/CronPanel.tsx` Telegram 投递项随 SET-05 收口 | SET-05 跨模块余项 |
| `091a1a7bb`（补丁①） | `lib/chat/pure.ts` 红卡余额不足文案去手抄价格并全角标点 | SET-15 跨模块余项（messages 归属，指挥官授权） |
| `8b2636e94`（二期） | 关于页「检查更新」行（SET-42 ②）/ 备案占位不渲染 / 会话用量分页去重 | SET-42 ②、§5 两项 |

- 阶段 B 不修 2 条：SET-32 双份轮询（判据：整页重载时弹层已卸载、bfcache 恢复时恢复条不重读，两者不会并存，已写进代码注释）；SET-42 ②「检查更新」当时判为 shell 归属 → 二期以只读 `fetchServerBuild()` + `appUpdate.reloadNow` 落地。
- 二期 t-628：遗留表 11 项全部处置——归属内可独立完成 4 项（SET-42 ②、备案占位、分页去重、SET-14 免费用户买加量包判定关闭）4/4；需后端 2；跨模块 2；不修 3。

→ 正文 §6 修复记录、§8 补丁①、§9 二期。

## 3. 验证摘要（工作树 `wt\settings`）

| 门 | 阶段 B | 补丁① | 二期（HEAD `8b2636e94`） |
|---|---|---|---|
| `npm run typecheck --workspace packages/web-react` | ✅ | ✅（合并后、三处改动后） | ✅ exit 0 |
| 模块 vitest | ✅ 19 文件 / 215 例 | ✅ 涉及目录 52 文件 | ✅ 21 文件 |
| 全量 `npm test` | ✅ 绿 | — | ◐ 289 文件（失败为基线项，见正文 §9.3） |
| `npx biome lint` | 与基线逐文件对比未新增诊断 | 同左 | 新增 0 |
| `npm run typecheck:preview` | — | ⚠ 2 处红，均为他人存量场景 | ⚠ 同补丁① |
| after 截图 | ✅ 27 场景 / 108 张，failures 0 | ✅ 9 场景 | ✅ after-2 2 场景 / 8 张（含新增 `settings-about-update-check`） |
| `npm run test:browser` | —（未触碰高频交互面） | NOT RUN | NOT RUN |

→ 正文 §7 验证、§8.2、§9.3。

## 4. 遗留与理由

| 项 | 分类 | 理由 |
|---|---|---|
| SET-09 组织充值汇率预估 | 需后端配合 | `POST /api/org/topup` 契约无汇率 / 预估字段，需 `GET /api/org/plans` 下发 `credits_per_yuan`；前端已做填额说明 + 到账实际入账数 |
| SET-10 组织改名 | 需后端配合 | 无 `PATCH /api/org {name}`；文案已不再承诺 |
| `ConnectorsTab` / `KnowledgePlanetAutomationPanel` 目录迁移 | 跨模块（manage 决定） | 文件在 `components/settings/` 但只被 ManageCenter 使用，迁移牵动 manage import 与场景 |
| 备案号真值 / `brand` 字段 | 跨模块（shell `lib/brand.ts`）| 运营填值即可；关于页已按 `hasIcpNumber()` 条件渲染 |
| SET-32 双份轮询 · Auto-Dream 卡片文案 · `ApiKeysSection` 深链含密钥 | 不修 | 有判据 / 产品决策 / CC Switch V1 协议要求 |

→ 正文 §6.3、§9.1。

## 5. 分支 / 提交

- 分支 `feat/v5-selfhost-audit-settings` @ `5eac1b807`（基线 `210b9967`，自有提交 14 个，49 files / +3760 −966 相对 `43b7cd3a4`）
- 阶段 A：`82c0f80f1` 审计报告 + `scenes-settings.tsx`
- 阶段 B：`32804b476` `d3201a8a8` `a8f1d93ca` `df6b2c106` `5bce50f48`
- 补丁①：`dc99a93ca`（合入 integration `43b7cd3a4` 对齐基线）`138accab4` `9582b5eb5` `091a1a7bb`；文档 `c0efc9c91`
- 二期：`8b2636e94`；文档 `c5070e1ee` `5eac1b807`
- 集成：`5e5ed6925`（集成②，@`c0efc9c91`）；二期待集成③
