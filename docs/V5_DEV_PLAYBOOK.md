# V5 商业版开发与问题定位手册(权威版)

> 本文是 v5(Aurora)商业版**需求开发、问题定位、部署上线**的单一权威手册。
> Codex 与 Claude Code 在做任何 v5 工作前必须先读本文;与 CLAUDE.md/AGENTS.md 冲突时,守更严格的一条。
> 最后校准:2026-07-05(canonical `feat/v5-aurora-rewrite` @ 206f6494,线上 v5-0dbfca25)。

---

## 0. 一页架构地图(定位问题前先对号入座)

```
用户浏览器(claudeai.chat)
  │  Caddy:@v5user 路由(users.v5_migrated_at 权威 + oc_v5user cookie;@v5pay 按 path)
  ▼
master: openclaude-v5.service(kl-mirror,127.0.0.1:18790)
  │  代码 /opt/openclaude/openclaude-v5(rsync 自 canonical worktree)
  │  env  /etc/openclaude/commercial-v5.env(= v3 env 继承 − REMOVE_KEYS + overrides,见 §4.4)
  │  会话 /root/.openclaude-v5/sessions.db(client_sessions 表)
  │  日志 /var/log/openclaude-v5.log
  │  共享 PG/Redis(与 v3 同库:身份/计费/账号池/市场;OC_RUNTIME_CHANNEL=v5 控制面静默)
  │
  ├─► egress: openclaude-v5-egress.service(172.31.0.1:18892,LLM 出站面)
  │     /v1/messages 本地 anthropicProxy 全链;其余转发 master 控制口 127.0.0.1:18894
  │     日志 /var/log/openclaude-v5-egress.log;master 重启不断流;改它必须 deploy-v5.sh --egress
  │
  └─► 用户容器(docker,openclaude-v5-net 172.31/16,镜像 openclaude/openclaude-runtime:v5-ccb-*)
        容器内 gateway(packages/gateway)= 真正执行 turn 的进程
        引擎层 EngineAdapter:CcbAdapter(claude-code-best)/ CodexAdapter(codex app-server)
        /api/skills|cron|memory|agents 等管理面 = 容器代理路径(改了必须重建 runtime image!)
        skill:平台 baseline(OC_V3_CCB_BASELINE_DIR=v5 树 ro bind)+ marketplace hub(syncMarketplaceHub 落盘)
```

**前端**:`packages/web-react`(React/Vite SPA)。chat 状态机 `lib/chat/reducer.ts`(帧翻译/守卫)+ `socket.ts`(WS/重连/持久化编排)+ `lib/persist.ts`(IndexedDB 镜像 + server-wins 合并纯函数)。服务端历史只含 `assistant|thinking|tool` 三种 role(server-authored 通道),**团队卡(agent-group/delegate-progress)是 client-owned**,只活在 IndexedDB——这是一整类"重开丢卡"问题的根源,见 §3.3。

**计费**:双钱包 `spendTwoBucket` 唯一扣费收口;period_credits(期内)优先于 users.credits(持久);turn 级 idle-timeout 免单;codex 计费经 bridge journal 收敛。

**权威源速查**:模型可见性=DB(pricing/models);agent 数据=collaboratorAgents(source==='marketplace');平台预设=platformPresets;团队卡展示字段=`@openclaude/protocol/teamCards` 的 `TEAM_CARD_CLIENT_DISPLAY_FIELDS`(服务端 strip 白名单与前端回填清单同源);当前活跃段判定=`web-react components/chat/turnSegment.ts`;思考档位=protocol allowedOutputConfigEfforts。

---

## 1. 角色分工体系(Codex × Claude Code)

个人版里有两个 AI 工位,固定分工,不要混用:

