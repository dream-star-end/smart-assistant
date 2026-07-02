# Skill 自进化实施计划(feat/v5-skill-evolution 工作树内部文档)

Boss 指令:P0–P3 逐项全做;评测/训练锁 deepseek-v4-pro;SkillOpt 以实测有用为验收;
**任何消耗用户积分的行为必须显式估算→确认→实报,严禁静默扣费**(自动化一律 opt-in)。
免 Codex,改完直接部署验证(boss 明示)。

## 部署形态
- 容器内(gateway/mcp-memory/storage)改动 → **runtime image 重建**(PATH 加 /root/.bun/bin,
  PERSONAL_SRC=/opt/openclaude/openclaude-v5, OC_BUILD_NETWORK_HOST=1 OC_INCLUDE_CODEX=0 OC_BUILD_SKIP_TAR=1)
- master(commercial)+ 前端 dist → deploy-v5.sh + rsync dist + restart

## 已确认的既有设施
- SkillStore: view(name, subfile) 可读 evals/evals.json;save() 写 writeRoot(shared);多文件 files[]
- SkillDraftStore: drafts/<runId>/<name>/SKILL.md;WriteSkillDraftInput{runId,op,meta,body,rationale?}
- SkillTrainJobStore: run.json 持久化;phase 由工具调用推导;finalize 按实际草稿数;
  训练会话 sessions.getOrCreate({sessionKey:`skilltrain:${runId}`,channel:'skill-train',skillTrainRunId})
  + sessions.submit(session, prompt, onEvent, effort, model, runId)
- SessionStreamEvent 'final' meta 带 inputTokens/outputTokens/cacheRead/cacheCreation → 可累计用量
- /api/public/models 带 input/output/cache_read per_ktok_credits + multiplier → 前端可估算/实报积分
- 训练默认模型已是 deepseek-v4-pro(SKILL_TRAIN_DEFAULT_MODEL),effort max
- bridge allowlist(gateway/bridgeApiAllowlist.ts)是 master 容器代理与容器自校验共用权威

## 实施步骤(commit 粒度)

### Commit A — P0 storage+gateway 评测地基(容器内)
1. storage/skillEvals.ts(新):
   - types: SkillEvalCase{id,prompt,assertions[],expectedOutput?}; SkillEvalsFile{version:1,cases[],autoRegression?:boolean}
   - parseSkillEvalsJson(text)->{ok,file}|{ok:false,errors[]}; serializeSkillEvals(file)
   - caps: MAX_EVAL_CASES=5, MAX_ASSERTIONS=8, prompt<=4000, assertion<=500
2. skillStore.ts: 新增 saveAuxFile(name, relPath, content) — 仅写 writeRoot 内已存在 skill 的
   allowlisted 相对路径(调用方限 evals/evals.json、evals/last-run.json),含 realpath 容器化守卫。
3. skillDraftStore.ts: WriteSkillDraftInput + SkillDraftContent 增可选 evalsJson(草稿 dir 存 evals.json);
   listDrafts/readDraft 带回 hasEvals/evalsJson。
4. mcp-memory skill_propose: 增可选 evals 参数(cases 数组)→ 序列化校验后随草稿落盘。
5. gateway skillEval.ts(新,纯函数):
   - EvalArm='with'|'without'|'draft'; EvalCaseResult{arm,output,tokens{...},assertions[{text,passed,evidence}]}
   - buildEvalCasePrompt(case) / buildGraderPrompt(case, outputsByArm 匿名化 A/B) / parseGraderJson(text)
   - computeBenchmark(results) -> {passRate per arm, tokens per arm, verdict}
6. gateway skillEvalJobs.ts(新): SkillEvalRun{runId,skillName,mode:'baseline'|'draft',trainRunId?,
   status queued/running/grading/done/failed,cases[],results[],usage 累计,startedAt/finishedAt,error}
   持久化 ~/.openclaude/skill-evals/<runId>/run.json(HOME 容器化守卫同 train);loadAll 重启回收 active→failed。
