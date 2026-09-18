# v5 个人版审计 · 终审导读（30 分钟版 · t-897 阶段①草稿，2026-09-18 21:xx）

> 读法：§1 一分钟看结论 → §2 改了什么 → §3 为什么这样改 → §4 怎么验的 → §5 还剩什么风险 / 需要你拍板的 → §6 发布线现状（预留）。每条都给出树内文件路径（相对本目录）或仓外截图 / 日志路径（`D:\code\test_project\test123\.audit-tmp\…`，PNG 不入库）。想看全表去 [SUMMARY.md](./SUMMARY.md)，想看某模块的每一条去 `archive/<slug>.md` → `<slug>.md`。
> 状态：**集成⑤（t-1237）/ 发布准备（t-1268）/ 发布执行（t-1269）尚未验收闭合，本页 §6 为预留，阶段② 填齐后替换本行为「已上线 / 未上线」。**

## 1. 一分钟结论

| 问 | 答 | 出处 |
|---|---|---|
| 审了什么 | v5 个人版（selfhost）`packages/web-react` 用户端 12 个模块 + 4 个补审专项（HUD 任务列表 / 知识星球自动回复 / `?demo=1` 与选项组 / PermissionCard）+ a11y 专项，按 UI / 响应式 / 交互反馈 / 功能正确性 / 可访问性 / 文案 / 代码质量七项清单 | [SUMMARY.md §2](./SUMMARY.md) · `TEAM_PLAYBOOK.md` §5（仓外） |
| 审出多少、修了多少 | 12 模块 **359 条**（P1 8 · P2 108 · P3 243），**P1 8/8 关闭，P2 按各模块正文声明全部落地**（shell 2 条设计取舍等你拍板），P3 能在本模块内独立完成的都做了，没做的每条有归属与理由；专项另审出 HUD 20 / 知识星球 19 / 杂项 18 / PermissionCard 17 / a11y 35 + 同源项 13，同口径处置 | [SUMMARY.md §1 / §3](./SUMMARY.md) · [archive/README.md](./archive/README.md) |
| 代码在哪 | integration 分支 `feat/v5-selfhost-ocv5-audit-ux` @ **`aeae1d72e`**（集成①–⑤ 37 个 `--no-ff` 合并 + canonical `f1952819f` 合入），远端 = 本地；**尚未 push 到 canonical `feat/v5-selfhost`，服务器未部署** | [SUMMARY.md §9](./SUMMARY.md) |
| 门过了吗 | 集成⑤ 源码态 `91358ce54`：typecheck / `typecheck:preview` / `check:tutorials` ✅ · **`build` 首屏 gzip 447.8KB < 460KB ✅**（集成④ 时 471.4KB ❌，两次修复转绿）· `npm test` **305 文件 / 4306 例全过** · 真浏览器 `run.mjs` 68/68 + `node --test` 85/87（2 红 = 基线）· biome 新增 0；**未跑**：集成⑤ 全量截图 + a11y 复扫（下半场，集成④ 时 301 场景 1026 张 / 复扫 0 回归） | [INTEGRATION.md 集成⑤ §5](./INTEGRATION.md) · [SUMMARY.md §8](./SUMMARY.md) |
| 独立复核过吗 | QA 五轮（第二双眼睛）：核对 37 / 84 / 61 / 58 项 + 集成④ 终点三道门独立实跑与状态单 24/24，累计 ❌ 3 处全部已处置，新增阻断 0 | [archive/qa.md](./archive/qa.md) · [qa/qa-integ4.md](./qa/qa-integ4.md) |
| 需要你确认什么 | ① 四笔教程同步快照 accept（§5-1）② 2 条基线红要不要顺手修（§5-2）③ 设计取舍 / 产品口径项（§5-4）④ 后端配合项要不要另开专项（§5-5）⑤ 发布前是否叫停（§6） | 本页 §5 / §6 |

## 2. 改了什么（按用户可感知的面）

