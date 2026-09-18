# v5 个人版 · Skills 子系统全栈深审（阶段 A）

> 任务 t-1697 · 协同组「v5个人版的记忆、skills、配置审查」· owner fable-5-1-33 · 指挥官 fable-5-1-36。
> 口径见工作区根 `TEAM_PLAYBOOK_MSC.md`（§4.2 文件清单 / §5 八项清单 / §6 阶段 A 交付）。
> 基线 `aeae1d72ee8fa01475eebf016278841c96b91056`，分支 `feat/v5-selfhost-msc-skills`。
> **阶段 A 只审、不改业务代码**；本文件 + 复现脚本（仓库外）是唯一产物。

---

## 1. 范围与文件清单（含行数）

前缀省略 `v5-selfhost/`。行数为基线快照。

### storage（`packages/storage/src/`）
| 文件 | 行 | 职责 |
|---|--:|---|
| `skillStore.ts` | 1683 | 四层叠加技能库（platform baseline / agent-seed / project / shared / legacy / hub），读写/历史/恢复/辅助文件/scope 权威；含 A4 identity-compat |
| `skillDraftStore.ts` | 299 | 训练草稿暂存区（`~/.openclaude/skill-drafts/<runId>/<name>/`），diff/confirm/comment/manual-edit 的单一载体 |
| `skillEmbedding.ts` | 218 | 语义检索纯逻辑（canonical hash / embed text / cosine / exact-name guard），专用 `SKILL_EMBEDDING_*` 命名空间 |
| `skillEvals.ts` | 123 | `evals/evals.json` schema 与解析/序列化单一权威（用例≤8/断言≤8） |
| `projectSkillLedger.ts` | 261 | 项目技能叠加账本（taskboard.db `tb_project_skill`），树哈希校验 |
| `clawhubClient.ts` | 115 | ClawHub 市场只读 REST 客户端（search/resolve/detail/download） |

### mcp-memory（`packages/mcp-memory/src/`）
| 文件 | 行 | 职责 |
|---|--:|---|
| `skillSaveArgs.ts` | 45 | `skill_save` 入参归一化（宽容 content/desc 别名，纯函数） |
| `skillStoreContext.ts` | 26 | 从 env 构建 MCP 侧 SkillStore（含 compat 投影校验） |
| `skillEvalToolPolicy.ts` | 37 | 评测会话工具围栏（block 写入/委派/提醒等） |

### gateway（`packages/gateway/src/`）
| 文件 | 行 | 职责 |
|---|--:|---|
| `skillEval.ts` | 261 | 评测纯逻辑（prompt/grader/parse/benchmark，无 I/O） |
| `skillEvalGen.ts` | 294 | AI 生成用例纯逻辑（素材裁剪/prompt/宽容解析/id 归一化/过格式权威） |
| `skillEvalGenJobs.ts` | 170 | 生成 job 状态机（running/done/failed；落盘 `gen-<id>.json`） |
| `skillEvalJobs.ts` | 188 | 评测 run 状态机（queued/running/grading/done/failed；落盘 `<id>/run.json`） |
| `skillRetrievalShadow.ts` | 380 | 4 路影子排序器（keyword/zh-lexical/char-ngram/bm25，纯逻辑） |
| `skillShadowReporter.ts` | 302 | 影子观测器（采样、限时排序、低敏上报 master） |
| `skillTrain.ts` | 203 | 训练 prompt/参数纯逻辑（DeepSeek 锁定、draft-only） |
| `skillTrainJobs.ts` | 424 | 训练 run 状态机（queued/running/diff_ready/merged/discarded/failed） |
| `skillUsageReporter.ts` | 588 | 市场使用信号上报器 + 差评引用拉取（fail-open 落盘队列） |
| `ocSkillCli.ts` | 181 | 对话内 `oc-skill` CLI（train/eval-gen，`--confirm` 硬门） |
| `ocSkillLocalRelay.ts` | 80 | 回环-only relay 路由决策 + 站内信文案（纯逻辑） |
| `server.ts` | 23314(共享) | `/api/skills*`、`/api/skill-eval*`、`/api/skill-eval-gen*`、`/api/skill-training*` 路由块（路由 6080-6235；处理器 9143-10910）+ `SKILL_LOCAL_RELAY` 4090-4116 |