| 阶段 | 主责 | 说明 |
|---|---|---|
| 需求调研/方案 | CC 起草 → **Codex 审方案** | CLAUDE.md 强制:方案先过 Codex 再写码 |
| 实现 | CC(worktree 隔离) | 多任务并行时按 §2.3 文件所有权分工 |
| 代码审计 | **Codex**(codex-review-loop skill) | 迭代到 PASS 才算完成;prompt 遵守上下文经济(大 diff 让 Codex 自己 `git diff`,不贴全文) |
| 独立视角排查 | Codex | CC 卡住/怀疑自己结论时,把"现象+已排除项"丢给 Codex 独立复查 |
| 部署 | CC 按 §4 执行 | Codex 不做部署操作 |

**给较弱模型的三条铁律**(Fable 退场后尤其重要):
1. **不猜,先取证**。任何"应该是 X"都要用命令验证(git log / 线上 grep / 实跑测试)。本手册每个流程都带验证命令,照抄。
2. **改前找权威源**。v5 大量问题源于双权威(两份清单/两套机制/两处 seed)。动手前先问:这个数据/行为的单一权威在哪?若发现第二份,先收敛再改。
3. **完成的定义 = 测试实跑通过 + Codex PASS + 按 §4 分类部署 + smoke 通过**。缺一项就不许说"已完成"。

---

## 2. 需求开发工作流(标准路径)

### 2.1 开工前
```bash
cd /opt/openclaude/openclaude-v3            # canonical(v3 分支 checkout,只做集成不做开发)
git worktree add ../openclaude-v5-<slug> -b feat/v5-<slug> feat/v5-aurora-rewrite
```
- v5 的基永远是 `feat/v5-aurora-rewrite`(**单一 canonical 分支**;部署树=`/opt/openclaude/openclaude-v5-aurora`)。
- 新 worktree 无依赖时,从部署树硬链复制(秒级):
  `cp -al /opt/openclaude/openclaude-v5-aurora/node_modules ../openclaude-v5-<slug>/node_modules`
  ⚠️ 坑:某些 worktree 的 node_modules 是**指向别的 worktree 的 symlink**,`@openclaude/*` 会解析到别人的源码树。校验:`readlink -f node_modules/@openclaude/protocol` 必须落在自己树内;不对就做本地 shim:
  `mkdir -p packages/<pkg>/node_modules/@openclaude && ln -sfn ../../../protocol packages/<pkg>/node_modules/@openclaude/protocol`
- 先充分调研(git log 相关文件、找既有抽象),方案过 Codex,再写码。

### 2.2 v5 设计原则(与 v3 的关键差异)
- **v5 未全量上线 → 放开走最优解**:发现次优结构就大胆重构(换抽象/删旧机制/改数据模型),不为"改动小"迁就。架构妥协零容忍;v3 仍守现网约束。
- 判断标准:worktree 基于 feat/v5-aurora-rewrite → 最优解;基于 v3 → 现网纪律。

### 2.3 多任务并行(多 agent 同 worktree)
按**包级文件所有权**切分,严禁交叉写:
- gateway 后端(server.ts/engine)| commercial+deploy | web-react components | web-react lib(chat/persist/hooks)| storage/protocol
- 每个 agent 结束只报告不 commit;集成者逐个验收(看 diff+实跑其测试)后按主题分批提交。

### 2.4 测试(每层的实跑命令)
```bash
npm run typecheck                                   # 全仓 tsc --build(必须干净)
npm run test:gateway                                # node tsx --test(≈1255 个)
cd packages/web-react && npx vitest run             # ≈433 个
npm run test:storage                                # ≈224 个
npm run test:commercial:unit                        # 本机缺 PG/Redis 会有 ~70 个存量环境失败!
```
**commercial unit 失败判定法**(不许因存量失败误判,也不许漏掉新增失败):
```bash
# 在基线 commit 的树与你的树各跑一次,diff 失败名单;你的失败集必须 ⊆ 基线失败集
npm run test:commercial:unit 2>&1 | grep '^not ok' | sed 's/^not ok [0-9]* - //' | sort > /tmp/fails-{base,mine}.txt
diff /tmp/fails-base.txt /tmp/fails-mine.txt
```
- 测试必须是**行为断言**(帧序列驱动 reducer/mock WS/真 DB),不是对源码文本的 regex(那只能防删行,防不了行为)。prompt 驱动的行为(团队模式规则等)本质不可单测——这是设计信号,应改为代码硬编排,而不是写 regex 测试。
- lint 红线:**不跑 biome --write 全文件 reformat**;只手工修自己引入的违规。