| 面 | 代表性改动（每模块 3 条以内） | 全表 |
|---|---|---|
| 壳层 / 设计系统 shell | 桌面端 `⌘K` 不再把整页点死（按视口分流）；Esc 归弹层不再掐掉生成中回合；Button / Chip 触控 44px、语义色对比度守卫、主题跨标签同步；a11y 令牌层 `-fg` / `--faint` / hljs / placeholder / `<time>` / Modal·Sheet 焦点；新增 `ui/Checkbox` 原语；首屏预算修复（覆盖层 `React.lazy`） | [archive/shell.md](./archive/shell.md) · [archive/a11y.md](./archive/a11y.md) · [archive/leftover.md](./archive/leftover.md) |
| 消息 / 输入区 messages · composer | 只读面死按钮、触屏动作行折叠、宽表不拆词、流式光标内联；两行式输入区、语音状态播报、草稿超限预警、排队发送、模型切换中态、目标对话框并发保护 | [archive/messages.md](./archive/messages.md) · [archive/composer.md](./archive/composer.md) |
| 侧栏 / 任务面板 sidebar · taskboard | 重命名 / 删除 / 加载更多失败不再静默、项目列表失败自动重试、拖宽把手键盘可调、项目范围深链冷启不回落；P1「切换 projects/agents 数据丢失」修复，看板 / 列表 / 抽屉 P2 14/14 | [archive/sidebar.md](./archive/sidebar.md) · [archive/taskboard.md](./archive/taskboard.md) |
| 管理 / 设置 / 市场 manage · settings · market | P1 `cronBlocked` 误渲染空态收口、`cronHuman` 星期 / 小时区间；用量 / API 接入 / 计费 / 组织中心 / ChatGPT 直连移动端 Tab；P1「发布草稿关弹窗无提示丢失」落盘、审核面 / 发布页 checkbox 走原语、备案判据与法务页同源 | [archive/manage.md](./archive/manage.md) · [archive/settings.md](./archive/settings.md) · [archive/market.md](./archive/market.md) |
| 工具卡 / 媒体 / 落地页 / 教程 tools · media · landing · tutorials | P1 Grok 输出归一化只对原生名生效；图片查看器子模式、视频任务中心危险操作确认、容器预览 Esc 分层；登录 / 注册占位符不复读标签、页脚触控 44px；功能参考一级入口、教程深链 `tab= / work= / topic=&step=`、模块级 hero token、22KB 死代码删除 | [archive/tools.md](./archive/tools.md) · [archive/media.md](./archive/media.md) · [archive/landing.md](./archive/landing.md) · [archive/tutorials.md](./archive/tutorials.md) |
| 补审专项 HUD · 知识星球 · 杂项 · PermissionCard | 后台任务失败原因可见、父轮结束后「停止本轮」收起；P1「同意并开启」失败错误就地报错 + 1–30 校验；首帧点选不再隐式发送、流式结束点选不丢（根因 `MarkdownImpl` 每次渲染新造渲染器）；审批卡待决摘要、选项组方向键 / 校验播报、过期 fail-safe | [archive/hud.md](./archive/hud.md) · [archive/kp-automation.md](./archive/kp-automation.md) · [archive/misc-p3.md](./archive/misc-p3.md) · [archive/permission-card.md](./archive/permission-card.md) |
| 可访问性 a11y | 硬编码白字 → `text-accent-fg / danger-fg`、浅色代码高亮 ≥ 4.8:1、全站 placeholder、无名控件补名、触控 44px、opacity 改实色；合入态复扫 257 共同场景：浅色对比命中 356 → 44、深色 111 → 69、触控 <44 493 → 163、无名控件 16 → 11，逐场景回归 0；a11y-C 把「白字压 accent / danger」类命中 4 → 0 | [archive/a11y.md](./archive/a11y.md) · `.audit-tmp\integration\a11y-integ4\report.md` |