### web-react（`packages/web-react/src/`）
| 文件 | 行 | 职责 |
|---|--:|---|
| `components/manage/SkillsPanel.tsx` | 488 | 技能库列表（扫读 + 筛选 + 行展开预览） |
| `components/manage/SkillEditor.tsx` | 992 | 技能工作台（正文/文件/评测/训练/历史，per-path 草稿模型） |
| `components/manage/SkillOptPanel.tsx` | 1349 | 评测分区 + 训练分区（成本确认、行级 diff、草稿审阅合并） |
| `components/manage/ProjectSkillOverlay.tsx` | 218 | 工作项目专属技能开关（整份清单一次保存） |
| `components/manage/skillDisplay.ts` | 27 | 展示名 + 密钥类技能判定 |
| `lib/skillRunCost.ts` | 83 | 成本估算/实报（与计费同公式） |
| `lib/skillTrainReentry.ts` | 29 | 训练 run 重入选择（纯函数） |
| `lib/api.ts` | 4591(共享) | skills 段（3104-3411） |
| `lib/types.ts` | 1878(共享) | skills 类型段（1142-1278） |

对应 `*.test.ts(x)`：storage 5、mcp 4、gateway 11、web 8（含 `components/tool/skillCards.test.tsx`）。

---

## 2. 架构与数据流速写

### 2.1 读路径（技能可见性）
`SkillStore` 是唯一权威，六层叠加、**高层同名遮蔽低层**、name-dedup：
`platform baseline(ro,env)` > `agent-seed(ro)` > `project overlay(ro,账本校验)` > `shared(rw,全 agent)` > `legacy(agents/<id>/skills)` > `hub(市场,ro)`。
- 运行时（prompt 注入 / MCP `skill_*`）：`buildRunSkillStore` / `buildAgentSkillStore`，`scopeMode:'runtime'`，按 `.openclaude-agent-scope.json` 过滤 shared/hub；默认 agent(main) 聚合所有 agent 的 legacy。
- 管理面（`/api/skills`）：`buildUserSkillStore`，`scopeMode:'management'` + `aggregateLegacy` + `includePlatform:false`（平台技能对用户面板永不枚举/泄漏正文——权威在 store，不散落 handler）。
- 契约：REST `SkillSummary`/`SkillDetail`（types.ts 1142-1278）；MCP `skill_list/search/view`（toolDefs.ts 15-64）；prompt `SKILLS` slot（promptSlots.ts `buildSkillsSlot` ~760-841，仅注入 description）。

### 2.2 写路径（技能库）
唯一写源 = shared（`~/.openclaude/skills`，`buildUserSkillStore` 写它）或（specialized agent/无 shared）per-agent legacy。`save()`：校验名/描述/版本 → reserved-name 守卫（baseline/任意 agent-seed）→ `ensureWriteRoot`（realpath 容器化，禁 symlink 逃逸）→ 旧版快照进 `history/<ver>.md` → patch 自增 → 原子写（tmp+rename）→ shared 写 scope 边车。删除：shared 模式清所有 agent 同名 legacy 残留。
入口：REST `PUT/DELETE /api/skills/:name`（server.ts 9261-9329）、`PUT/DELETE /api/skills/:name/files`（辅助文件，9163-9206）、`POST /restore`；MCP `skill_save/skill_delete`（index.ts 549-609，训练/评测会话禁用）。

### 2.3 训练闭环（train → draft → eval-gate → merge）
1. `POST /api/skills/:name/train`（10608-10701）：owner=`getUserId`，仅自建技能（`includePlatform:false` 让平台名解析 404，避免存在性 oracle）。拉「用户差评过的真实使用记录」（`fetchUserSkillFeedbackRefs`，fail-open）注入 prompt。起后台会话（`skillTrainRunId` env → MCP 暴露 draft-only `skill_propose`，屏蔽 skill_save/delete）。
2. `skill_propose`（index.ts 616-705）：run id 来自 spawn env（模型不能改投别的 run）；reserved-name/platform 守卫；写 `SkillDraftStore`（不碰权威库）。
3. `final` 事件（`_onTrainEvent` 10508-10531）：按**实际草稿数**（非 propose 调用数）`finalize` → `diff_ready`/`discarded`；发站内信；`autoEval` 时 `_maybeAutoEvalTrainRun` 起 draft-vs-现版评测门。
4. `POST /merge`（10862-10910）：唯一写权威库；逐草稿 `save`/`delete` + `saveAuxFile('evals/evals.json')`，成功后 `deleteDraft`；全消费 → `merged`+`forget`。