### 2.5 合并与收尾
- 实现完 → Codex 审计到 PASS → 合并经 canonical(`git merge --no-ff`,中文合并信息说明"批次内容+验证结果")。
- 合并后**只保留 canonical + 未合并分支**:`git branch --merged feat/v5-aurora-rewrite` 逐个删本地+远端分支、`git worktree remove`、`git worktree prune`。注意在 v3 checkout 里 `git branch -d` 按 v3 判断"未合并",要用 `git merge-base --is-ancestor <br> feat/v5-aurora-rewrite && git branch -D <br>` 守卫式强删。
- push:`git push origin feat/v5-aurora-rewrite`。

---

## 3. 问题定位流程(按症状路由)

### 3.0 万能第一步
```bash
ssh kl-mirror 'curl -fsS http://127.0.0.1:18790/healthz'   # v5 master(channel:v5, schedulers)
ssh kl-mirror 'curl -fsS http://127.0.0.1:18790/version'   # 线上跑的是哪个 commit ← 先确认!
ssh kl-mirror 'curl -fsS http://172.31.0.1:18892/internal/v5/egress-health'
ssh kl-mirror 'curl -fsS http://127.0.0.1:18789/healthz'   # v3 应始终不受影响
```
**大量"bug"其实是"修复没上线/没进镜像/没进 dist"。先比对 /version 与 canonical tip,再看 §4 的生效面矩阵。**

### 3.1 前端问题(渲染/交互/移动端)
1. 确认线上 dist 是否含改动:`ssh kl-mirror 'grep -rl "<特征串>" /opt/openclaude/openclaude-v5/packages/web-react/dist/assets/'`(SPA 有缓存,改 dist 必须重启 master)。
2. 复现进单测:chat 帧问题构造帧序列打 `applyOutboundMessage`;持久化问题打 persist 纯函数。工具:`msgFrame()`/`sess()` in `lib/chat/chat.test.ts`。
3. 帧被吞时查守卫链(reducer.ts §3/§11 顺序):frameSeq 去重 → server域 stale 截止(`_trackerResetServerTs`,同域比较)→ teardown 3min 时间窗 → agent 切换守卫。跨时钟域比较(frame.ts=server钟 vs Date.now()=客户端钟)是历史坑,新代码禁止引入。
4. 移动端:iOS 键盘/视口=visualViewport 写 CSS var(App.tsx realign + styles.css `#root position:fixed`);鸿蒙 ArkWeb FileList 必须在事件入口快照(live FileList 会被就地清空);排查靠 Caddy access log。
5. 渲染崩溃已有 per-message ErrorBoundary(MessageBoundary.tsx)兜底,白屏=看它的 console.error 消息 id。

### 3.2 turn 执行/引擎问题
1. **ground truth 是容器内 runner 进程 environ,不是 docker logs**:
   `ssh kl-mirror 'docker ps --format "{{.Names}} {{.Image}}"'` 找到容器 → `docker exec <c> sh -c "cat /proc/<pid>/environ | tr '\0' '\n' | grep -E 'OPENCLAUDE_AGENT_ID|SESSION_KEY|ANTHROPIC_BASE_URL'"`。
