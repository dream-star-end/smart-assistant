# v5 AI 市场 RFC —— 技能 + 智能体市场、用户发布/安装、能力 CLI+Skill 化（B 方案）

> 状态：草案 v1，待 Codex 评审 → boss 批准 → 逐里程碑实施
> 作者：Claude（架构师视角）  日期：2026-06-27  分支：`feat/v5-aurora-rewrite`
> 适用范围：仅 v5（claudeai.chat / 乾元，kl-mirror:18790）。**v3 全程零影响**为硬红线。

---

## 0. TL;DR（给评审者的三句话）

1. **技能市场后端其实已经存在**（发布→静态扫描→人工审核→批准→安装→容器 pull-sync→进 agent 的 hub overlay），代码与三张表都在仓内（见 §2）。⚠️ 但**安装→静态 prompt 是 eventual（非确定性）**：容器同步是 fire-and-forget 且晚于 prompt 构建（Codex R1 核实），故 M1 需补**确定性 pre-prompt sync**。本 RFC 不是从零造市场，而是 **①补技能市场前端 UI + 确定性 sync ②把市场泛化出"智能体"品类 ③切到 B 定位（默认仅全能助手）④把能力增量 CLI+Skill 化**。
2. **核心架构主张**：不为智能体克隆第二套并行市场，而是把现有"技能市场"**泛化为按 `kind` 判别的"工件市场"**（lifecycle 共用，仅 *扫描器 / 安装落地 / 详情渲染* 三处随 kind 变化）。当前三表近乎空（listings=1/versions=1/installs=0），泛化迁移代价极低，且一次到位支撑未来品类（团队、MCP 桥、提示词包）。
3. **最大风险 = 用户发布内容的信任与安全**（尤其智能体携带能力面）。已有技能扫描器 + 人工审核 + reviewer≠author + revoke kill-switch + 安装端 hash 复校。智能体在此之上加 **能力白名单（toolsets 受限、禁止用户自带 MCP）+ 依赖技能必须是已批准的市场技能**，把爆炸半径锁死在"已审人设 + 白名单工具 + 已审技能"。

---

## 1. 背景与目标

boss 指令（2026-06-27）："结合 SkillHub 文档做 AI 市场，先含 skill 和 agent 两类，支持用户发布/下载安装；v5 除内置工具和浏览器工具，其它一律 CLI+Skill 化；智能体默认初始只提供全能助手，其它让用户自行从市场安装。**B 方案**（最小默认）。出完整方案给 Codex 审，UI 交互一定要友好清晰，最后按审批过的方案逐项实施。"

参考：`harness_agent_cli_skillhub_summary.docx`（SkillHub 愿景：最小内核工具 + CLI-first + Skill 渐进式披露 + 注册中心/检索/包管理/权限/策略/质量/版本治理 + manifest.yaml + MCP 作远程桥）。

**目标**（按优先级）：
- T1 让 v5 用户能在友好 UI 里**浏览/搜索/安装/卸载/发布**技能与智能体。
- T2 智能体默认仅"全能助手"，其余从市场按需安装（B 定位）。
- T3 v5 能力面收敛：除 ccb 内置工具 + 浏览器工具外，其它能力以 **CLI 二进制 + 薄 Skill** 暴露（渐进式披露）。
- T4 全程对齐仓内既有抽象，不引第二套并行机制；v3 零影响；共享库迁移人工受控、向后兼容。

**非目标（本期不做）**：跨租户/外部公共注册中心联邦；付费交易/分成；语义评分排行复杂治理（保留为 SkillHub 远期）；团队（team）作为市场品类（泛化后可低成本追加，但本期只落 skill+agent）。

---

## 2. 现状盘点（已核实，file:line 为证）

### 2.1 技能市场后端 —— 已存在且完整

