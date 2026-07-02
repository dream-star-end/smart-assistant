# V5 Skill 自我进化机制 RFC(2026-07-02)

> 背景:boss 看到关于「skill 持续演进」的文章(评测系统迭代 skill;原则→SKILL.md,
> 稳定知识→references/,重复动作→scripts/,素材→assets/,验收→tests//evals/),
> 要求全面梳理当前 skill 机制并评估 v5 商业版引入自进化的可行性。
> 调研结论:该观点是对 Anthropic 官方两条主线的转述 —— ①《Skill authoring best
> practices》的目录结构约定;②skill-creator 的评测迭代机制(claude.com 博客
> 《Improving skill-creator: test, measure, and refine agent skills》+ agentskills.io
> 《Evaluating skill output quality》)。注:`tests/` 非官方约定,官方是 `evals/evals.json`。

## 一、v5 当前 skill 机制全景(现状)

| 层面 | 现状 | 权威位置 |
|---|---|---|
| 存储 | **skill = 目录**,SkillStore 已支持多文件(`files[]` 相对路径,如 `scripts/run.sh`),`references/` 已在设计注释中作为 tier-3 渐进披露 | `storage/skillStore.ts` |
| 分层 | 四层 overlay:platform baseline(ro) > agent-seed(ro) > shared(用户级 rw,唯一写入层) > legacy(per-agent);非默认 agent 只见 baseline+自己 | `buildAgentSkillStore` |
| agent 工具 | `skill_list/search/view/save/delete`(mcp-memory);语义检索(embedding) | `mcp-memory/index.ts` |
| 自动沉淀 | promptSlots「技能自生成」纪律:3+ 工具调用复杂任务后主动 `skill_save`;cron 维护任务(daily-reflection/skill-check)定期复检 | `promptSlots.ts` / 平台 cron |
| 训练(半个进化) | **SkillOpt**(v1.0.349):锁 DeepSeek 后台跑,从近期真实会话挖模式 → `skill_propose` 产**草稿** → 用户 diff 确认 merge(草稿门,权威库不被自动改);仅用户自建 skill | `gateway/skillTrain.ts` + train/drafts/merge HTTP API |
| 市场 | 发布→静态扫描→人审→上架;安装 pin 版本+可更新(本周上线);**工件 = 单个 SKILL.md**(rawSkillMd),不支持多文件 | `marketplace/*` |
| 评测 | **完全没有**。skill 好不好全凭主观;SkillOpt 草稿的验收 = 用户肉眼看 diff | — |

**与官方最佳实践的差距(按重要度)**:
1. **无 evals**:没有用例、断言、基线对比;skill 改动(无论人改还是 SkillOpt 草稿)无法回答"变好了还是变坏了"。这是文章核心,也是我们最大缺口。
2. **结构约定未成文**:存储层支持多文件,但没有 SKILL.md<500 行/references//scripts//assets/ 的平台规范,skill_save 只写单体 SKILL.md,平台 baseline skill 也多为单体。
3. **市场单文件工件**:多文件 skill 无法上架/分发(hub sync 只写 SKILL.md),市场技能天然被锁死在"纯文字启发式"形态,scripts/ 的可靠性收益进不了市场。
4. **description 触发率没有专项优化**:skill 没被选中(误触/漏触)这类失败与正文质量无关,官方有独立的 should/should-not-trigger 调优环。

## 二、调研要点(可直接借用的机制,来源见文末)

- **evals/evals.json**:`{id, prompt, expected_output, files, assertions[]}`;起步 2-3 个用例,断言在看到首轮输出后再补。
- **双跑基线**:每用例跑 `with_skill` / `without_skill`(改进旧 skill 时基线=编辑前快照);**必须干净上下文**(subagent 隔离);记录 tokens/时长。
- **评分分职**:grader(逐断言 PASS 须给证据,机械断言下沉脚本)+ comparator(LLM-judge 盲测 A/B,补"都过断言但质量差"盲区)。
- **benchmark delta**:with/without 的 pass_rate/token/时长均值±方差 → "skill 买到什么 vs 花掉什么"的量化判据,可接 CI 做回归。
- **闭环纪律**:失败断言+人反馈+transcript 喂给改进 agent → 出新版 → 全量重跑;从反馈**泛化**而非对用例 overfit;pass rate 平台期先试**删**指令;**每轮重复手写的 helper 脚本 → 沉淀进 scripts/**(scripts/ 的进化来源);模型升级后用 evals 复检"能力增强型"skill 是否该退役。
- **description 调优**:生成 should-trigger / should-not-trigger 两组 prompt 测触发命中率,独立自动闭环。

## 三、可行性结论

**能引入,且落点极佳**:v5 已有 SkillOpt(草稿门+训练会话)、delegate_task(干净上下文 subagent)、按量计费(评测成本可核算)、多文件 SkillStore——自进化闭环缺的只是「评测」这一环,不是从零造轮子,而是**给 SkillOpt 补上 evals 验收**。商业版特有的三个约束必须前置设计:

1. **成本归属**:双跑×用例×迭代是真实模型消耗。建议:用户自建 skill 的评测计入用户积分(训练已如此);平台 baseline/市场审核评测走平台侧预算(锁 deepseek-v4-flash 控成本)。
2. **scripts/ 安全**:市场技能带可执行脚本 = 分发任意代码。市场侧 scripts 支持必须配静态扫描扩展+人审明示("含 N 个脚本"逐个展示)+容器沙箱本就隔离;首期可先只放开 references/(纯文档,风险≈正文),scripts/ 缓一期。
3. **多租户隔离**:评测在用户自己容器内跑(与 SkillOpt 同轨),不引入跨租户执行面。

## 四、分阶段方案

**P0 — 结构规范 + evals 地基(1 个迭代)**
- 平台规范成文:SKILL.md<500 行、references//scripts//assets//evals/ 语义,写进 skill-creator 类平台 baseline skill + promptSlots「技能自生成」段,让 agent 沉淀技能时就按结构产出(skill_save 已能写多文件目录?若不能,扩 skill_save 支持 files 参数)。
- evals 格式落地:`evals/evals.json` schema(id/prompt/assertions),`skill_view` 附带 evals 存在性;新增 mcp 工具 `skill_eval_run(name)` 雏形:delegate_task 起隔离 subagent 跑用例,grader 走断言+证据,结果落 `evals/last-run.json`。

**P1 — SkillOpt 闭环升级(核心交付)**
- 训练 run 产草稿后**自动跑 evals**:draft vs 当前版(双跑),diff 面板展示 benchmark delta(通过率/token),用户带着数据确认 merge —— 「草稿门」升级成「评测门」。
- 无 evals 的 skill:训练 agent 先提议 2-3 个用例(也是草稿,一并确认),下轮起有基线。
- description 触发率调优作为训练的独立 proposal 类型。

**P2 — 市场与平台侧**
- 市场工件扩多文件(bundle 格式 + hub sync 多文件写入 + 审核 UI 逐文件展示);先 references/ 后 scripts/。
- 上架门槛引入 evals:提交带 evals 的技能展示 delta 徽章("实测提升 xx%"),审核者可一键跑评测;平台 baseline skill 接部署前回归(CI:模型/镜像升级后全量重跑 baseline evals,退化即阻断)。

**P3 — 自动化演进(远期)**
- 定期(cron)对高频使用 skill 自动跑评测回归;失败自动开 SkillOpt 训练 run;模型升级触发"能力增强型 skill 退役复检"。

## 五、建议决策点(boss 拍板)

1. P0+P1 先行(不动市场,风险最小、直击"改 skill 不知好坏"痛点)?
2. 评测模型锁 deepseek-v4-flash(成本)还是跟训练同款 pro(质量)?
3. 市场多文件(P2)是否要——影响市场工件格式(需迁移设计),越晚改成本越高;若认可,建议 P2 提前做**格式预留**(artifact bundle 字段),内容后补。

## 来源

- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills
- https://agentskills.io/skill-creation/evaluating-skills
- https://github.com/anthropics/skills(skill-creator:agents/grader·comparator·analyzer + scripts/run_eval 等)
- 中文转述:知乎《告别手动优化:从新版 Skill-creator 看 Agent Skills 的评估和优化》、IceYao《Agent Skills 工程化深度解析》、阿里云老金《火爆全网的 Skill 自己怎么做》