看图：集成④ 全量 1026 张 `.audit-tmp\integration\shots-integ4\`（每场景 desktop / mobile × light / dark）；各模块 before / after `.audit-tmp\<slug>\{before,after}\`；QA 抽样 `.audit-tmp\qa-integ4\shots\`（52 张，含 `shots-review.md` 逐张结论）。

## 3. 为什么这样做（口径）

- **两阶段流**：先出审计文档（问题清单 + 修复计划）→ 指挥官评审 → 再改代码配测试 → 集成 → QA 独立复核；P1 / P2 必修，P3 量力而行并登记遗留（[SUMMARY.md §2](./SUMMARY.md)）。
- **不越界**：文件归属表 + 写锁；跨模块需求走 owner 或集成轮接线；确实越界的机械改动逐条单列（[SUMMARY.md §7-4](./SUMMARY.md)）。
- **证据先于结论**：截图台（真组件 + 真 CSS + 真 Chromium）before / after 各一套；a11y 用 CDP AX 树量化；每条声称定位到 file:line + 用例；未跑的一律标 NOT RUN。
- **发布不冒进**：首屏 gzip 预算门（460KB）两次红两次修，阈值不动；canonical 上游 7 提交先在预演分支试合、7 处冲突写成可重放解法，再在 integration 重放（[RELEASE.md §1.2 / §3.1b / §3.1c](./RELEASE.md)）。

## 4. 怎么验的（你可以自己复跑的）

| 门 | 命令（工作树根） | 最近一次结果 | 日志 |
|---|---|---|---|
| 类型 | `npm run typecheck --workspace packages/web-react`；`npm run typecheck:preview --workspace packages/web-react` | ✅ / ✅（集成⑤ `91358ce54`、发布准备 `04ba13b2e`） | `.audit-tmp\integration\integ5\`、`.audit-tmp\release-deploy\gates-int\` |
| 全量单测 | `cd packages\web-react; npm test` | ✅ 305 文件 / 4306 例（集成⑤）；302 / 4279（集成④，三跑 + QA 独立一跑逐数相同） | `integ5\vitest-full.log`、`integ4-vitest-all-*.log`、`qa-integ4\t1567-vitest-full.log` |
| 真浏览器 | `$env:OC_E2E_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run test:browser` | `run.mjs` 68/68；`node --test` 85/87（2 红基线，§5-2） | `integ5\test-browser-2.log` |
| 教程门禁 | `npm run check:tutorials` | ✅ 26 capabilities · 12 cases · 26 media pairs | `integ5\check-tutorials-2.log` |
| 首屏预算（发布门） | `npm run build --workspace packages/web-react` | ✅ 447.8KB（集成⑤）/ 448.3KB（含 canonical）< 460.0KB | `integ5\vite-build.log`、`release-deploy\gates-int\` |
| 全量截图 / a11y 复扫 | `node browser-tests\ui-preview\shoot.mjs`；`node ..\.audit-tmp\a11y\scan.mjs` | 集成④：301 场景 1026 张 failures 0；复扫九项指标只降不升、回归 0。**集成⑤：未跑** | `.audit-tmp\integration\shots-integ4\manifest.json`、`a11y-integ4\report.md` |
| 发布前置 | `npx tsx scripts/check-migration-order.ts`；`scripts/check-v5-fix-trailers.sh --head HEAD` | ✅ 283 支 · 161 条；✅ PASS | `release-deploy\gates-int\`、[RELEASE.md §3.1c](./RELEASE.md) |

## 5. 还剩什么风险 / 需要你拍板的

1. **四笔教程同步快照 accept（指挥官代你确认，可逆）**：UI / a11y 修复改了入口元素的哈希，`check:tutorials` 报「功能源漂移」，指挥官在核对「入口身份不变、正文与 UI 文案一致」后以 `--source-only` 接受——history 第 67 条（集成③ 17 项，`b249317f4`）、第 68 条（t-1046 正文补写普通 accept，`e798c3123`）、第 69 条（集成④ `github-repository`，`2d2b5cafc`）、**第 70 条（集成⑤ `agents / billing-usage`，`91358ce54`）**。不认可：逐笔 `git revert`（[SUMMARY.md §7-1](./SUMMARY.md)）。另第 71 条是接受 canonical 上游 OCV5-220 文案 v4 的例行普通 accept（`57ad2c823` 内），供知悉。
2. **2 条基线红（与本轮无关，五轮集成逐条相同）**：`browser-tests/cc-switch-ascii-name.node-test.mjs` ×2（settings `ApiKeysSection` 模型 id 断言 + 10s 超时，基线 `210b9967` 同样红）。要不要在本轮外修，请拍板。
3. **NOT RUN（本轮无 v5-dev 后端通道）**：真机 iOS / Android、读屏实机（以 CDP AX 树 + jsdom 断言替代）、真后端行为（登录 / 支付回跳 / OAuth / WS 多标签 / 分享令牌等，全部以 api-stub + 单测桩覆盖）、慢网首开体感；集成⑤ 全量截图 + a11y 复扫（下半场）；发布线的 `test:browser` / gateway·commercial 单测 / commercial integ（Windows 假阳性或需 PG，留服务器 / CI）。
4. **设计取舍 / 产品口径（先问再改）**：shell S-08 / S-20；tutorials TU-19（0.9s 即已读）/ TU-21（CTA 五种文案）；HUD H-19；market K-23；misc-p3 D-04 / D-09；landing L-16 ②；settings Auto-Dream 文案、`ccswitch://` 深链带密钥；kp-automation 表单弹层形态；已按指挥官拍板落地的：market K-12 换行、tutorials TU-13 / TU-31、TU-17 参数名 `view=` → `tab=`、t-1348 选拆分不调阈值（[SUMMARY.md §5.3 / §7-5](./SUMMARY.md)）。
5. **需后端 / 协议配合（本轮一律未动）**：sidebar UCP-01 / GH-03、manage M-17 / M-06 ③、settings SET-09 / SET-10 / 用量 offset 分页、taskboard T-28、market K-25、media M-25 / M-24 / M-09、messages M-25、HUD H-12、composer C-26（[SUMMARY.md §5.1](./SUMMARY.md)）。要不要另开后端专项，请拍板。
6. **越界改动（均经指挥官批准并单列）**：t-839 改 messages `RichBlocks` / `MarkdownImpl`（根因修复）、t-1029 改 settings `KnowledgePlanetAutomationPanel`、t-1232 QA 直接修两处 className、t-1348 触及 messages / settings / sidebar 三处 import / 常量 / 测试等待方式（[SUMMARY.md §7-4](./SUMMARY.md)）。
7. **P3 观感项与遗留**：QA t-1236 登记 O-1 / O-2 / O-3（hud 列表末行裁半行、permission-card 命令块拆词、Composer textarea 底边裁半行）、a11y-C 补记 `TutorialCenter.tsx:387` 白图标、QA t-1232 三处 44px nit、集成⑤ 5 个新文件 biome format（CRLF 判定）——全部有归属，不阻断（[SUMMARY.md §5.2](./SUMMARY.md)）。