| 层 | 文件 | 结论 |
|---|---|---|
| 迁移 | `packages/commercial/src/db/migrations/0085_skill_embedding_cache.sql` / `0086_skill_search_log.sql` / `0087_skill_marketplace.sql` | 三表 + embedding 缓存 + 搜索日志。**已应用到 v5 共享库**（实测三表存在；当前行数 listings=1/versions=1/installs=0，近乎空）。 |
| 数据访问 | `packages/commercial/src/marketplace/marketplaceDb.ts` | publishSkillVersion / listPendingVersions / reviewVersion / listApprovedForSearch / getListingDetail / installApprovedVersion / recordUninstall / listInstalled / **listActiveInstalledArtifacts**（容器同步用）/ revokeListing。owner-lock 防抢注、approved 不可变（更新=新 pending）、install pin(version_id+artifact_hash)、软删除、reviewer≠author、TOCTOU `FOR UPDATE`。 |
| HTTP 路由 | `packages/commercial/src/marketplace/marketplaceRoutes.ts` + 注册于 `http/router.ts:32-40,550-599` | 用户 6 端点（publish/install/installed/detail/uninstall/search）+ 管理员 3 端点（pending/review/revoke）。**已注册、v5 可达、无 feature flag**。结构性防 agent 绕过：不在 `BRIDGE_API_ALLOWLIST`（容器无法代理）、handler 强制浏览器 JWT。 |
| 静态扫描 | `packages/commercial/src/marketplace/skillScanner.ts` | 7 类：secret/internal/injection/html/obfuscation/metadata/size；secret/internal/html/混淆/超长 → `block:true` 直接拒发；注入链式检测（read_creds+exfil_http 升级）。`SKILL_SCAN_POLICY_VERSION=1`。 |
| 检索 | `packages/commercial/src/marketplace/marketplaceSearch.ts` | embedding（DashScope via directEgressDispatcher，复用 `skill_embedding_cache`）+ 关键词 fallback + 全量兜底，cosine 排序。 |
| 容器同步 | `packages/mcp-memory/src/marketplaceSync.ts`（`index.ts:127` 启动调用）→ 内部端点 `GET /internal/v3/marketplace/sync`（`packages/commercial/src/http/internalMarketplaceSync.ts`，容器 token 鉴权） | **pull 模型**：mcp-memory 启动时拉取本用户 active 安装 → reconcile `~/.openclaude/hub/skills/<slug>/SKILL.md`（原子 temp+rename）；**安装端独立 `marketplaceArtifactHash` 复校**，hash 不符即丢弃；revoke 自动从列表消失 → 下次 sync 删除（kill-switch 零额外 RPC）；同 UID、master 不写卷；fail-soft。 |
| Agent 可见 | `packages/storage/src/skillStore.ts:962-964`（工厂注入 `hubDir=~/.openclaude/hub/skills`）→ `:489-490` 作为第 5 层 overlay（`'hub'`，只读，最低优先级）被扫描注入技能槽 | **投递链成立但同步时序不闭环**（Codex R1 BLOCKER#1，已核实）：`mcp-memory/index.ts:127` 是 `void syncMarketplaceHub()` fire-and-forget；而 runner 在启动 mcp-memory / 写 MCP config **之前**就已构建 `extra-prompt.md` 的技能槽（`subprocessRunner.ts:1135`）。故新装技能**不保证"下一次会话即进静态 prompt"**——准确表述是 **eventual tool-visible**：`skill_list/skill_view` 工具读实时 hub 可即时发现；静态技能槽要等某次 sync 完成后的后续会话才纳入。⚠️ `skillStore.ts:65` 注释"hub… not wired into the runtime overlay yet"**已过时**（overlay 实际已接），需清理。 |

**结论**：技能市场 = 后端完整 + 容器投递存在 + agent overlay 已接，但**安装→静态 prompt 是 eventual（非确定性）**。缺口 = ①前端 UI（零）②管理员审核 UI（零）③**确定性 pre-prompt sync**（M1 修，见 §5）。

### 2.2 智能体体系 —— 无市场，列表硬编码