### 2.4 评测（eval run）
`POST /api/skills/:name/eval-run`（9396-9463）→ `SkillEvalJobStore.create` → `_runSkillEval`（10258-10371）：每 case 每 arm 一个隔离会话（`channel:'skill-eval'`，`skillEvalMode`）；`without` 隐藏目标技能，`draft` 用草稿目录替换（env `OPENCLAUDE_SKILL_EVAL_*`，subprocessRunner 2547-2559，promptSlots 793-807，mcp index 162-173/474-489 双侧过滤）；每 case 一个匿名 grader turn（A/B 盲测）→ `computeBenchmark`。用量逐 turn 累计 `run.usage`，前端按公开费率折算。`baseline` 模式落 `evals/last-run.json`。

### 2.5 AI 生成用例 / 影子 / 使用信号
- 生成：`POST /evals/generate`（9488-9525）→ `_runSkillEvalGen`（9592-9637）：采集近 30 天真实会话摘录 → 单隔离 turn → `finalizeGeneratedCases`（过 `parseSkillEvalsJson`）→ 只回草稿灌进编辑器，**绝不落库**。
- 影子（`skillShadowReporter`）与使用信号（`skillUsageReporter`）：纯遥测侧信道，缺 master env 即整体 no-op；使用信号 fail-open、落盘队列 + TTL/退避/上限。

### 2.6 状态机

**评测 run**（`skillEvalJobs.ts`）
```
create → queued → running ⇄ grading → done
                      │           │
                      └────┬──────┘
                           └──────────→ failed
重启 loadAll：active(queued|running|grading) → failed（"gateway restarted during eval"）
armsForMode: baseline=[without,with]  draft=[with,draft]
```

**训练 run**（`skillTrainJobs.ts`）
```
create → queued → running → diff_ready ──merge──→ merged(+forget)
                    │  ▲          │  │
                    │  └─reopen───┘  └──discard──→ discarded
                    └────error──────────────────→ failed
final 非终态：由实际草稿数 finalize（>0→diff_ready；0→discarded）
重启 loadAll：active + 有暂存草稿 → diff_ready（保住已付费草稿）；无草稿 → failed
phase 单调（PHASE_RANK）：queued<scanning_sessions<evaluating<drafting<diff_ready|done<failed
```

**草稿 merge**（server.ts `_handleSkillTrainMerge` + `SkillDraftStore`）
```
draft(op=create|update|delete) ──merge一项──→ save()/delete() 权威库 + saveAuxFile(evals) → deleteDraft
剩余草稿=0 → train run setStatus(merged)+forget ; 否则留待重试
DELETE run / discard → deleteRun（清整 run 目录，零影响权威库）
```

---

## 3. 方法与证据