7. gateway server.ts:
   - 路由: GET|PUT /api/skills/:name/evals; POST /api/skills/:name/eval-run {mode?} → 202{runId};
     GET /api/skill-eval/:runId(owned by userId,同 _ownedTrainRun 模式)
   - _runSkillEval 编排: 逐 case 逐 arm 起隔离 session
     sessionKey `skilleval:${runId}:${case.id}:${arm}` channel 'skill-eval' model=pro effort='high';
     submit(case.prompt) 收 final text+usage;然后 grader session(同 run 单会话多 turn,model=pro)
     每 case 一 turn 输出 JSON(两 arm 断言判定+盲测偏好,arm 顺序随机匿名);容错解析。
   - arm 控制经 getOrCreate 新选项 skillEvalExclude?:string / skillEvalDraftDir?:{name,dir}:
     → subprocessRunner env OPENCLAUDE_SKILL_EVAL_EXCLUDE / _DRAFT_NAME/_DRAFT_DIR
     → promptSlots ctx 同名字段(SKILLS slot 隐藏/替换该技能行)
   - mcp-memory buildSkillStore 包一层: EXCLUDE → list/search 滤掉+view 返 null;
     DRAFT → view(name) 返草稿 body,list 中该行 description 用草稿。
   - 用户技能限定(includePlatform:false view),同 train 的 404 语义
8. bridgeApiAllowlist.ts 增 3 条(evals GET/PUT、eval-run POST、skill-eval/:id GET),proxyFromCommercial:true
9. 结构规范:新 baseline skill `skill-authoring`(SKILL.md<500行/references//scripts//assets//evals 语义
   + evals.json 格式 + "重复 helper→scripts/");promptSlots 技能自生成段指向它。

### Commit B — P1 SkillOpt 评测门 + 用量累计
10. SkillTrainRun 增 usage{inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,turns}
    + evalRunId?:string|null + autoEval:boolean;applyEvent 在 final meta 累计 usage(train);
    eval run 同样累计(eval 的每 session final)。
11. _handleSkillTrainStart body 增 {autoEval?:boolean}(默认 true);finalize 后 drafts>0 && autoEval:
    对每个 update/create 草稿且目标技能有 evals(或草稿带 evalsJson)→ 起 eval run mode 'draft'
    (arm=draft vs with(现版)),evalRunId 记回 train run(多草稿:v1 只评 targetSkill 同名草稿——
    单技能训练本就单草稿为主;auto-select 训练不autoEval,提示手动)。
12. 训练 prompt(skillTrain.ts): 无 evals 的目标技能 → 要求先提议 2-3 个评测用例(skill_propose evals 参数);
    有 evals → 告知草稿将被自动评测,写作以通过断言为准;继续禁 ALWAYS/NEVER 空话。
13. 训练/评测会话是否计费确认: usage 走正常 billing(用户积分)——不改计费,改**披露**。