- Agent 配置 schema：`packages/storage/src/config.ts:143-196`（`AgentDef`: id/version/model/persona(文件路径)/permissionMode/toolsets/displayName/avatarEmoji/greeting/provider/mcpServers/runnerKind；`AgentTeamDef`: leader+members+policy）。
- 权威存储：`~/.openclaude/agents.yaml`（`readAgentsConfig`/`writeAgentsConfig` config.ts:205-220；缺省 `{agents:[{id:'main'}],default:'main'}`）。容器内 gateway `server.ts:4469` 以 `cfg.default` 解析默认 agent；frontend 发 agentId，缺省 `'main'`。
- 前端列表：`packages/web-react/src/lib/agents.ts:28-139` **硬编码 9 个 agent**（general/coder/... 仅展示，注释明确"模型/人设权威在 v5 后端"）；`AgentPicker.tsx` 遍历该数组渲染。**无 per-user agent 列表端点**。
- 死代码确认：`packages/storage/src/hubStore.ts` + `clawhubClient.ts`（外部 ClawHub zip 方案）**全仓零引用**，已被内部 `marketplaceSync` 取代 → 本 RFC 不复用，建议清理（见 §11）。

### 2.3 能力暴露现状（CLI 化基线）

| 能力 | 当前形态 | 备注 |
|---|---|---|
| read/grep/edit/bash/glob/write/todo | ccb 内置工具 | **保留为内核（native）** |
| 浏览器（Playwright MCP） | MCP | **保留为 native（boss 指定"浏览器工具"）** |
| 记忆 / 市场同步 transport | `mcp-memory`（启动即跑，承载 marketplaceSync） | transport 性质，建议保留 native |
| vision/understand_image | MCP（条件注入，`mcpVisionServer.ts`，MiniMax-M3/codex backend） | **候选 CLI 化** |
| scansci（论文） | 容器内 CLI（已是） | 薄 skill 化即可 |
| mmx speech（TTS/语音） | 容器内 CLI（已是） | 薄 skill 化即可 |
| 文生图 / media 生成 | 混合（CLI + 卡片） | 候选 CLI 化 |
| cron / uploads / media-sign | HTTP API | 产品功能，非 agent 工具，不在 CLI 化范围 |

---

## 3. 核心架构决策

### D1. 智能体市场：泛化 vs 克隆（**推荐：泛化**）

> 问题类（非单症状）：boss 未来还会要团队、MCP 桥、提示词包进市场。若每类克隆一套 listings/versions/installs + 路由 + 扫描器，就是"第二、第三套并行机制"，正是 CLAUDE.md 要根治的。

| 方案 | 改动 | 设计代价 | 未来 3–6 月 |
|---|---|---|---|
| **A 泛化（推荐）** | 现有三表加 `kind` 判别 + 通用 payload；db/routes/scanner 按 kind 参数化；skill 行为靠现有测试锁字节级不变 | 一次性重构既有（Codex 已审过的）技能代码，有回归风险（用测试封堵） | 新品类 = 加一个 kind + 一个扫描策略 + 一个安装落地器，**零新表零新路由** |
| B 克隆 | 加 `marketplace_agent_listings/versions` 镜像 skill | 改动小、易过审 | 两套并行机制，认知负担 ×N，每新品类再 ×1，技术债复利 |

**推荐 A**。理由：①当前表近乎空（1 行），泛化即刻做最便宜；②lifecycle（发布→扫描→审核→批准→安装→同步→撤销 + owner-lock + immutable-approved + TOCTOU + kill-switch + hash 复校）**逐字相同**，差异只在三个 kind-specific 策略；③符合"消除一整类风险/顺势延伸"。

**泛化后的数据模型**（迁移 0092，additive + 一次性回填；已纳入 Codex R1 裁决）：
- **不 rename 表**（Codex R1：降迁移风险）。`marketplace_skill_listings`/`marketplace_skill_versions`/`marketplace_installs` 表名保留，**代码层**抽象为 artifact marketplace。
- listings 加列 `kind TEXT NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill','agent'))`。**kind 权威只存 listing**（Codex R1 防漂移）；versions/installs 的 kind 通过 join listing 得出，**不冗余存**（若为查询便利冗余，必须加触发器/约束保证与 listing 一致）。
- versions：**新增 `raw_artifact TEXT`**（通用"原始可发布文本"）+ **`manifest JSONB`**（结构化元数据：name/description/tags/version + kind 专属字段，agent 的 model/toolsets/skillDeps 落这里）。**回填 `raw_artifact = raw_skill_md`**。**不改 `raw_skill_md` 语义**（Codex R1：旧 skill 路由继续用 `raw_skill_md`，generic 路径用 `raw_artifact`，比复用专名列稳）。
- installs 不需加 kind（join listing 得出）。
- **slug 全局唯一**（Codex R1 裁决）：listings 主键已是 slug（`0087:16`），skill 与 agent 不共用 slug，URL/install/revoke/sync 无歧义。发布层校验"slug 已存在则 kind 必须一致"（owner-lock 已保证同 owner）。