2. 会话/消息落库查 master:`sqlite3 /root/.openclaude-v5/sessions.db "select ... from client_sessions"`(键形如 `c:<uid>` 分租)。
3. codex 引擎:官方 OAuth only,数据面必须走绑定账号的 egress 代理(拔代理应 503=fail-closed);账号池按 runtime_channel 圈定;遥测面已双层封堵。
4. 委派/团队:hidden-reviewer 有每父 turn ≤3 次硬熔断(server.ts HiddenDelegateGuard,429);delegate 有 idle 5min/hard 45min 超时,Stop 级联中断;一次性委派子会话收尾即 destroySession(2026-07-07,warm runner 不留存)。
5. **"客户端转圈不止但服务端其实跑完了"**(团队模式高发,2026-07-07 事故):turn 是否真在飞看 session 双计数(`_activeTurnCount` engine 级 + `_activeClientTurnCount` 客户 turn 级,含 review 编排窗口),**别看 runner.isRunning(warm runner 恒 true)**。恢复链权威:hello 重连对账(`_shouldPushTurnInterruptedFinal`→completed 推 meta.reconcile 静默 final / errored 推 service_restart 文案)+ resume_failed→REST 全量对账 + review 迟到团队卡 persistLateTurnArtifacts 补 drain。ring 帧分级(delegate_progress/turn_status=progress 级先淘,contentLossSeq 水位线判回放),团队进度帧 >15帧/s 冲穿 ring 属预期,content 不应受累。取证三件套:容器 docker logs 的 `delegate`/`team_review`/`verification verdict` 行 + master /var/log/openclaude-v5.log 的 `userChatBridge closed(cause)`/`resume replay miss` + client_sessions.last_at 对时间线。

### 3.3 会话历史/持久化问题(高频类)
心智模型:**server 历史(sessions.db)只有 assistant|thinking|tool;用户行走 POST /user-message;团队卡只在客户端 IndexedDB**。合并语义在 `lib/persist.ts`:
- full 合并 `mergeFullServerWins`:server 权威在前,保留尾部乐观段 + 中段 local-only user 行 + 中段 local-only 团队卡;
- 同 id"server tool 行 vs 本地已转 agent-group 富卡"→ 富卡为底回填完成态;
- `syncSession`(resume_failed reconcile)走 applyServerMessages 同一收口,**禁止整段替换**。
- ~~跨设备/清缓存团队历史必丢~~ **已根治**(P2 批次2):handleDelegateTask 收尾产出 server-authored agent-group 骨架行(runId 去重 local-wins),跨设备可见团队结构+终态+成本;过程 childBlocks 树仍仅本设备 IndexedDB(有意取舍)。

### 3.4 计费问题
usage_records + journal 双查;零输出免单/turn 级 idle 免单已内建;codex 跨桥重连计费走 journal 权威。造数验证用 psql 必须显式 COMMIT。

### 3.5 市场/技能问题
市场权威=master PG;容器侧靠 `syncMarketplaceHub`(已内建单飞+5s TTL+限频 warn 日志,"装了不显示"先看容器日志里的 sync warn)。管理面读技能在**容器内 gateway** 执行(生效面=runtime image)。用户向 skill API 必须 `includePlatform:false`(防平台技能泄露)。

### 3.6 遥测/审计
工具失败遥测:显式开关 `OC_TOOL_FAILURE_AUDIT=1`(容器 reporter+master 路由双端;v3 无此键=默认关)。dedupe 走 `idx_aa_agent_event_id` 索引。

---

## 4. 部署上线 SOP(生效面矩阵是核心)

### 4.1 改动分类 → 生效面矩阵(先分类再部署,漏一面=静默不生效)

| 改动位置 | 生效面 | 必做动作 |
|---|---|---|
| master 侧代码(commercial/storage/cli 等) | master 进程 | `deploy-v5.sh`(rsync+restart+smoke) |
| `packages/web-react` 前端 | dist 静态资源 | vite build → 单独 rsync dist → **再重启 master**(SPA 缓存) |
| 容器内 gateway/CCB/baseline skill/entrypoint(packages/gateway、claude-code-best、agent-sandbox/runtime、ccb-baseline*) | **runtime image** | 重建镜像+切 tag(§4.3);纯 baseline skill 例外:bind-mount 源码树,rsync 即生效 |
| `packages/commercial/src/egress/` | egress 进程 | `deploy-v5.sh --egress`(否则 egress 跑旧代码!) |
| `deploy/v5/commercial-v5.env.overrides` | 线上 env | **手动同步** /etc/openclaude/commercial-v5.env(增量部署不重生成 env!)改后重启对应进程 |
| `packages/commercial/src/db/migrations/*.sql` | 共享 PG | AUTO_MIGRATE=0 → **人工受控 apply**(§4.5) |