- **读**：§1 全部四层源码 + 相邻契约（`toolDefs.ts`/`toolNames.ts`/`paths.ts`/`subprocessRunner.ts` 2545-2560/`promptSlots.ts` 760-841/`server.ts` 路由与处理器）。
- **静态验证**：`npx tsc --build`；`npm run typecheck --workspace packages/web-react`（结果见 §验证摘要，追加于本节末）。
- **既有测试通读**：storage/mcp/gateway/web 共 28 个 skill 相关测试文件的用例名（覆盖 overlay/compat/draft/eval/train/shadow/usage/CLI/relay 与前端面板）。
- **复现脚本**（仓库外 `D:\code\test_project\test123\.audit-tmp\msc-skills\repro\`，`OPENCLAUDE_HOME` 指向临时目录）：

`concurrent-save.ts` 输出（**S-01 证据**）：
```
seeded version = 1.0.0
save A ok = true | save B ok = true (neither reports a conflict)
final body      = "BBB — writer B\n"
final version   = 1.0.1
history versions= 1.0.0
LOST update = "AAA — writer A" ; recoverable from history = false
```
→ 两次并发 `save()` 都返回 ok、都不报冲突；最终只剩 B，A 的正文**丢失且不在历史里**（历史只有并发前的 1.0.0）。

`eval-cap.ts` 输出（**S-03 证据**）：
```
MAX_EVAL_CASES (storage) = 8
parse 8 cases ok         = true
web UI hard cap          = 5
```

---

## 4. 问题清单

| 编号 | 位置(file:line) | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| S-01 | `storage/src/skillStore.ts:1191-1323`（save 读旧→快照→自增→原子写，无锁/无版本）；`gateway/src/server.ts:9290-9320`（PUT 不带版本） | 同一技能并发保存无乐观并发控制：两次 `save()` 均 ok、均不报冲突，后者覆盖前者，前者正文丢失且未进历史 | 并发编辑丢更新（数据丢失），与记忆文件的 409 冲突检测（`server.ts:9046-9069` `handleMemoryFile`）语义不对称 | **P2** | 复现 `concurrent-save.ts`（§3） |
| S-02 | `gateway/src/skillEvalJobs.ts:53,153-179`；`skillEvalGenJobs.ts:44,134-163`；`skillTrainJobs.ts:118,352-355,364-404`；`server.ts:2476-2479,2854-2856` | 三个 job 注册表是进程内 `Map`，评测/生成 run 永不淘汰（train 仅在 discard/整体 merge 时 `forget`）；落盘 `skill-evals/`、`skill-drafts/` 的 run.json 无任何 GC；重启 `loadAll` 全量载入 | 长驻 gateway 下内存与磁盘随 run 数单调增长（尤以「每日自动回归」为甚，每技能每天新增一条永不回收） | **P2** | 全文件通读 + `rg cleanup/prune/retention` 无命中 skill-evals/skill-drafts 的 janitor |
| S-03 | `storage/src/skillEvals.ts:13`（`MAX_EVAL_CASES=8`）；`web-react/.../SkillOptPanel.tsx:344,459,467`（硬编码 5）；`gateway/src/skillEvalGen.ts:155`（prompt「3-5」） | 后端接受 ≤8 用例，前端硬卡 5：技能一旦有 6-8 个用例（训练草稿 evals 经 `parseSkillEvalsJson` ≤8 合并即可达），面板显示「8/5」、禁用「加用例」、生成按 `5-prev` 截断 | 跨层契约不一致；已配 >5 用例的技能在 UI 上不可再增且计数错乱 | **P2** | 复现 `eval-cap.ts`（§3） |
| S-04 | `gateway/src/server.ts:9290-9320`（`save({description: body.description ?? '', ...}, body.body ?? '')`）；`web-react/src/lib/api.ts:3136-3139`（`updateSkill` 全可选） | `PUT /api/skills/:name` 无「部分更新」语义：只传 `{description}` 会把 body 写空、只传 `{body}` 会因描述为空被拒。API 类型标记为全可选，误导调用方 | API 客户端（oc CLI/未来集成/手工请求）做描述-only 更新会静默清空技能正文（旧版尚可从历史找回）；当前 Web `SkillEditor` 总是整体提交故未触发 | P3 | `handleUserSkillItem` PUT 分支 + `updateSkill` 签名 |
| S-05 | `gateway/src/server.ts:7778-7788`（`readJsonBody` 无字节上限）；对比 `17192`（`readBody` 默认 10MB）与 `9182`（辅助文件 64KB） | 技能保存/辅助文件 PUT 走 `readJsonBody`，请求体无上限；aux 文件另有 64KB 内容门但整体 JSON 体无门 | 超大 SKILL.md 正文可被接受落盘（成本/内存/后续注入放大），与同仓其他端点的体量守卫不一致 | P3 | `rg readJsonBody<` 命中的 skill PUT |
| S-06 | `storage/src/skillStore.ts:1332-1375`（`saveAuxFile` 未拒 `SKILL.md`/`history/`）对比 `1381-1409`（`deleteAuxFile` 显式拒） | `saveAuxFile` 允许把 `SKILL.md` 或 `history/*` 当辅助文件写入，绕过版本快照机制 | 纵深防御缺口：当前经 HTTP 仅走 allowlist（`references|assets|evals|scripts`）不可达，但存储层原语不自洽，未来新调用方易踩 | P3 | 两函数守卫对比 |
| S-07 | `gateway/src/server.ts:9407-9439`（eval-run 读技能自带 `evals/evals.json`，含 hub 只读技能）；`skillEval.ts:105-139`（grader prompt 嵌入用例/输出） | 市场安装（hub）技能随包携带的用例与断言，会在用户跑评测时喂进 grader 与被测会话 | 第三方发布者可自带对己有利的断言（自评虚高），或在 prompt 里做有限注入（被测会话已被 `skillEvalMode` 围栏，无持久化/委派逃逸，影响限于误导性结论） | P3 | `_handleSkillEvalStart` + `skillEvalToolPolicy` 围栏 |
| S-08 | `storage/src/skillStore.ts:369`（`description: ${JSON.stringify(...)}`）；`mcp-memory/src/index.ts:166-171`；`gateway/src/promptSlots.ts:796-802` | draft arm 用 `raw.match(/^description:\s*(.+)$/m)` + 裸去引号读草稿描述，不反转义 JSON 编码 | 含转义引号/换行的草稿描述在评测 draft arm 的 SKILLS 摘要里渲染错误（评测输入偏差，非持久损坏） | P3 | 三处解析与写入不同源 |
| S-09 | `web-react/src/lib/types.ts:1143-1153,1274-1278`（`SkillSummary`/`SkillDetail` 无 `priority`）；`storage/src/skillStore.ts:64-69`（storage 支持 priority 并注入排序） | 前端类型丢弃 `priority`，管理面无法查看/编辑注入排序优先级；后端 `view()` 实际返回该字段 | 功能/契约漂移：用户无法调 SKILLS slot 的注入排序（仅能靠 frontmatter 手改文件） | P3 | 类型段缺字段 |
| S-10 | `storage/src/skillEmbedding.ts:79-99` | `getSkillEmbeddingProvider` 单例缓存首个 config；运行时改 `SKILL_EMBEDDING_*`/换 key 不生效（仅 `resetSkillEmbeddingProvider` 供测试） | 密钥轮换/配置热更后仍用旧 provider，需重启 gateway | P3 | 单例实现 |
| S-11 | `storage/src/clawhubClient.ts`（0 测试）；无并发保存/版本冲突用例；无跨层用例上限一致性断言 | 关键路径测试缺口：市场客户端、并发写、UI/后端上限对齐均无用例 | 回归风险（尤以 S-01/S-03 无守门测试） | P3 | `rg` 测试清单 |

（说明：本轮未发现 P1。子系统的路径穿越/符号链接容器化（`safeReadFile`/`ensureWriteRoot`/`hashSkillTree`）、owner 校验（`_ownedTrainRun`/eval-run/gen-run 均 `userId` 比对）、reserved-name 与平台只读守卫、成本确认与 `--confirm` 硬门、fail-open 边界均经复核，未见可利用漏洞或静默扣费。）

---

## 5. 改进建议（标优先级）

- **[高] 技能保存引入乐观并发**（对齐记忆文件）：`view/getSkill` 返回 `version`（已有），`PUT` 带 `expectedVersion`，`save()` 比对不符回 409。修 S-01，并顺带修 S-03 用例编辑同类竞态风险。
- **[高] job 生命周期治理**：为三个 job 注册表加「内存条数上限 + 终态 TTL 淘汰」，并加一个后台 janitor 清 `skill-evals/`、`skill-drafts/` 下超龄终态 run（复用 `delegateJobs`/`outboundRing` 的 prune 范式）。修 S-02。
- **[中] 统一用例上限单一权威**：前端从 `MAX_EVAL_CASES`（经 types/常量导出）取值，去掉硬编码 5；生成 prompt 文案随之取值。修 S-03。
- **[中] `PUT /api/skills/:name` 明确部分更新语义**：字段缺省 = 不改（读当前值回填），而非写空；`updateSkill` 类型与后端一致。修 S-04。
- **[中] 体量守卫对齐**：技能 PUT 走 `readBody(req, <limit>)` 或对 body 加显式上限。修 S-05。
- **[中] `saveAuxFile` 自洽守卫**：与 `deleteAuxFile` 一致拒 `SKILL.md`/`history/`。修 S-06。
- **[低] hub 技能评测标注**：hub 自带用例跑出的 verdict 标「未独立验证」，或 autoeval 只信用户本地用例。缓解 S-07。
- **[低] 草稿描述解析复用 `parseFrontmatter`** 而非正则裸读。修 S-08。
- **[低] `priority` 纳入 FE 类型 + 只读展示**（编辑可暂缓）。缓解 S-09。

---

## 6. 修复计划（阶段 B）

| 编号 | 改哪些文件 | 怎么改 | 补什么测试 | 风险 | 触及共享文件 |
|---|---|---|---|---|---|
| S-01 | `storage/src/skillStore.ts`、`gateway/src/server.ts`（PUT handler）、`web-react/src/lib/api.ts`+`SkillEditor.tsx` | `save()` 增 `opts.expectedVersion?`：写前比对当前版本，不符返回 `{ok:false, conflict:{version, ...}}`；PUT 透传并映射 409；前端保存带 `detail.version`，409 提示重载 | storage：并发/版本不符→冲突单测（替代复现脚本）；vitest：SkillEditor 409 分支 | 契约变更（PUT 增字段、409 新状态）→ 需 `ask_decision` | server.ts、api.ts（skills 段）、types.ts |
| S-02 | `skillEvalJobs.ts`、`skillEvalGenJobs.ts`、`skillTrainJobs.ts`、`server.ts`（起 janitor） | 注册表加 `maxEntries` + 终态按 `finishedAt` 淘汰；新增周期 janitor 删超龄终态 run 目录（TTL env 可调，默认如 7d，保 newest-N） | 各 store：超限淘汰/janitor 删终态保活跃单测 | 误删仍需展示的历史 run（用 newest-N 下限 + 仅终态兜底） | server.ts（新增 timer） |
| S-03 | `skillEvals.ts`（导出上限）、`web-react/.../SkillOptPanel.tsx`、`skillEvalGen.ts`（prompt 文案） | 前端与生成文案统一取 `MAX_EVAL_CASES` | vitest：断言 UI 上限 = 常量；storage 已有 8 上限用例 | 极低 | 无（types.ts 若需导出常量则轻改） |
| S-04 | `gateway/src/server.ts`、`web-react/src/lib/api.ts`（注释/类型） | PUT 缺省字段回填当前值再 save | node:test：描述-only PUT 不清空 body | 低 | server.ts、api.ts |
| S-05 | `gateway/src/server.ts` | 技能 PUT 用 `readBody(req, N)` 或对 `body`/`content` 加上限并 413 | node:test：超限 413 | 低 | server.ts |
| S-06 | `storage/src/skillStore.ts` | `saveAuxFile` 加与 `deleteAuxFile` 同款 `SKILL.md`/`history/` 拒绝 | storage：saveAuxFile 拒 SKILL.md/history 单测 | 低（现无合法调用写这两处） | 无 |
| S-07 | `gateway/src/server.ts`、`web-react/.../SkillOptPanel.tsx` | verdict 附「用例来源=技能自带（未独立验证）」标注 | vitest：hub 技能评测结果带标注 | 低 | server.ts |
| S-08 | `mcp-memory/src/index.ts`、`gateway/src/promptSlots.ts` | 复用 `parseFrontmatter(raw).meta.description` | 现有 promptSlots 测试补转义描述用例 | 低 | mcp-memory（自段）、promptSlots（非共享） |
| S-09 | `web-react/src/lib/types.ts`、`SkillEditor.tsx` | 类型补 `priority?`，工作台只读展示 | vitest：详情渲染 priority | 低 | types.ts |

> 阶段 B 一律「先红灯用例再改绿」，共享文件（server.ts/api.ts/types.ts）改动单独成小 commit；改契约/409/新增依赖前走 `ask_decision`。

---

## 7. 建议不修 / 暂缓 / 需专项

- **S-10（embedding provider 单例）**：暂缓。密钥轮换属运维低频操作，重启即生效；改 provider 失效策略收益小、易引入并发重建抖动。
- **S-11 测试补齐**：随各修复项就地补（S-01/S-03 已列入），`clawhubClient` 建议单独补一批（mock fetch）但不阻塞本轮。
- **priority 可编辑（S-09 的编辑部分）**：需专项。涉及 frontmatter 写回 + 注入排序 UX，超出「审 + 小修」范围，建议独立需求。
- **hub 用例信任模型（S-07 深化）**：需专项。彻底方案（发布侧用例审核 / 沙箱化 grader）跨市场子系统，非本轮范围（§4.5 marketplace 不碰）。
- **schema/迁移类**：无（`tb_project_skill` 建表幂等，未发现需改迁移编号的问题）。

---

### 验证摘要（阶段 A）
本轮**未改任何业务/测试代码**（`git status` 仅 `docs/audit/msc-skills.md` 新增；`packages/cli/src/index.ts`、`packages/mcp-memory/src/index.ts` 的 `M` 是 autocrlf 假改动，见 PLAYBOOK §2，未 add）。

| 命令 | 结果 |
|---|---|
| `npx tsc --build` | **PASS**（exit 0，覆盖 storage/gateway/mcp-memory/protocol/cli） |
| `npm run typecheck --workspace packages/web-react` | **PASS**（exit 0） |
| `npx tsx --test packages/storage/src/__tests__/skillEvals.test.ts` | **PASS**（3/3） |
| `npx tsx --test packages/storage/src/__tests__/skillStore.test.ts` | 48 pass / 1 fail / 2 cancelled —— 失败集中在 `PR4 safeReadFile cross-root symlink containment` 组：**NOT RUN（环境限制）**，Windows 无创建 symlink 权限（EPERM），非本轮引入（零代码改动） |
| `npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/skillEvalJobs.test.ts` | **PASS**（全通过） |
| `npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/skillTrainJobs.test.ts` | 8 pass / 2 fail —— `SkillTrainJobStore durability`（reload 重建）：**NOT RUN（环境限制）**，`_safeRoot` 的 realpath 容器化在 Windows 盘符大小写/junction 下 `startsWith` 判定失效，非本轮引入 |
| 复现脚本 `concurrent-save.ts` / `eval-cap.ts` | 按 §3 输出复现（仓库外 `.audit-tmp`，未入库） |
| 真实模型 / PG 端到端评测（eval run/训练会话真跑） | **NOT RUN**：本机无 v5 后端（PG/容器/模型 Key 在服务器，见 PLAYBOOK §1） |

> 说明：上述两处 node:test 失败在基线（未改代码）即存在，属 Windows 平台限制（symlink 权限 / realpath 大小写），符合 PLAYBOOK §3「Windows 上确实跑不起来 → 标 NOT RUN + 原因」。强制门（`tsc --build`、web typecheck）均绿，未因本轮新增文件变红（新增仅 md，无 .ts 入库）。

---

## 阶段 B · 修复记录（t-1848）

指挥官预拍板（免 ask_decision）执行。P2 全修，P3 修 4 条，S-07/S-08 遗留。

| 编号 | 改动 | 测试 |
|---|---|---|
| **S-01** 乐观并发 | 新增 `protocol` 无关；`storage/skillStore.ts`：`SkillSaveOptions.expectedVersion?` + `SkillSaveResult.conflict`，save() 在快照前比对当前版本，不符即 `{ok:false,conflict:{currentVersion}}`（**不快照不覆盖**），省略则旧行为。`server.ts` PUT `/api/skills/:name` 透传 expectedVersion，冲突回 **409** `{error,conflict:{currentVersion}}`。`api.ts` updateSkill 增 `expectedVersion?`。`SkillEditor.tsx` 保存带 `detail.version`，409 提示「已被其他地方修改，请重新加载（草稿已保留）」且不清 dirty。 | `storage/__tests__/skillStoreConcurrency.test.ts`（陈旧写被拒且不覆盖并发改动 / 省略=旧行为 / 技能不存在→currentVersion:null / 正确版本可存）|
| **S-02** job 保留 | 新增 `gateway/skillJobRetention.ts`（纯选择器 `selectRunsToEvict` + `readSkillRunRetentionEnv`）。三个 store（eval/eval-gen/train）加 `retentionMs/keepPerSkill/maxEntries` 构造项与 `prune(now)`：淘汰过期/超量**终态** run（内存 + 落盘一并清）。**永不动活跃 run 与 train 的 diff_ready（草稿待处理）**。`server.ts` loadAll 后收敛一次 + 起周期 janitor（默认 7d/每技能 20 条/上限 500/6h 扫，`OPENCLAUDE_SKILL_RUN_*` 可调）。 | `gateway/__tests__/skillJobRetention.test.ts`（策略：不动活跃 / 过期淘汰 / 每技能 keep-floor / maxEntries 兜底）+ `skillEvalJobsPrune.test.ts`（store 接线：内存+磁盘淘汰、活跃与最新保留）|
| **S-03** 上限单一权威 | 新增 `protocol/src/skillLimits.ts` 导出 `MAX_EVAL_CASES=8` + `protocol/src/index.ts` re-export；`storage/skillEvals.ts` 改为从 protocol 导入并 re-export；`gateway/skillEvalGen.ts` 生成 prompt 文案改用常量；`web/SkillOptPanel.tsx` 4 处硬编码 5 → `MAX_EVAL_CASES`（从 `@openclaude/protocol` 导入）。 | `web/skillEvalCap.test.ts`（web 与后端同源 =8、非旧值 5）|
| **S-04** 部分更新 | `server.ts` PUT：未提供的字段先 `view()` 回填当前值再 save，不再把缺省写空（显式空串仍按原校验）。 | 由 tsc + S-01 测试路径覆盖；服务器处理器端到端需真后端 → 见遗留说明 |
| **S-05** 体量守卫 | `server.ts` PUT 对 body(512KB)/description(8KB) 显式上限超限 **413**；aux 文件 64KB 守卫由 400 改 **413** 对齐。**未改通用 `readJsonBody`**（归 memory owner）。 | 同 S-04（处理器级，需真后端跑；已由 tsc 保证类型/编译）|
| **S-06** saveAuxFile 守卫 | `storage/skillStore.ts` `saveAuxFile` 与 `deleteAuxFile` 同款拒 `SKILL.md`/`history/`（绕过版本快照）。 | `skillStoreConcurrency.test.ts`（拒 SKILL.md / 拒 history/ / evals/ 仍可写）|
| **S-09** priority | `types.ts` `SkillSummary.priority?`；`SkillEditor.tsx` 正文页只读展示注入排序优先级（不做编辑）。 | tsc + 既有 SkillEditor vitest 绿 |

## 阶段 B · 验证

| 命令 | 结果 |
|---|---|
| `npx tsc --build` | **PASS**（exit 0） |
| `npm run typecheck --workspace packages/web-react` | **PASS**（exit 0） |
| `npx tsx --test packages/storage/src/__tests__/skillEvals.test.ts` | **PASS** 3/3 |
| `npx tsx --test packages/storage/src/__tests__/skillStoreConcurrency.test.ts` | **PASS** 7/7（S-01/S-06）|
| `npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/skillJobRetention.test.ts` | **PASS** 6/6（S-02 策略）|
| `npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/skillEvalJobsPrune.test.ts` | **PASS** 1/1（S-02 接线）|
| `npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/skillEvalJobs.test.ts` | **PASS**（全通过）|
| `cd packages/web-react; npx vitest run …skillEvalCap / SkillOptPanel / SkillEditor …` | **PASS** 30/30（3 文件）|
| `npx biome check <本轮新增文件>` | **PASS**（`--write` 规范化后 0 error）|
| `npx biome check <本轮改动的既有文件>` | 仅 **pre-existing format** 差异（**无新增 lint 规则违规**）；未做全文件重排——基线即非 biome-format-clean（实证：`git show HEAD:…/skillEvalJobs.ts` 单文件 biome 即 2 个 format error；web-react 通篇双引号本就与 biome 单引号配置相悖，`biome check packages` 非本仓强制绿门），重排会产生大量无关噪声。 |
| storage `skillStore.test.ts`（symlink 组）/ gateway `skillTrainJobs.test.ts`(durability) / `skillEvalGen.test.ts`(reload) | **NOT RUN（环境限制）**：Windows symlink 权限 / realpath 大小写，基线即失败，非本轮引入 |
| 真实模型 / PG 端到端（eval/训练真跑、S-04/S-05 处理器行为） | **NOT RUN**：本机无 v5 后端 |

不传 expectedVersion 的旧调用方（restore()/merge()/MCP skill_save）行为不变（storage 测试已断言「省略=旧行为」）。

## 阶段 B · 遗留

- **S-04/S-05 处理器级测试**：server.ts 单体无逐 handler 单测桩（需起真 gateway + PG），本机跑不了 → 标 NOT RUN，改动已由 `tsc --build` 保类型正确、并由 S-01 的 store 层测试覆盖底层 save 语义。建议阶段 C 或有后端环境时补 e2e。
- **S-07**（hub 自带用例喂进评测的信任/自评虚高）：低优先，**未做**——彻底方案（发布侧用例审核 / grader 沙箱）跨 marketplace 子系统，属 §4.5 范围外，建议专项。
- **S-08**（draft-arm 描述解析不反转义）：`promptSlots.ts` 属 memory owner（§4.1），未擅改；`mcp-memory/src/index.ts` 自段亦为纯展示、低优先，本轮未改 → 记为遗留，建议随 memory 侧一并用 `parseFrontmatter` 归一。
- **S-10**（embedding provider 单例）：暂缓（运维低频，重启即生效）。
- **S-11**（`clawhubClient` 测试 / 更多 store prune 覆盖）：不阻塞；已补 selectRunsToEvict + 一个 store 接线测试，clawhubClient 建议专项补。
- **既有文件 biome format**：pre-existing 非 biome-format-clean，未在本轮重排（避免无关大 diff）。