**兼容策略**：现有 `/api/marketplace/*` 路由保持工作（kind 默认 'skill'），M1 前端先打这些路由；M2 泛化后路由按 kind 参数化但 skill 行为靠现有测试锁字节级不变。

### D2. 信任与安全模型（**#1 风险，逐 kind 收敛**）

技能（惰性文本）已有：扫描器（secret/internal/injection/html/混淆/超长）+ 人工审核 + reviewer≠author + revoke + 安装端 hash 复校。**沿用。**

智能体（携带能力面，更危险）在此之上需 **严格 allowlist manifest schema**（Codex R1 BLOCKER#4：`AgentDef` 字段级提权面已核实——`permissionMode=bypassPermissions`→`--dangerously-skip-permissions`（`subprocessRunner.ts:397`）；agent 专属 `mcpServers` **绕过 toolset filter**（`:1269`）；`toolsets` 缺省可能继承/全量开放（`:1095`）；另有 `cwd`/`provider`/`runnerKind`/persona-as-path）：

1. **manifest 是严格白名单 schema，拒绝未知字段**。**仅允许**：`name`/`description`/`tags`/`version`/`displayName`/`avatarEmoji`/`greeting`/`model`/`toolsets`/`skillDeps`/`persona`(内联文本)。
2. **显式禁止字段**（出现即拒发）：`mcpServers`（防绕过 toolset filter 引入任意外部 MCP）、`cwd`、`provider`、`runnerKind`、`routes`、`teams`、以及 **persona 作为文件路径**（persona 只能是内联文本，过扫描器）。
3. `permissionMode` **不由 manifest 提供，平台固定**（市场 agent 一律走平台容器默认策略，绝不允许自带 bypassPermissions）。
4. `toolsets` **必填、非空、且只取平台 vetted 集合**（assistant/research/coding/browser…）——**绝不允许"缺省=全开"**。`model` 限定 v5 public 模型集。
5. **人设扫描**：`persona` 内联文本走与 skill body 同一注入扫描器。
6. **依赖技能必须已批准**：`skillDeps` 只能引用**已批准的市场技能 slug@version**，不得内联技能。安装 agent 时连带解析安装其缺失的依赖技能（同一市场、同一审核门）。
7. **委派能力天花板（修 Codex R2 BLOCKER#2——堵 delegation 提权整类）**：现状 `openclaude-memory` 是内置 MCP，toolset 过滤恒放行（`subprocessRunner.ts:1103`），其 `delegate_task` 可带 `toolsets` 参数（`mcp-memory/index.ts:1086`），resolver 会**追加** caller 请求的已定义 toolsets（`toolsetIntent.ts:145`）→ 只声明 `assistant` 的市场 agent 能借 `delegate_task(toolsets:["browser","research"])` 拿到**未声明**能力面，**manifest toolsets 形同虚设**。**根治（选项③）**：把委派/子 agent 的 toolsets **cap 到 caller 的 effective(manifest 声明)toolsets**（求交集而非从全局池追加）——确立通用安全不变量"**任何 agent 不得授予子 agent 自己没有的能力**"。这让 manifest toolsets 成为**真正硬天花板**，一次堵死整类 on-demand 提权（不止 delegate_task），且对全能助手等全量 toolsets agent 零限制。备选①（更严但丢功能）：market agent 直接禁用 `delegate_task/send_to_agent`。**采③为主**。
8. 同样的人工审核 + revoke kill-switch + 安装端复校（manifest hash pin）。

**净效果**：一个市场智能体的**总可达能力**（自身 + 可委派出的子 agent）被 manifest 声明的 toolsets 硬封顶 = 已审内联人设 + 白名单 toolsets（含委派上限）+ 已审依赖技能 + 平台固定 permissionMode/无自带 MCP。**不新增任何能力面**。