### 4.2 标准部署
```bash
cd /opt/openclaude/openclaude-v5-aurora     # 部署树;必须 clean(脏文件会被 rsync 上去)
git status --porcelain                       # 必须为空
bash scripts/deploy-v5.sh [--egress]         # 快照(.prev.1..5 可 --rollback)+rsync+restart+smoke
# 前端:
cd packages/web-react && npx vite build
rsync -az --delete dist/ kl-mirror:/opt/openclaude/openclaude-v5/packages/web-react/dist/
ssh kl-mirror 'systemctl restart openclaude-v5'
bash scripts/deploy-v5.sh --smoke
```
红线:只从部署树发;绝不手工 rsync+restart 绕过脚本;v3 的 service/env/Caddy 一律不碰。

### 4.3 runtime image 重建
```bash
# 在 kl-mirror 上、源=已部署树。⚠️ 非交互 ssh 必须带 bun 的 PATH,否则 FATAL 没 bun
ssh kl-mirror 'cd /opt/openclaude/openclaude-v5 && nohup env PATH=/root/.bun/bin:$PATH \
  PERSONAL_SRC=/opt/openclaude/openclaude-v5 OC_BUILD_NETWORK_HOST=1 OC_BUILD_SKIP_TAR=1 OC_INCLUDE_CODEX=1 \
  bash packages/commercial/agent-sandbox/build-image.sh v5-ccb-<12位sha> > /tmp/v5-image-build.log 2>&1 &'
# 完成判定:docker images 出现该 tag(日志 grep FATAL 会误报 Dockerfile 里的 echo 字符串)
ssh kl-mirror 'sed -i "s|^OC_RUNTIME_IMAGE=.*|OC_RUNTIME_IMAGE=openclaude/openclaude-runtime:v5-ccb-<sha>|" /etc/openclaude/commercial-v5.env'
# 同步 bump 仓内 overrides 的 OC_RUNTIME_IMAGE(单独 chore commit)+ rsync 该文件到远端树
ssh kl-mirror 'systemctl restart openclaude-v5'   # 新容器用新镜像;存量自然回收(除非明确要求 force recycle)
# 镜像清理:保留 current + 上一版(回滚),其余 docker rmi
```

### 4.4 env 三层模型
`/etc/openclaude/commercial-v5.env` = V3_ENV 继承 − REMOVE_KEYS + overrides + OC_EGRESS_SECRET(保留链)。
**只有 bootstrap 会重新生成**;平时改 overrides 必须手动把差异同步到线上 env(先 `cp env env.bak-<date>`)。改完核对:线上 env 键集 = 继承∪overrides∪secret(双向差集为空)。

### 4.5 迁移人工 apply(0096+ 惯例)
```bash
ssh kl-mirror 'DBURL=$(grep ^DATABASE_URL= /etc/openclaude/commercial-v5.env | cut -d= -f2-); psql "$DBURL" -v ON_ERROR_STOP=1'
BEGIN; <迁移 SQL>; INSERT INTO schema_migrations(version, applied_at) VALUES ('<文件名不带.sql>', now()) ON CONFLICT DO NOTHING; COMMIT;
```
版本记账格式=文件名去 `.sql`(必须与既有行一致,否则 runner 对账守卫会炸);psql 造数/迁移**必须显式 COMMIT**。

### 4.6 发版节奏(2026-07-06 起,P1.5 制度化)
全量现网后告别"随改随发"。规则(可按运营数据调整):
- **常规批次攒窗口发**:非紧急改动合并 canonical 后不立即部署,攒到当日发版窗口(默认每日 1-2 个,北京时间午后/晚间)一次上线;一窗一条面向用户 changelog(改动可感知时)。
- **hotfix 例外**:现网事故/计费错账/安全面可即时发,但仍必须走 deploy-v5.sh+smoke,并在下一窗口补 changelog。
- **发版门**:check:v5 全绿(typecheck+gateway+mcp-memory+storage+web-react+commercial 基线集 diff)+生效面矩阵分类;镜像面改动放量前 canary(agent uid)。
- **单日多批合并**:允许(canonical 持续集成),但部署窗口是节流阀;并行会话共用窗口,部署前必 fetch 核对 tip 与镜像 tag,避免互覆(07-06 教训:egress 面被并行部署漏掉)。