### Commit C — 前端(P1 UI + 成本显式化)
14. types+api: SkillEvalCase/SkillEvalsFile/SkillEvalRun/SkillTrainRun(前端形);api fns:
    getSkillEvals/putSkillEvals/startSkillEvalRun/getSkillEvalRun/trainSkill/getSkillTrainRun/
    listSkillDrafts/readSkillDraft/commentSkillTrainRun/mergeSkillTrainRun/discardSkillTrainRun
    (对应 gateway /api/skill-training/* 既有端点——先读 server.ts 确认 drafts/diff/comment/merge 形状!)
15. lib/skillRunCost.ts(纯函数+测试): estimateEvalRun(cases,arms,rates)、estimateTrainRun(rates)、
    creditsForUsage(usage,rates)(与 master 计费同公式:ktok×rate×multiplier)、fmtCredits。
16. SkillsPanel 展开区重构:三个 tab 或分段 — 正文 / 评测 / 训练优化。
    - 评测: 用例列表编辑(prompt+assertions 行编辑,≤5 用例)、保存(PUT evals)、
      「运行评测」→ CostConfirm 对话框(费率来源 /api/public/models,估算区间,红字"将消耗你的积分")
      → 轮询 run → 结果卡(with/without 通过率、每断言明细+证据、实际 tokens+折算积分)。
    - 训练: 「训练优化」→ CostConfirm(pro 模型+自动评测开关+估算)→ 进度(phase)→ diff_ready:
      草稿列表(op 徽章/rationale/正文 diff 折叠对比/评测 delta 徽章(通过率 with vs draft))
      → 合并 / 放弃 / 评论重训(再次确认消耗)。运行中/结束展示实际累计 tokens→积分。
    - 通用 CostConfirmDialog 组件(ui 或 manage 内):标题/明细行/估算/确认文案强制含"消耗积分"。

### Commit D — P2 市场多文件 + delta 徽章(master + 容器 sync)
17. migration 00XX: marketplace_skill_versions ADD COLUMN raw_bundle JSONB NULL
    + benchmark JSONB NULL(发布者自报评测摘要)。v3 忽略(加法)。
18. publish API: files?:[{path,content}](path 白名单前缀 references/|assets/|evals/,禁 scripts/(明确报错"暂不支持"),
    禁 ../、每文件≤64KB、总≤256KB、≤20 个);逐文件 skillScanner 扫描;raw_bundle 存 {path:content};
    benchmark?:{withPassRate,withoutPassRate,cases} 直存(标注发布者自报)。
19. listActiveInstalledArtifacts/internalMarketplaceSync 带 bundle → 容器 syncMarketplaceHub 写多文件
    (storage/marketplaceSync.ts,路径 sanitize 同白名单;删除 stale 文件)。
20. detail/review/pending 带 files 概览 + benchmark;前端: 发布表单附加文件编辑器(路径+内容行);
    详情/审核 显示文件树 + "发布者实测 +X%"徽章(tone info,注明自报);审核 UI 逐文件查看。
21. scripts/run-baseline-skill-evals.sh + docs: canary 容器内对带 evals 的 baseline 技能跑回归
    (eval API 循环),部署 checklist 用;baseline 首个示例 evals 给 `skill-authoring` 自身或 scheduled-tasks。

### Commit E — P3 自动化(opt-in,零静默)
22. evals.json autoRegression:boolean(默认无/false);SkillsPanel 评测区开关,开启弹确认:
    "每日自动回归约消耗 ~N 积分/天,失败会推送提醒",写回 evals.json。
23. gateway 每日 tick(复用 cron 系统 job 或独立 setInterval+落盘 last-regression.json):
    对 autoRegression=true 的用户技能逐个跑 eval run(mode baseline);
    与上次 last-run 对比,通过率下降 → 经 cron deliver 机制推 webchat 消息
    ("技能 X 回归失败:通过率 a%→b%,建议打开管理中心→技能→训练优化";**不自动开训练**)。
    实现为 gateway 内建 daily job(挂 cron.ts 系统 job 清单,deliver webchat,heartbeat 语义防打扰?
    →用 deliver webchat 普通推送);每技能每日至多一次;运行也计入 usage 披露(推送里带消耗)。

### 验证
- 单测: skillEvals parse/serialize、skillEval grader parse/benchmark、skillRunCost、draftStore evals、
  bundle path sanitize;跑 test:gateway/test:storage/test:commercial:unit(对比基线 fail 集)/web vitest。
- e2e(canary): 建用户技能+2 用例 → 运行评测(确认对话框文案含消耗)→ 结果;训练(autoEval)→
  draft delta → merge;发布带 references/ 的技能 → 审核 → 安装 → 容器 hub 多文件落盘;
  autoRegression 开关 → 手动触发每日 tick(缩短间隔 env)→ webchat 推送。
- 镜像重建+容器回收+master deploy+dist。

## 风险备忘
- eval 会话的 skill 排除必须同时覆盖 promptSlots SKILLS 摘要与 mcp skill_* 工具,漏一半就是假基线。
- grader JSON 解析容错(```json 包裹/前后杂文);解析失败该 case 记 failed 不炸整个 run。
- 每 case 会话要新 sessionKey(禁复用,保干净上下文);顺序执行防并发爆容器 pids。
- last-run.json 写回仅 writable 技能;baseline 评测结果只落 skill-evals run 目录。
- v3 兼容:migration 加法列;bridge allowlist 新条目仅新增路径;master 无行为变化(v3 前端不调)。