### D3. B 定位 + per-user 智能体注册（**最大新件**）

现状：所有用户看同一 9 个硬编码 agent；agents.yaml 是容器级单例。B 方案要求"默认仅全能助手，其余按用户从市场安装" → 必须有 **per-user 已安装智能体**概念。

**设计（对齐既有，单一权威；已纳入 Codex R1 BLOCKER#2/#3）**——关键是**把"列表可见性"与"内容投递"两件事分开**：

- "已安装智能体" = `marketplace_installs`(join listing `kind='agent'`) `AND user`（复用，不新表）。
- **列表可见性 = master 即时**（修 BLOCKER#3 的 sync race）：picker 列表**由 commercial master 直接从 `marketplace_installs + manifest` 组装**（默认全能助手 + 已安装），**不依赖容器 agents.yaml 是否已同步** → 安装后 picker 立即正确，无 race。
- **端点命名（修 BLOCKER#2，避免撞 `/api/agents`）**：`/api/agents` 在 commercial 已被当 host RCE 面封堵并代理到容器（`router.ts:306` + `bridgeApiAllowlist.ts:42`），gateway 侧 `/api/agents` 是容器内 agents.yaml CRUD（`server.ts:4450`）——**绝不能在 master 新增同名 `GET /api/agents`**。新列表端点放在已有安全命名空间下：**`GET /api/marketplace/my-agents`**（与其它 marketplace 端点同鉴权边界：浏览器 JWT、不在 bridge allowlist、agent 不可达）。`AgentPicker` 改消费该端点（替换硬编码 AGENTS）+ "+ 从市场添加"入口。
- **内容投递到容器 = 确定性 sync，且 hook 必须在 agent 解析之前**（修 R1#1/#3 + R2#1）：agent 的 AgentDef（manifest → persona/model/toolsets/skillDeps）+ 其依赖技能经**同一 hub pull-sync** 落地；**不依赖 mcp-memory 启动的 fire-and-forget**。⚠️ R2 核实：agent 解析发生在 **runner 之前**——`dispatchInbound()` 先 `_getAgentsConfig()` 读 agents.yaml 并按 `frame.agentId` 找 agent，找不到还 fallback `{id: frame.agentId}`（`server.ts:7406`），`SessionManager` 之后才用已解析的 `opts.agent` 建 runner（`sessionManager.ts:1226`）。**故 sync 不能放 runner 层**（太晚，容器可能已用 fallback/default 启动，persona/model/toolsets 全错）。**正确位置**：sync hook 放在 container gateway 的 **agent resolution 之前**——`dispatchInbound()` 进入后、`_getAgentsConfig()` 之前触发 sync（await+短超时+fail-soft），sync 写完 agents.yaml 后 **reload agents 配置 cache/router**；显式 `agentId` 找不到时 **fail-closed 或"先 sync 再查"**，不得继续 `{id}` fallback（否则市场 agent 首选必错）。技能槽的 pre-prompt sync（M1）与此同源同机制。**单一投递机制**（hub pull），与技能对称。
- **存量 8 个 agent 不丢**：转为**官方一方市场智能体**（owner=平台、预批准、审计 + 可 revoke），市场"官方推荐"货架一键安装；**对存量用户迁移预安装**（写 installs 行）保证零退化；**新用户默认仅全能助手**（Codex R1 裁决）。curation 不消失，从"硬编码默认"变为"官方推荐货架"。
- **统一默认 agent id**（Codex R1 M4 项）：前端 `agents.ts` 用 `'general'`、后端默认 `'main'`（`config.ts` 缺省 + `server.ts` `agentId||'main'`）——B 切换时**统一为单一 id**（倾向后端权威 `'main'`，前端展示名"全能助手"），消除前后端默认源不一致。

### D4. 能力 CLI+Skill 化范围（**增量、最后做**）