### 4.6b 上线后核验清单
- [ ] `/version` = 预期 commit;smoke 通过(含 OC_EGRESS_SPLIT=1 时 egress 无条件断言)
- [ ] v3 `/healthz` 正常(零影响红线)
- [ ] 前端特征串在 dist 产物里 grep 得到
- [ ] 有容器 on-demand 起来且用新镜像 tag(`docker ps`)
- [ ] 涉及移动端的改动 → 提请 boss 真机(iPhone Safari / 鸿蒙 ArkWeb)验证
- [ ] 更新记忆/文档;清理分支与 worktree(§2.5)

---

## 5. 已登记技术债与触发条件(改到相关区域时必须先看)

| 债 | 内容 | 偿还触发 |
|---|---|---|
| ~~团队卡 server-authored 化~~ **已偿还**(4202986b+ac966d6f,P2 批次2) | 生成点=handleDelegateTask 收尾(parser Agent 排除保留);sink agentGroups[]→master role 'agent-group'(srv-*,_delegateStatus 三态)→storage/前端按 _delegateRunId **local-wins** 去重;server 行=骨架+终态(过程树有意不持久化,本设备 IndexedDB 承载)。**部署红线:master-first**(strict schema 新字段,新 gateway→旧 master 400 fatal-drop 整包)。TeamPanel 同批改按 turn 锚点归组 | — |
| ~~hidden reviewer pipeline 硬编排~~ **已偿还**(9c36c34a,P2 批次3) | 审查触发权威=gateway `_runTeamReviewPass`(队长 final 放行前代码触发,verdict 协议 PASS/NEEDS_FIX 统一,迭代封顶2轮);preamble 软约束已退役;12 条失败路径全 fail-open(队长绝不卡死);runLog isReview/verdict 打标 | — |
| ~~审查成本用户披露~~ **已偿还**(9c36c34a+167f1628) | drain 时按 agent 分组附队长行 usage.delegates[](纯展示,不碰扣费收口);前端裁决徽记+积分明细;粒度=同 agentId 多轮合计 | — |
| ~~可见性黑名单散点~~ **已偿还**(781108ce,P2 批次1) | 权威源上移 @openclaude/protocol agentVisibility(entrypoint 编译期共享,不再手抄);枚举面统一走 `_getAgentsConfigUserView()`/`filterUserVisibleByAgentField`,判定/执行面保留全量 predicate。新增枚举面必须走投影,新增系统 agent 只改 protocol 一处 | — |
| feat/v5-copy-no-ai | 去 AI 措辞 chore(43d0078a)基老未合 | 下次文案批次重做 |
| oc-browser chrome 通道 | v5 已修(--browser chromium),**v3 同病未修** | v3 浏览器问题报障时 |
| ~~委派上下文纯文本~~ **已偿还**(774fa941,P2 批次4) | 委派 prompt 产物纪律(大产物落 generated/ 回传路径+≤1500 字摘要)+回传兜底封顶 4k(OPENCLAUDE_DELEGATE_OUTPUT_CAP,review 输出豁免);显式取舍=基于共享 FS+prompt 纪律,无正式工件 schema | — |
| ~~委派并行无机制~~ **已偿还**(774fa941) | delegate_tasks 复数工具(≤4,Promise.all 走既有端点,per-parent 分桶+有界排队消化) | — |
| ~~普通成员串行无上限~~ **已偿还**(774fa941) | PerTurnDelegationGuard 一套机制两策略:成员默认 8/turn(OPENCLAUDE_TEAM_MEMBER_DELEGATIONS_PER_TURN),超限结构化 429 引导收敛;UX 铁律观察项:正常用户撞线即调大 | — |
| ~~teamMode 全局粘滞开关~~ **已偿还**(P2 批次4 前端) | 会话级 per-session 键+全局偏好默认继承(lib/teamMode.ts),A 关不影响 B,新会话承习惯 | — |
| ~~TeamPanel 聚合脆弱~~ **已偿还**(批次2渲染+批次3并发) | coalesceTeam 改按 turn 锚点(最近 user 消息边界)归组;_activeDelegations 加 per-parent 分桶+review 保留槽 | — |
| ~~landing 团队演示错位~~ **已偿还**(P2 批次4 前端) | 角色=真实三预设+审查员;并行≤3 与 per-parent 并发诚实对齐;账本字段对齐 TeamPanel;仍全虚构示意 | — |
| provision 事务窗口过宽 | provisionV3Container 单 BEGIN 跨 docker create/start 慢操作,idle-in-tx(60s)可杀连接(07-06 事故根因;pg client error 已挂监听不再崩进程 90202532,僵尸 409 已有自愈) | idle-in-tx 规模化 reject 时,把 docker 副作用移出事务(需重构 per-uid lock+cap 门控原子性) |
| ~~v5 告警只入库不推送~~ **已偿还**(3a7e6f53,企微通道) | wecom_bot 通道+v5-only dispatcher(claim 按类型过滤);v3 侧告警亦经共享 outbox 送达企微。**过渡窗口**:v3 旧类型无关 claim 误抢 wecom 行→延迟 1-2min(退役即消失,勿关 v3 告警调度——轮询规则引擎全网唯一)。**v3 退役收尾新增项:轮询告警规则(accountPoolAllDown/LowCapacity 等)必须挪 v5,否则 v3 停服后检测面真空** | — |
| ~~v5 无后台孤儿回收网~~ **部分偿还**(02878333,07-06) | orphanReconcile 已放开 v5-owned(channel 双侧隔离,与 409 自愈错峰幂等,smoke 白名单已登记);**idleSweep/volumeGc 仍钉死**(活跃容器误杀窗口/不可逆删卷) | idleSweep:补 turn 级活跃屏障后再放;volumeGc:v3 退役收尾+观察期结束后单独评估 |