## 6. 发布线现状（预留 · 阶段②填）

| 环节 | 现状（09-18 21:xx，`git` 可核） | 待填 |
|---|---|---|
| 集成⑤ t-1237 | 8 步合并 + accept + 记录已在 integration（`9103ce7b4`），上半场门全绿（§4）；**任务未验收，下半场截图 / a11y 复扫未跑** | 下半场结果、验收结论 → [SUMMARY.md §4.3](./SUMMARY.md) |
| 发布准备 t-1268 | integration 已合 canonical `f1952819f`（`57ad2c823`），门全绿 448.3KB，RELEASE.md v2.2 就位（`aeae1d72e`）；**canonical ff / push 未做**；远端 canonical 又前进到 `97f128d2b`，需重核 | 重核结果、`<REL>`、push 时间 → [SUMMARY.md §4.4](./SUMMARY.md) |
| 发布执行 t-1269 | 未开始。服务器 live 已是 `f1952819f`、迁移 0281 已 apply（预期 `HAS_MIGRATION=0`）、磁盘 76%；不可逆动作由指挥官代批（d-1326 / d-1603） | §4.0 前值 → dry-run → `--deploy` → smoke 后值 → 发布记录 → [SUMMARY.md §4.5](./SUMMARY.md) · [RELEASE.md §4 / §6](./RELEASE.md) |

**如果你要在发布前叫停，请在 t-1269 开始前说**；发布后回滚路径见 [RELEASE.md §5](./RELEASE.md)（自动补偿 / 手动回 `rel-*` / 失败矩阵）。

---
索引：[SUMMARY.md](./SUMMARY.md)（总览 11 节）· [archive/README.md](./archive/README.md)（模块 / 专项 / QA / 发布线索引 + 集成①–⑤ 记录）· [INTEGRATION.md](./INTEGRATION.md)（集成①–⑤ 逐轮记录）· [RELEASE.md](./RELEASE.md)（发布手册 v2.2）· 作业口径 `d:\code\test_project\test123\TEAM_PLAYBOOK.md`（仓外）。