- **native（冻结）**：ccb 内置工具（read/grep/edit/bash/glob/write/todo）+ 浏览器 + 记忆/市场 transport。
- **CLI+Skill 化（增量）**：vision → scansci → speech → 文生图/media-gen → ……每个 = 容器内 CLI 二进制（多在 runtime image）+ 一个薄 Skill（渐进式披露：agent 读 skill 学会调 `oc-xxx`）。这是 SkillHub 终态。
- **不在范围**：cron/uploads/media-sign 是产品 HTTP 功能，非 agent 工具。
- **诚实标注**：这是工作量最大、最长、部分前瞻的部分；触及 runtime image（每改一个能力可能要重建镜像）。**逐能力推进 + 每个独立验证**，不一次性大爆破。先有市场（M1–M4）产生价值，CLI 化（M5）随后增量。

---

## 4. UI/UX 设计（boss 强调"友好清晰"）

> 设计语言沿用 Aurora（与 ManageCenter/SettingsCenter 同构）。

**入口**：Sidebar 新增"市场"项（与"管理中心"平级），打开 `MarketplaceCenter`（Dialog 或全屏 Sheet，按内容量定，倾向较大 Sheet 以容纳卡片网格）。

**结构**：
- 顶部两 Tab：**技能 / 智能体**。
- 每 Tab：搜索框（即时）+ 卡片网格（名称/描述/标签/安装量/「已安装」徽标）+「官方推荐」货架 +「我的已安装」筛选。
- **详情抽屉**：点卡片右侧滑出——技能：渲染 SKILL.md（markdown）；智能体：人设摘要 + 能力（toolsets 友好名）+ 依赖技能清单 + 模型。底部「安装/卸载」。
- **安装确认对话框（关键友好点）**：清楚列出"将要加入什么"——智能体额外提示"将一并安装 N 个依赖技能：xxx、yyy"。一键完成，乐观更新 + 失败回滚。
- **发布对话框**：从「我的技能/我的智能体」选源 → 填版本 + 发布说明 → 提交 → 显示「待审核」状态。**扫描器拒绝就地展示人类可读理由**（扫描器已返结构化 flags → 映射成中文提示，如"检测到疑似密钥，请移除后重发"）。
- **管理员审核面板**（admin 门）：待审队列 → 预览工件 → 批准/拒绝 + 备注。reviewer≠author 已后端强制。
- **智能体选择器改造**：默认全能助手常驻 + 已安装智能体 +「+ 从市场添加」按钮（直达市场智能体 Tab）。

**友好/清晰原则**：空状态有引导文案；安装/发布全程状态可见（待审/已批准/已拒绝/已安装/已撤销）；危险动作（卸载、撤销）二次确认；移动端适配（沿用 P7.5/7.6 安全区与断点经验）。

---

## 5. 里程碑路线图（逐项实施，每个独立 Codex 双审 + 真机 e2e + v3 零影响）

> 排序原则：**先用现成后端产出价值（最低风险）→ 再做泛化与新品类 → 最后 CLI 化**。每个里程碑 boss 验收后再进下一个；outward-facing 的 B 切换单独 boss 授权。

### M1 — 技能市场前端 + 确定性 sync + 端到端补全（**最低风险，立即价值**）
- 前端：MarketplaceCenter（技能 Tab）浏览/搜索/详情/安装/卸载/我的已安装/发布/状态 + 扫描拒绝友好提示；`lib/api.ts` 补 marketplace 方法（打**现有** `/api/marketplace/*`，无后端 schema 改动）。
- 管理员审核面板（admin 门，打现有 admin 端点）。
- **确定性 pre-prompt sync（修 BLOCKER#1）**：runner 在构建 `extra-prompt.md` 技能槽前确定性触发一次 hub sync（await + 短超时 + fail-soft），使安装的技能在**下一次会话即进静态 prompt**，而非仅 eventual。同时清理 `skillStore.ts:65` 过时注释。
- 端到端复验：发布→审核→批准→安装→**容器 sync→agent 真用上该技能**（真机 driven，确认 hub 层闭环）。
- **验收分级（Codex R1）**：若 pre-prompt sync 已落地 → 验"安装后新会话静态 prompt 即见该技能"；若该项延后 → 至少验 `skill_list/skill_view` 工具即时可见（eventual）。canary 真机 e2e；v3 零影响。