| ~~org 订阅期内桶~~ **已偿还**(二期 8a4c14a9,0115) | 四桶+席位订阅(org-pro/max/ultra 9折池化)+自助开通+席位闸 | — |
| 知识库 org 化 | research_documents/artifacts 租户主键 (user_id,doc_id) + 引用权威链须跨 user 重构 | P3.1 稳定后单独立项 |
| 多 org 归属 | V1 单 active org(uq_user_active_org);放开=删索引+payer 选择+/api/org 显式 org_id | 真实客户需求 |
| org 钱包锁竞争 | 同 org 高并发扣费串行化于 orgs 行锁(spendTwoBucket FOR UPDATE) | 大客户并发异常时改乐观扣减 |
| org settle 归属竞态(接受) | resolveOrgBillingContext 不锁 membership,turn 边界毫秒窗口按解析时刻归属(裁决见该函数注释) | — |
| review 降级披露不入 REST 副本 | deliverHeldFinal 的 disclosure 文案只走流式帧(requestId 复用会撞 request_map 去重,故不随补 persist 落库);客户端恰在该窗口离线且 ring 冲穿才会丢,纯 UX 文案面 | 用户报"审查降级说明刷新后消失" |
| dispatchInbound 预处理窗口不计入 client turn | getOrCreate→首次 submit 之间(mkdir/parseDocument 等 ms 级)hello 重连仍可能误判 turn 未开始(Plan1 既有 follow-up,团队批次未扩) | 该窗口误判实际报障时 |
| reviewer 委派成本归并晚一轮 | review 委派完成晚于 engine persist,其 pending 成本按既有"晚到 pending"语义并入**下一** turn 队长行(钱不丢,行归属晚一轮);根治=master 对 agentGroups-only persist 也 drain(需查同 turn 末条助手行) | 用户逐 turn 对账投诉归属 |
| master bridge ring 未接帧分级 | userChatBridge 的 storeStamped 恒 content 级(v5 回放权威在容器 ring,master 侧仅兜底),暂不影响 | master 侧 resume miss 成为主要报障源时 |

### P3.1 企业版速记(2026-07-06)
- **org 面三层前缀**:`/api/me`(自己)/`/api/org/*`(org-owner/admin 自助,dispatchOrgRoute 单一鉴权收口 + requireOrgRole 每请求 DB 复核)/`/api/admin/orgs*`(平台超管)。org 一律服务端从 membership 推导,不接受客户端 org_id。
- **计费桶序** org_wallet → user_period → user_wallet;全局锁序 **orgs → users → user_subscriptions**(任何未来触 org 层的事务必须先锁 orgs);预检口径含 org 钱包(getOrgSpendableForUser,与扣费参与条件严格一致,两处必须同步改)。
- **org 技能 = marketplace 单机制**:listing.org_id 可见性(orgVisibleFrag 单一谓词)+ org_installs → sync UNION → hub 层;同 slug 个人优先;容器/storage 零改动。
- **报表权威 = 写时打戳**(usage_records.org_id/credit_ledger.org_id),不按当前成员集推导。
- 迁移 0111-0115 已 apply;成员管理授权矩阵权威在数据层事务内(updateMember/removeMember FOR UPDATE 后判),HTTP 层不重复判。
- **三期(07-07)**:landing 企业区块(¥88/席起动态锚点,无折扣叙事)+ 低水位预警(sweeper 第三域,owner 站内信+邮件,notified_at 去重/充值清标记)+ billing 委派伪角色(minRole:'billing'=owner∥billing_delegate,权威收口 requireOrgRole)+ 成员月度限额(ORG_MONTH_SPEND_FILTER 单一口径,spend 钳制超限静默落个人桶)。**企业档与个人版同价**(0117,取消 9 折)。**smoke 已 leader 感知**(OC_CONTROL_PLANE_LEADER=1 → controlPlane true+shared 域白名单;v3 停服跳过零影响断言)。
- **二期(07-07)**:席位订阅 org-pro/max/ultra(scope='org' 进 subscription_plans 单一权威,个人枚举必须 scope='user');四桶 org_period→org_wallet→user_period→user_wallet;自助开通=org_provision 订单 fulfill 原子建 org(冲突→paid+critical 告警人工处置);billing 写面 owner-only;席位闸只拦新进。**教训:preCheck/settle 任何新增 PG 查询,必须同步 userChatBridgeCodexBilling 等 fakePool 测试替身(unhandled SQL 直接 throw→帧超时),且集成门必须实跑该套件**(一期 5d194bb0 漏此,二期二分定位补修)。

---

## 6. 本手册的维护

每次踩到新坑/建立新机制,**当场更新本文对应小节**(部署类进 §4,定位类进 §3,债进 §5),并同步 bump 相关 skill(`~/.claude/skills/v5-*`)。文档腐烂比没有文档更危险。

### 0105 模型与服务商运维页(2026-07-06)速记
- 服务商枚举权威 = protocol STATIC_KEY_PROVIDERS(+codex 虚拟条目);provider_ops 表**稀疏**只存运维字段,首次 PUT 建行 —— 新增 provider 本页零改动,严禁再造种子清单。
- model_pricing 放开价格列编辑的四重护栏:normalizePriceCents 十进制整数分 + DB CHECK>=0 + 逐列审计 + **lock_version 整数乐观锁**(价格列强制 if_match;不要用 updated_at 毫秒比较,timestamptz 微秒会被 pg→JS 截断)。
- per-model default_effort:注入点在 proxy authorize 后(合并不覆盖 client 显式值);适用性按 spec 推导(allowedOutputConfigEfforts 白名单 / strip output_config→不适用 / deepseek+OAuth 透传全枚举)。
- egress latencyProber:transport 语义(GET 上游端点,零配额),dispatcher 必须按 STATIC_PROVIDER_META.egress 复刻;in-flight guard 防 tick 重叠。