### M2 — 后端泛化（kind 判别，additive 迁移）
- 迁移 0092（按 §D1/§8）：**listings 加 `kind`（权威，默认 'skill' 回填）**；versions 加 `raw_artifact TEXT`（回填=`raw_skill_md`）+ `manifest JSONB`；**installs 不加 kind**（join listing 得出）；约束/索引按 §D1。**v5 `AUTO_MIGRATE=0`，人工受控 + 先备份（DR=0）**。
- db/routes/scanner 按 kind 参数化；**skill 行为靠现有测试**（marketplaceDb.integ / skillScanner.test / 路由测试）**锁字节级不变**。
- Codex review（重点：泛化未改变 skill 既有不变量）。

### M3 — 智能体市场后端（**先补严格 schema + 确定性 sync 触发，再谈落地**，Codex R1）
- **严格 allowlist agent manifest schema**（§D2：拒未知字段、禁 mcpServers/cwd/provider/runnerKind/routes/teams/persona-path、permissionMode 平台固定、toolsets 必填非空且 vetted、persona 内联）+ agent 扫描器（persona 扫描 + skillDeps 必须已批准）。
- **委派能力天花板**（§D2.7，修 R2#2）：委派/子 agent toolsets cap 到 caller effective toolsets（`toolsetIntent.ts` 求交集而非追加）——通用不变量，使 manifest toolsets 成硬上限。
- **确定性 sync 触发位置正确**（修 R2#1）：sync hook 在 **`dispatchInbound()` 的 agent resolution 之前**（`_getAgentsConfig()` 前）触发 + sync 后 reload agents cache/router + 未知 agentId fail-closed（不 `{id}` fallback）。**不放 runner 层**。
- agent 安装落地器：install → reconcile agents.yaml per-user 条目 + 连带依赖技能；扩展 `marketplaceSync` 处理 kind='agent'。
- 列表端点 **`GET /api/marketplace/my-agents`**（per-user：默认全能助手 + 已安装；master 直接组装，**不撞 `/api/agents`**）。
- Codex review（重点：字段级提权面已封、依赖技能审核门、单一投递机制、sync 确定性）。

### M4 — 智能体市场前端 + B 切换 + onboarding（**outward-facing，boss 授权后**）
- 市场智能体 Tab（详情含 toolsets 友好名/依赖技能/模型 + 安装确认列依赖）。
- AgentPicker 改 per-user（消费 `/api/marketplace/my-agents`：默认全能助手 + 已安装 +「从市场添加」）。
- **统一前后端默认 agent id**（Codex R1）：消除 `'general'`（前端）vs `'main'`（后端）不一致，统一单一 id。
- 存量 8 agent → 官方一方市场智能体（预批准 + 审计 + 可 revoke）+「官方推荐」货架；**存量用户迁移预安装防退化，新用户仅默认全能助手**。
- 落地页文案从"开箱即用预置专家"调向"可成长助手 + 市场"。
- 验收：B 定位真机；存量用户零退化；v3 零影响。

### M5 — 能力 CLI+Skill 化（增量、最后、部分前瞻）
- 逐能力转换（vision → scansci → speech → media-gen …），每个 = CLI 二进制（runtime image）+ 薄 skill；native 集冻结为内置 + 浏览器 + transport。
- 远期 SkillHub 治理（manifest/permissions/quality/version）随规模分层引入。
- 每能力独立验证 + 镜像重建按需。

---

## 6. 数据边界与共享库纪律（v3 零影响硬红线）

- 市场三表在共享 `openclaude_commercial`，**仅 v5 读写**；v3 无市场代码 → **v3 永不触及这些表** → 加列/加表 additive 对 v3 天然零影响。
- 迁移：`COMMERCIAL_AUTO_MIGRATE=0`，人工受控、向后兼容、**先全量备份**（DR=0，沿用 P1a 备份纪律）。
- 安装内容投递 = 容器 pull-sync（master 不写卷），同 UID，跨容器 recycle 由下次 sync 重建（已验证模型）。
- 前端/路由：marketplace 不在 `BRIDGE_API_ALLOWLIST`（容器不能代理）+ handler 强制浏览器 JWT（agent 无法绕过自装/自发）—— 沿用既有结构性隔离。

---

## 7. 验证总纲

每里程碑：`npm run check`（lint+typecheck+test）+ 该里程碑专项测试（沿用 marketplaceDb.integ/skillScanner.test 模式）+ **Codex 代码审至 PASS** + **canary 真机 e2e**（真实发布/安装/对话验技能/智能体生效）+ v3 零影响核验（loopback + CF 200 + v3 树未改）。

---

## 8. 决策裁定（Codex R1 已逐条裁定，纳入本版）

1. **D1 泛化 vs 克隆** → **泛化**（认可）。**不 rename 表**，保留 `marketplace_skill_*` 表名，代码层抽象为 artifact marketplace + 兼容层。
2. **slug 命名空间** → **全局唯一**（listings 主键已是 slug，避免 URL/install/revoke/sync 歧义）。
3. **agent artifact 存储** → **新增 `raw_artifact TEXT` + `manifest JSONB`，不复用 `raw_skill_md` 语义**（skill 回填 `raw_artifact=raw_skill_md`，旧 skill 路由继续用 `raw_skill_md`，generic 路径用 `raw_artifact`）。
4. **存量 8 agent 迁移** → **对存量用户预安装（零退化）；新用户仅默认全能助手**。
5. **审核默认** → **用户内容 pending 人工审核；官方一方内容平台 owner 自动批准，但必须审计 + 可 revoke**。
6. **M5 CLI 化** → **M1–M4 上线后单独立项**（不绑市场上线关键路径）。
7. **kind 防漂移**（Codex 追加）→ kind 权威只存 listing，versions/installs join 得出（如冗余则加约束/触发器保一致）。
8. **默认 agent id 统一**（Codex 追加，M4）→ 消除前端 `'general'` vs 后端 `'main'` 不一致。

---

## 9. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 用户发布恶意/注入内容 | 高 | 扫描器 + 人工审核 + reviewer≠author + revoke + 安装端 hash 复校；agent 加能力白名单 + 禁自带 MCP + 依赖技能须已审 |
| 市场 agent 借 delegate_task 提权（超出 manifest toolsets） | 高 | §D2.7 委派 toolsets cap 到 caller effective 集（toolsetIntent 求交集）——manifest 成硬天花板，堵整类 on-demand 提权 |
| 市场 agent 内容投递晚于 agent 解析致首选用错 def | 中 | sync hook 前移到 `dispatchInbound()` agent resolution 前 + reload cache + 未知 agentId fail-closed |
| 泛化重构回归既有技能市场 | 中 | 现有测试锁字节级不变；Codex 专项审；M1 先不动后端 |
| 共享库迁移影响 v3 | 中 | additive-only + v3 不读这些表 + 人工受控 + 先备份（DR=0） |
| B 切换致存量用户丢 agent | 中 | 迁移预安装 + 官方推荐货架 |
| CLI 化触及 runtime image 引入不稳 | 中 | 增量逐能力 + 每个独立验证 + 镜像按需重建 |
| 安装内容跨 recycle 丢失 | 低 | pull-sync 已验证重建模型 |

---

## 10. 与既有抽象的对齐检查（CLAUDE.md 硬指标）

- **不引第二套并行机制**：✅ 泛化复用单一 lifecycle/表/路由/同步；agent 复用 installs + hub pull + 审核门。
- **单一权威源**：✅ 技能内容权威 = 市场 versions + 容器 hub；agent 列表权威 = installs + 默认全能助手；前端不持权威（沿用现状）。
- **看一类问题**：✅ kind 判别一次到位支撑未来品类。
- **可维护/扩展/一致**：✅ 新品类顺势延伸（加 kind + 策略），无需绕开自己。
- **诚实短期权衡**：✅ M5 CLI 化标注为最长/前瞻；存量迁移取"预安装"为零退化优先。

---

## 11. 顺手清理（实施期）

- 删死代码 `packages/storage/src/hubStore.ts` + `clawhubClient.ts`（全仓零引用，已被 marketplaceSync 取代）—— 独立小 commit，Codex 确认无引用后删。
- 更正 `skillStore.ts:65` 过时注释（hub 层实际已 wired）。
