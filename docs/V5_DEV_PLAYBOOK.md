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
        /api/skills|cron|memory|agents 等管理面 = 容器代理路径(gateway 源码,走 runtime source release 轴,见 §2 矩阵)
        skill:平台 baseline(A/B 当前 release 的 slot-local 路径 ro bind)+ marketplace hub(syncMarketplaceHub 落盘)
```

**前端**:`packages/web-react`(React/Vite SPA)。chat 状态机 `lib/chat/reducer.ts`(帧翻译/守卫)+ `socket.ts`(WS/重连/持久化编排)+ `lib/persist.ts`(IndexedDB 镜像 + server-wins 合并纯函数)。v2 lossless turn tape 将 `assistant|thinking|tool|agent-group|plan|goal` 及委派 transcript 作为 server-authored 权威；热行只放一个 tape anchor，完整内容在 PG 记录表按 hash 水合。`delegate-progress` 仍是 live 进度投影，但完成后的完整子 Agent block 序列归入 `agent-group` tape，不再依赖单设备 IndexedDB。

**计费**:双钱包 `spendTwoBucket` 唯一扣费收口;period_credits(期内)优先于 users.credits(持久);turn 级 idle-timeout 免单;codex 计费经 bridge journal 收敛。

**权威源速查**:模型可见性=DB(pricing/models);agent 数据=collaboratorAgents(source==='marketplace');平台预设=platformPresets;团队卡展示字段=`@openclaude/protocol/teamCards` 的 `TEAM_CARD_CLIENT_DISPLAY_FIELDS`(服务端 strip 白名单与前端回填清单同源);当前活跃段判定=`web-react components/chat/turnSegment.ts`;思考档位=protocol allowedOutputConfigEfforts。

**记忆(memdir 范式,2026-07-10 起)**:Core 记忆=每条一个 frontmatter 文件(`agents/<id>/memory/<slug>.md`,type: user|feedback|project|reference)+ `agents/<id>/MEMORY.md` 纯索引(**路径不变=跨组件契约**,volumeContextReader/envelope/UI 均读它;首行 marker `<!-- oc-memdir-index v1 -->`)。写入=引擎原生 Write/Edit 直写(CCB/codex 对称,无专用命令);「# Memory」完整指令段由 gateway `buildMemorySlot` **常驻注入**(空记忆也注入;索引 cap 6000、user.md cap 4000)。权威=`storage/memoryDir.ts`:读侧双向对账自愈(补行/剔悬挂,索引可再生,两步写容错)+ 逐行注入扫描(模型直写绕过写侧校验,**读侧才是安全权威**)+ 懒迁移幂等(marker 任意位置判定;老 §-blob 首读自动拆,备份 `.pre-memdir.bak`)。user.md=共享用户画像纯 markdown(`storage/userProfile.ts`,锁+version)。oc-memory CLI 仅剩 session-search/archival(memory 子命令退役,误调打提示 exit 2)。CCB 原生 memdir 在容器内被 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 禁用(subprocessRunner,gate=isV3ContainerRuntime)。**新增 memory 子路由必须同步三处**:容器 gateway server.ts 路由、bridgeApiAllowlist、master `BLOCKED_FOR_USER_RULES`(router.ts 403 兜底;漏第三处=多租户越权面)。

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
3. **常规完成的定义 = 测试实跑通过 + Codex PASS + 按 §4 分类部署 + smoke 通过**。缺一项就不许说
   “已完成”。dx 显式 P0 emergency lane 可在 Phase 1 后只说“止血已上线”；补测、单一 Codex
   审查和受保护 CI/PR 未关账前，不得说任务或根治完成。

---

## 2. 需求开发工作流(标准路径)

### 2.1 开工前
```bash
cd /opt/openclaude/openclaude-v3            # canonical(v3 分支 checkout,只做集成不做开发)
git worktree add ../openclaude-v5-<slug> -b feat/v5-<slug> feat/v5-aurora-rewrite
```
- v5 的基永远是 `feat/v5-aurora-rewrite`(**单一 canonical 分支**;部署树=`/opt/openclaude/openclaude-v5-aurora`)。
- **独立客户端例外**：Windows app 的长期 canonical 是 `feat/v5-windows-app`；`apps/windows/**`、
  Electron、NSIS 和 Windows 原生集成的任务 worktree 必须基于它，PR 也只回它，任务分支必须
  命名为 `<type>/v5-windows-<slug>`。app-only 改动不进 V5 server release queue，禁止运行
  `deploy-v5.sh`。若同时需要 server/protocol/web 兼容改动，先以独立 PR 合入
  `feat/v5-aurora-rewrite`，再用显式 upstream-sync PR 同步到 Windows canonical。
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
- **并行期间禁全局 git 状态操作**(`git stash`/`reset`/`checkout -- .`):stash 内部是"整树 reset+恢复"
  窗口,同 worktree 其他 agent 会在窗口内读到回退内容/空 status(2026-07-10 工具卡批实测竞态,靠
  stash pop 自愈纯属侥幸)。要对比基线用 `git diff HEAD -- <自己的文件>` 或另开只读 worktree。

### 2.4 测试(每层的实跑命令)

> **跨树互斥(硬机制,2026-07-10)**:`test:commercial:unit/integ` 已经由
> `scripts/test-mutex.sh` 包裹 —— 共享 octest PG/端口的测试族在
> `/var/lock/oc-test-commercial.lock` 上全机串行,另一 worktree 在跑时会打印持有者并
> 等待(≤30min)。运行本身还有**执行总超时看门狗**(默认 3600s,`OC_TEST_MUTEX_TIMEOUT`
> 可调):命令挂死(如 §2.4 infra 债)到点整组清场放锁、统一 exit 124 —— 挂死不再无限期
> 占用。多会话并行开发**不需要**人为协调测试时序;若看到"锁被占"就是另一
> 会话在跑,等它即可。绕过 npm script 直接 `npx tsx --test` 跑 commercial 测试 = 违规
> (会撞库,当天误诊 2 小时的教训)。
```bash
npm run typecheck                                   # 全仓 tsc --build(必须干净)
npm run test:gateway                                # node tsx --test(≈1255 个)
cd packages/web-react && npx vitest run             # ≈433 个
cd packages/web-react && npm run test:browser       # 真 Chromium 组件冒烟(见下方红线)
npm run test:storage                                # ≈224 个
npm run test:commercial:unit                        # 本机缺 PG/Redis 会有 ~70 个存量环境失败!
npm run test:commercial:integ:shard -- pr           # PR 门第一梯队 integ(22 文件,真 SQL 行为)
npm run lint:integ-tiers                            # 新增 integ 文件必须登记梯队,否则红
```
🔴 **integ 层不是可选层**(2026-07-26 门禁审计整改):`packages/commercial` 的单测
把"SQL 真行为"显式 delegate 给 `*.integ.test.ts`(`turnDispatchStore.test.ts` /
`turnDispatchReconciler.test.ts` / `preferences.test.ts` 头注释白纸黑字写着"由 integ
覆盖")。此前这 110 个文件 / 1549 个用例在 CI、deploy、playbook 三处都不跑 ——
委派链的下游根本不存在,而每周还在往里加用例。现在:
- **PR 门第一梯队**(`.github/integ-tiers/pr-*.txt`,22 文件)进 `check:v5` 与 CI
  `commercial-integ` job,每 PR 阻塞。它绿 = 能注册 / 能收到验证信 / 能登录 /
  refresh 家族被盗会整族吊销 / 下单加积分 / 同一 request_id 只扣一次钱 /
  会话 tape 能落库能读回 / 迁移链能从零重放 / 新表都有保留策略。
- **其余 87 文件**进 `.github/workflows/v5-integ-nightly.yml`(每日 03:00 沪时),
  失败开工单不阻塞 PR。
- 判绿判据比 unit 的基线 diff 严:`失败集 ⊆ 基线 且 skipped==0 且
  executed>=min-tests 且 TAP plan 完整` —— 四条同时成立(见 §CI 文档)。
  integ 层的 skip 几乎总是 fixture 缺失,而 fixture 缺失必须红:静默 skip
  正是这一层此前长期零执行的成因。
- 本机 fixture:PG `127.0.0.1:55432`(test/test/openclaude_test)、
  Redis `127.0.0.1:56379`。缺任一个,门会红而不是绿。
- 加了新的 `*.integ.test.ts` → 必须登记进 `.github/integ-tiers/` 某个清单,
  否则 `lint:integ-tiers` 红。选梯队的判据只有一条:**它绿了能证明哪一条
  用户可见事实?**
🔴 **用户可感知交互面必须过真浏览器,jsdom 绿不作数**(2026-07-18 附件事故制度化):
jsdom 对"点击→系统行为"类契约恒假阴性 —— label 激活查找走 ownerDocument 而非 tree
scope、fireEvent 非受信不触发 React discrete 同步 flush,「点击添加附件无反应」这类
回归在 jsdom 里**物理上测不出**。凡动 Composer / 消息渲染 / 会话列表等高频交互文件:
- `packages/web-react/browser-tests/`(esbuild bundle 真组件 + playwright-core 受信
  点击,`npm run test:browser`,CI web-react job 必跑)是这类契约的**唯一有效层**;
  新增交互契约(菜单内触发 file input/dialog、原生激活路径、指针序列依赖)在这里加用例,
  且必须**红绿对照**(把修复撤掉跑一遍必须红,恒绿的守门是假守门)。
- 部署后线上旅程由 `scripts/v5-e2e-journey-canary.mjs`(E2E 旅程门,§4.2)兜底。
- 浏览器解析单一权威=`scripts/lib/resolve-browser.mjs`(env OC_E2E_BROWSER→系统
  Chrome→ms-playwright 缓存);找不到浏览器=fail-loud,禁"缺浏览器就跳过"(fail-open)。
🔴 **长任务状态 UI 必须单一归属**:一个状态只进入一个既有反馈面,一个动作只保留一个
主入口。turn 阶段/重试/恢复属于消息区活动行,Stop 属于 Composer,权限属于权限卡；不得把
后端状态枚举逐项翻译成新的常驻卡片或重复按钮。新卡片只有在承载无法由既有组件表达的
独立可操作对象时才允许，并须用移动端真浏览器证明信息不断流、主操作不重复。
**commercial unit 失败判定法**(不许因存量失败误判,也不许漏掉新增失败):
```bash
# 在基线 commit 的树与你的树各跑一次,diff 失败名单;你的失败集必须 ⊆ 基线失败集
npm run test:commercial:unit 2>&1 | grep '^not ok' | sed 's/^not ok [0-9]* - //' | sort > /tmp/fails-{base,mine}.txt
diff /tmp/fails-base.txt /tmp/fails-mine.txt
```
⚠️ **孤儿进程中毒(与上面互斥锁同日定位的第二根因)**:`timeout npx tsx` 只杀 npx 包装,tsx 派生的 node 子进程成孤儿,继续抱着 PG 连接/端口不放 → 机器进入"中毒"状态,之后任何单跑也会挂、且会把互斥锁一直占住。`test-mutex.sh` 已内建 set -m 进程组清理(wrapper 退出/被杀时整组 TERM→KILL,实测含孙进程零残留);**手工/逐文件跑必须也经它包裹**,否则 timeout 再造孤儿:
```bash
# 逐文件 sweep(定位具体挂死文件)的正确姿势:
find packages/commercial/src -name '*.test.ts' ! -name '*.integ.test.ts' | sort | xargs -I{} \
  bash -c 'timeout 120 bash scripts/test-mutex.sh commercial "npx tsx --test --test-force-exit {}" >/dev/null 2>&1 || echo "{}"' | sort
# 两棵树各跑一次,comm -23 mine base 必须为空。禁 -P 并行(全局锁下无收益)。
# 疑似已中毒(跑啥都挂)先清场:ps -eo pid,etime,args | grep 'node.*--test'(etime 分钟级=孤儿)→ kill -9 -- -<pgid>
```
ℹ️ **userChatBridge 挂死已根治(46303b5b,2026-07-10 10:38)**:根因=握手测试丢帧竞态(once listener 背靠背双帧丢第二帧→await 永挂),frameCollector 收口,详见该提交与 §CI 挂死条目。**worktree 基于 46303b5b 之前提交的会跑必挂**——rebase canonical 即解,别再按环境问题排查(当天多个会话在此各误诊 1-2 小时;彼时观察到的 tsx IPC pipe close 不完成是下游症状:await 永挂→子进程不退→抱着 rig 服务器与 IPC 连接)。
🎯 **CI flake 两类根治(d65edb5d,2026-07-11)**——CI 红 ≠ 一定是回归,先对号这两类:
- **web-react 截止线饥饿**:RTL waitFor/findBy 的失败截止线是**真实时钟**,CI 4vCPU 上 vitest 并行有 >1s 调度饥饿窗口。单一权威=`src/test/setup.ts` 的 `configure({asyncUtilTimeout: 5s})` + vite.config `testTimeout: 15s` 梯度;**禁止在单个用例里散装 {timeout}**;时序竞态修交互语义(等按钮 enabled 再点/先等 boot 自动选中落定再操作),不靠加 sleep 或关并行掩盖(实测串行 7m12s vs 并行 ~1m,不关)。此前"本地须 --no-file-parallelism"的规则已被本校准取代。
- **gateway 跨进程锁互踩**:凡"进程域=容器"的 tmpdir 锁(vision slot 锁),node --test 文件级并行共享宿主 /tmp 会互踩 → 测试文件各自 mkdtemp 设 `OPENCLAUDE_VISION_LOCK_DIR`(生产不设,tmpdir 语义不变)。**新增同类 host 级锁时必须同步提供锁域 env 并在测试里隔离。**
- 测试必须是**行为断言**(帧序列驱动 reducer/mock WS/真 DB),不是对源码文本的 regex(那只能防删行,防不了行为)。prompt 驱动的行为(团队模式规则等)本质不可单测——这是设计信号,应改为代码硬编排,而不是写 regex 测试。
- lint 红线:**不跑 biome --write 全文件 reformat**;只手工修自己引入的违规。

### 2.5 合并与收尾
- 实现完 → Codex 审计到 PASS → 在**受保护 PR 合并前**先提交全局发布队列：
  `RQ=$(scripts/v5-release-queue.sh submit --task <slug> --branch <task-branch> --sha "$(git rev-parse HEAD)" --actor <owner>)`。
  `submit` 对同一 branch+SHA 幂等；随后执行
  `scripts/v5-release-queue.sh wait --id "$RQ" --owner <owner>`。只有取得唯一 `active`
  的任务才可合并 PR，后续任务保持未合并，不能让 canonical tip 越过正在 canary/finalize 的批次。
- 受保护 PR/CI 合并完成后，把 canonical 快进到精确远端 merge SHA，再执行
  `scripts/v5-release-queue.sh pin --id "$RQ" --sha "$(git rev-parse HEAD)" --actor <owner>`。
  `pin` 会验证任务 SHA 是 merge SHA 祖先且 canonical HEAD 精确一致；发布全程
  `export OC_V5_RELEASE_QUEUE_ID="$RQ"`。成功 finalize 后才
  `finish --result deployed`；官方 abort/rollback 收敛旧稳定版后用
  `finish --result not-deployed`。队列项跨进程、跨会话持久化，不靠某个 shell 一直存活。
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

**用户报「请求ID」(响应底部 #xxxxxxxx)→ 一条 SQL 定位**(2026-07-10 起,0126 turn_traces,bridge 铸造点登记):
```bash
ssh kl-mirror 'psql "$DATABASE_URL" -c "select * from turn_traces where trace_id='"'"'<完整请求ID>'"'"'"'
# → user_id / session_key / agent / model / 时间;再按 session_key 去容器 sessions.db(usage_log/event_log)
#   或 codex rollout(~/.codex/sessions/<日期>/rollout-*.jsonl)drill down。
# 注意 usage_records.request_id 是**上游请求 id**,与展示的 traceId 不同源,别拿去互查。
# 查不到?236e3834(2026-07-10)之前容器 gateway 无条件自铸 usage.traceId、无视 master 注入,
# 底部请求ID与 turn_traces 是两个 id(双权威源,已收口:dispatchInbound 优先 frame.traceId,
# InboundMessage schema 显式登记该字段)。旧 turn 兜底:按 user + 时间窗在 turn_traces 圈。
```

### 3.1 前端问题(渲染/交互/移动端)
1. 确认线上 dist 是否含改动:`ssh kl-mirror 'grep -rl "<特征串>" /opt/openclaude/openclaude-v5/packages/web-react/dist/assets/'`(SPA 有缓存,改 dist 必须重启 master)。
2. 复现进单测:chat 帧问题构造帧序列打 `applyOutboundMessage`;持久化问题打 persist 纯函数。工具:`msgFrame()`/`sess()` in `lib/chat/chat.test.ts`。
3. 帧被吞时查守卫链(reducer.ts §3/§11 顺序):frameSeq 去重 → server域 stale 截止(`_trackerResetServerTs`,同域比较)→ teardown 3min 时间窗 → agent 切换守卫。跨时钟域比较(frame.ts=server钟 vs Date.now()=客户端钟)是历史坑,新代码禁止引入。
4. 移动端:iOS 键盘/视口=visualViewport 写 CSS var(App.tsx realign + styles.css `#root position:fixed`);鸿蒙 ArkWeb FileList 必须在事件入口快照(live FileList 会被就地清空);排查靠 Caddy access log。
5. 渲染崩溃已有 per-message ErrorBoundary(MessageBoundary.tsx)兜底,白屏=看它的 console.error 消息 id。
6. **签名媒体 URL 点击时权威(2026-07-10 用户 175 "下载不了" 410 死循环教训)**:签名 URL 服务端 TTL 仅 5min,任何**用户手势触发的取媒体**(下载/开原图/新标签)必须在交互那一刻经 `media.tsx::useFreshSignedUrl` 解析,fetch 拿到 410/403 再 forceResign 重签一次;禁止把 `useSignedSrc` 的挂载态 URL 冻结进点击路径(挂载 >5min 后点击必死,且"重试"复用同一死 URL 永不自愈)。锚点原生导航场景优先同步 `peek()` 校正 href,异步重签后程序化开新标签有 Safari 弹窗拦截风险,只做慢路径兜底。

### 3.2 turn 执行/引擎问题
1. **ground truth 是容器内 runner 进程 environ,不是 docker logs**:
   `ssh kl-mirror 'docker ps --format "{{.Names}} {{.Image}}"'` 找到容器 → `docker exec <c> sh -c "cat /proc/<pid>/environ | tr '\0' '\n' | grep -E 'OPENCLAUDE_AGENT_ID|SESSION_KEY|ANTHROPIC_BASE_URL'"`。
2. 会话/消息落库查 master:`sqlite3 /root/.openclaude-v5/sessions.db "select ... from client_sessions"`(键形如 `c:<uid>` 分租)。
3. codex 引擎:官方 OAuth only,数据面必须走绑定账号的 egress 代理(拔代理应 503=fail-closed);账号池按 runtime_channel 圈定;遥测面已双层封堵。
   - **`-c` 配置覆盖对未知裸键静默 no-op**(0.144 实证:`features.imagegen=false` 不报错也不生效,
     权威名是 `features.image_generation`)。任何 feature 开关注入必须容器内 `codex features list`
     对照 effective state 实证,不许按键名想当然。原生生图现已启用;所有 gpt-image-2
     generations/edits 必须经 commercial relay 的固定 50 积分预留与成功结算,不得直连旁路。
4. 委派/团队:hidden-reviewer 有每父 turn ≤3 次硬熔断(server.ts HiddenDelegateGuard,429);delegate 有 idle 5min/hard 45min 超时,Stop 级联中断;一次性委派子会话收尾即 destroySession(2026-07-07,warm runner 不留存)。
5. **"客户端转圈不止但服务端其实跑完了"**(团队模式高发,2026-07-07 事故):turn 是否真在飞看 session 双计数(`_activeTurnCount` engine 级 + `_activeClientTurnCount` 客户 turn 级,含 review 编排窗口),**别看 runner.isRunning(warm runner 恒 true)**。恢复链权威:hello 重连对账(`_shouldPushTurnInterruptedFinal`→completed 推 meta.reconcile 静默 final / errored 推 service_restart 文案)+ resume_failed→REST 全量对账 + review 迟到团队卡 persistLateTurnArtifacts 补 drain。ring 帧分级(delegate_progress/turn_status=progress 级先淘,contentLossSeq 水位线判回放),团队进度帧 >15帧/s 冲穿 ring 属预期,content 不应受累。取证三件套:容器 docker logs 的 `delegate`/`team_review`/`verification verdict` 行 + master /var/log/openclaude-v5.log 的 `userChatBridge closed(cause)`/`resume replay miss` + client_sessions.last_at 对时间线。

6. **「服务重启,本轮已中断」红卡(SERVICE_RESTART)**:先别信文案——这是 synthetic crashed
   tape 的固定话术,合法触发只剩**真 boot recovery**(容器崩溃/重启后孤儿收敛)。取证顺序:
   ①容器 docker logs 搜 `turn dispatch boot recovery complete`,看它前面**有没有 `server started`
   boot banner**——没有 = 活进程里 recovery 被再触发(2026-07-19 P0:周期 sweep 误杀活 turn,
   已修=活标记注册表,回归看 stats.liveSkipped);②master 侧 `ssrf_blocked` 行 = transport 白名单
   与容器网段错配(已收口 containerNet 单一权威,再现=有人复制了私有副本);③对照 turn_dispatches
   行的 admitted→terminal 间隔,秒级即死大概率是①。

### 3.3 会话历史/持久化问题(高频类)
心智模型:**用户行走 POST /user-message；模型生成内容由 v2 lossless turn tape 在 PG 中完整保存，`client_sessions.messages` 只留常量大小 anchor，读取时水合为 assistant/thinking/tool/agent-group/plan/goal**。合并语义在 `lib/persist.ts`:
- full 合并 `mergeFullServerWins`:server 权威在前,保留尾部乐观段 + 中段 local-only user 行 + 中段 local-only 团队卡;
- 同 id"server tool 行 vs 本地已转 agent-group 富卡"→ 富卡为底回填完成态;
- `syncSession`(resume_failed reconcile)走 applyServerMessages 同一收口,**禁止整段替换**。
- ~~跨设备/清缓存团队历史必丢~~ **已根治**(P2 批次2):handleDelegateTask 收尾产出 server-authored agent-group 骨架行(runId 去重 local-wins),跨设备可见团队结构+终态+成本;过程 childBlocks 树仍仅本设备 IndexedDB(有意取舍)。
- **长会话热尾巴+归档**(2026-07-10 根治 4MB 拒写「扣费零送达」事故):client_sessions 行超软阈值 2.5MB → `_spillOverflowCore`(storage 唯一写侧收口)同事务把最老消息搬 `client_session_archive_chunks`,行内只留 ≤2MB 热尾巴(下限 64 条 > 兜底注入窗口 48);`_seq` 冻结不重排。回看走 `GET /api/sessions/:id/archive?before=&limit=`(前端"从云端加载更早的历史")。**full 合并必须带 archivedThroughSeq 水位**:本地 `_seq ≤ 水位`行无条件保留(否则热尾巴响应会误删本地已归档行)。PUT 防复活/append 幂等/cost-patch 短路都查 `client_session_archived_ids`。引擎无法原生续接、走 40 条兜底注入时 gateway 发 `sys.context_rebuilt` → 前端插 system 提示行(client-owned)。存量超限行迁移:`scripts/v5-sessions-spill-archive.ts`(dry-run 先行)。**模型上下文与本机制无关**(同引擎续接=容器卷原生 resume;上下文快满=引擎自动 compact)。

### 3.4 计费问题
usage_records + journal 双查;零输出免单/turn 级 idle 免单已内建;codex 跨桥重连计费走 journal 权威。造数验证用 psql 必须显式 COMMIT。

### 3.5 市场/技能问题
市场权威=master PG;容器侧靠 `syncMarketplaceHub`(已内建单飞+5s TTL+限频 warn 日志,"装了不显示"先看容器日志里的 sync warn)。管理面读技能在**容器内 gateway** 执行(生效面=runtime source release 轴,§2 矩阵)。用户向 skill API 必须 `includePlatform:false`(防平台技能泄露)。

### 3.6 遥测/审计
工具失败遥测:显式开关 `OC_TOOL_FAILURE_AUDIT=1`(容器 reporter+master 路由双端;v3 无此键=默认关)。dedupe 走 `idx_aa_agent_event_id` 索引。

---

## 4. 部署上线 SOP(生效面矩阵是核心)

### 4.1 改动分类 → 生效面矩阵(先分类再部署,漏一面=静默不生效)

> **单一权威(selfheal 批1b 起)**:下表是**机器可读 manifest `deploy/v5/selfheal-deploy-surfaces.json`
> 的生成投影**,自愈 Tier2 分类器与本表同源。**改分类改 manifest,勿手改锚点内的表**;
> 锁定测试 `packages/commercial/src/__tests__/deploySurfacesManifest.test.ts` 会断言"锚点内容 === 由
> manifest 生成"。每面的运维细节(dist 竞态 rsync/SPA 缓存重启、systemd 单元手动 cp+daemon-reload、
> ccb-baseline 认证 drain remount、env 手动同步、迁移 §4.5、runtime image 切 tag §4.3、emergency
> tuple 刷新)见 §4.2–§4.5 与各 lane 注释,不再于矩阵内重复。

<!-- selfheal-deploy-surfaces:begin -->
<!-- 本表由 deploy/v5/selfheal-deploy-surfaces.json 生成(改矩阵改 manifest,勿手改本段)。
     生成器/锁定测试:packages/commercial/src/__tests__/deploySurfacesManifest.test.ts。 -->

| 改动位置(glob) | 生效面 | 必做动作 | verify 层 |
|---|---|---|---|
| `packages/commercial/**`<br>`packages/storage/**`<br>`packages/cli/**`<br>`packages/protocol/**`<br>`docs/**` | master 进程 | deploy-v5.sh | `test:commercial:unit` |
| `packages/web-react/**` | dist 静态资源 | deploy-v5.sh --dist(与后端代码同批时用 --with-dist) | `test:web-react` |
| `packages/storage/**`<br>`packages/cli/**`<br>`packages/protocol/**`<br>`packages/gateway/**`<br>`packages/mcp-memory/**` | runtime source release | deploy-v5.sh(部署前活体断言 runtime-release 轴已启用,否则 manual) | `test:storage`, `test:gateway`, `test:mcp-memory` |
| `**/agent-sandbox/platform-runtime/**` | platform bundle | deploy-v5.sh(部署前活体断言 platform-bundle 轴已启用,否则 manual) | — |
| `packages/commercial/src/egress/**` | egress 进程 | deploy-v5.sh --egress(egress 进程;需 boss 明确放行后机器执行) | `test:commercial:unit` |
| (见下方 manual-only 清单) | **manual-only(fail-closed)** | 人工受控(§4.5 apply / RFC §3);另:rules 零命中 / 未知路径 / 未知 manifest version / symlink·gitlink·typechange 亦整体 manual | — |

**manual-only globs**(命中任一 → 整体 `manual_required`):

- `apps/windows/**` — Windows app 独立 installer release lane；禁止进入 V5 server deploy/release queue
- `**/migrations/**` — RFC §3 manual:DB migrations 人工受控 apply(§4.5)
- `deploy/**` — RFC §3 manual:deploy/**(含 env overrides / systemd 单元 / release metadata)
- `scripts/**` — RFC §3 manual:scripts/**(部署/告警/运维脚本随 rsync 生效,非自愈可安全自动)
- `.github/**` — RFC §3 manual:.github/** CI 配置
- `**/*.sh` — RFC §3 manual:任意 shell 脚本(镜像工具链/构建/host 脚本)
- `**/package.json` — RFC §3 manual:所有层级 package.json(依赖/脚本变更需人工审)
- `**/package-lock.json` — RFC §3 manual:npm lockfile(任一层级)
- `**/bun.lock*` — RFC §3 manual:bun lockfile(bun.lock / bun.lockb)
- `**/pnpm-lock.yaml` — RFC §3 manual:pnpm lockfile(任一层级;全部 lockfile 类)
- `**/yarn.lock` — RFC §3 manual:yarn lockfile(任一层级;全部 lockfile 类)
- `**/*.lockb` — RFC §3 manual:二进制 lockfile(bun.lockb 等任意 *.lockb;全部 lockfile 类)
- `**/Cargo.lock` — RFC §3 manual:Cargo lockfile(Rust crate;全部 lockfile 类)
- `**/Dockerfile*` — RFC §3 manual:Dockerfile 与镜像工具链(runtime image 面)
- `**/agent-sandbox/ccb-baseline/**` — RFC §3 manual:ccb-baseline(存量用户容器只读 bind,需认证 drain remount)
- `**/sudoers` — RFC §3 manual:sudoers 类(权限提升面)
- `**/sudoers.d/**` — RFC §3 manual:sudoers.d 片段
- `**/*.env` — RFC §3 manual:env 文件(线上 env 手动同步,增量部署不重生成)
- `**/*.env.overrides` — RFC §3 manual:env overrides(deploy/v5/commercial-v5.env.overrides 等)
- `**/AGENTS.md` — RFC §3 manual:AGENTS.md(agent 行为契约)
- `**/CLAUDE.md` — RFC §3 manual:CLAUDE.md(仓内/全局指令)
- `**/changelog.json` — RFC §3 manual:changelog.json(发版记账)
- `deploy/v5/selfheal-deploy-surfaces.json` — RFC §3 manual:分类器 manifest 自身(改分类权威=人工审;亦被 deploy/** 覆盖,显式列出以逐项断言)
- `packages/commercial/src/selfheal/**` — RFC §3 manual:自愈 TCB(检测/派单/incident 权威代码)
- `packages/commercial/src/http/internal/selfhealRepairs.ts` — RFC §3 manual:自愈 TCB(回调分流/repair 收口 handler)
- `packages/commercial/src/admin/selfhealOps.ts` — RFC §3 manual:自愈审批链 TCB(admin 放行事务/release request 权威,§P1)
- `packages/commercial/src/http/admin/selfheal.ts` — RFC §3 manual:自愈审批链 TCB(admin 放行 HTTP 入口,§P1)
- `packages/commercial/src/admin/audit*.ts` — RFC §3 manual:自愈审批链 TCB(永久 admin audit:audit.ts/auditActions.ts/auditRedact.ts/auditRetention.ts)
<!-- selfheal-deploy-surfaces:end -->

### 4.2 标准部署

> **全局发布队列(硬机制)**:`scripts/v5-release-queue.sh` 是“任务级”持久 FIFO，
> 从受保护 PR 合并前一直占到 canary/验证/finalize 收敛；`deploy-v5.sh` 的
> `/var/lock/oc-v5-deploy.lock` 只是“单命令级”互斥，不能替代发布队列。
> 所有开发写 mode 默认要求 `OC_V5_RELEASE_QUEUE_ID` 指向唯一 active、已 pin 且等于
> canonical HEAD 的队列项；新增 mode 默认也受门控。仅只读 smoke/census/模型观察、
> 官方 abort/rollback/recover/reclaim/hide-luna 与 emergency 授权/关账显式豁免。
> 自愈继承 deploy lock 的旁路必须同时由 selfheal ledger 的 deploying rrid、exact
> approved SHA 和当前 systemd scope 证明，不能伪造布尔环境变量。
> **代码+前端一起上 → 用 `--with-dist`**(单次重启双生效面);`deploy` 后紧跟 `--dist`
> 的两段式成对重启会把"刚被第一次重启打断、自动续写刚跑起来"的 turn 第二次掐死
> (2026-07-10 事故放大器),除非只改了单一生效面,否则不要拆开跑。
> **部署告警隔离**：deploy/dist/rollback 在首个 restart 前自动写最长 180s 的
> schema=2 planned-maintenance marker，只纳入即时确认健康且本次会中断的检查；部署前
> 已坏项继续告警，monitor/部署/cutover 共用远端 flock，smoke 后按 schema+nonce 清理，
> 超时仍坏立即升级真实事故；可信且全健康的 stale schema=1 可自动清，其他 stale marker
> 保留但不阻塞部署、全程 fail-open。禁止人工造 marker。
> **E2E 旅程门(2026-07-18 附件事故补强)**:deploy 与 --dist 的每个成功出口在
> end_planned_maintenance 后必跑 `smoke_e2e_journey`——部署发起机本机起真 Chromium,
> 自建 ssh 隧道走线上核心旅程(UI 登录/附件全链含 filechooser/目标入口/带附件发送)。
> 失败=fail-loud 非零退出(部署判定失败,截图在 /tmp/e2e-journey-fail-*.png,人工裁定
> --rollback 或修断言);第一期**不进 validation 自动回滚链**(UI 断言有文案漂移假阳性面,
> 连续两周零假阳性后升级,升级时同步 v5ReleaseSafety 断言)。`V5_SMOKE_E2E=0` 显式豁免
> (紧急场景,事后必须补跑)。依赖:部署树 node_modules 需含 playwright-core(npm install),
> 缺失门会 fail-loud 指引。接线契约由 v5ReleaseSafety.test.ts 锁定(四出口+函数体)。
```bash
cd /opt/openclaude/openclaude-v5-aurora     # 部署树;必须 clean(脏文件会被 rsync 上去)
git status --porcelain                       # 必须为空
scripts/v5-release-queue.sh status           # 确认本任务是唯一 active
export OC_V5_RELEASE_QUEUE_ID="$RQ"           # §2.5 submit/acquire/pin 得到的持久 ID
bash scripts/deploy-v5.sh [--egress]         # 快照(.prev.1..5 可 --rollback)+rsync+restart+smoke
# 前端(涉及 web-react):走 --dist,勿再手敲 rsync --delete(会造成部署窗口 404 白屏)。
#   竞态安全=资产加法先行 + 根文件后替换(新 index.html 永远只引用已就位资产);
#   资产 14 天 GC;版本握手 smoke 断言线上 oc-build == 本地构建。
bash scripts/deploy-v5.sh --dist
bash scripts/deploy-v5.sh --smoke

# 仅隔离预发宿主的 80 已被无关服务占用时，在线 deploy/P3 lane 可显式覆盖 Caddy 端口：
CADDY_HTTP_PORT=18081 KL_HOST=kl-hk bash scripts/deploy-v5.sh --canary
# 非 80 配置会自动 bind 127.0.0.1；预发 monitor 同步传
# V5MON_PUBLIC_URL=http://127.0.0.1:18081/healthz。生产不得设置 CADDY_HTTP_PORT，恒用默认 80。
# 此覆盖不支持 prepare/offline-cutover lane（该紧急通道仍固定生产 80）。

# P3 canary 起 B slot 时，B 的独立 OPENCLAUDE_HOME 不得产生第二份会话权威：unit 必须用
# OC_SESSIONS_MANIFEST_PATH 指向 A 的 sessions-store-authority.json。candidate 启动采用有界
# 私有口轮询，不可改回固定 sleep；若超时，先看 /var/log/openclaude-v5-b.log 与 18897/healthz。
# 在 transition_step<READY 时 candidate 对流量不可见，脚本会 fail-closed 回 stable。

# 版本握手(2026-07-07):bridge 每次 WS accept 下发 sys.frontend_build(服务端读 dist
# index.html 的 <meta name="oc-build">,vite build 插件按最终 HTML 内容 sha256 注入),
# 前端 lib/appUpdate.ts governor 在安全点软刷新拿新前端。防无限刷新硬上限=URL hash
# 谱系计数(#ocr=N,失忆也生效,一条谱系 ≤2 次自动刷);只在版本匹配时清零。
# 老 bundle(无 governor)收到帧会忽略 → 需一次手动刷新 bootstrap 到新 bundle,之后自愈。
```

### 4.2a 固定双模型事故回归门、Luna 发布与 P0 止血债务

普通 P3 candidate 在 Caddy lane 验证后，必须由 `e2e/session-display/run.sh` 串行跑完
`gpt-5.6-luna`/Codex 与 `deepseek-v4-flash`/CCB 两个真实底座。身份固定为
`v5-evals@claudeai.chat`，完整 live suite 不允许 `FAIL/SKIP/FLAKY/.only`；事故清单权威是
`e2e/session-display/incidents.json`，CI 与部署前均执行 `npm run check:v5:incidents`。
任一失败时脚本在同一 mutation lease 内先官方 abort，再核对 exact stable predecessor、
runtime tuple、真实 Agent turn 与 V3 inactive，之后才允许调查。
带 `--egress` 的 canary 会把全局 egress 临时切到 candidate release 跑矩阵，随后恢复 exact
predecessor 并持久化 `release_egress_transitions=ready`；master finalize 提交 stable 后才激活
该 exact tested egress。若进程恰在两步之间中断，`--recover` 按 durable transition 收敛，
`testing` 未收敛时 finalize 会先恢复 exact predecessor 再转 `ready`；post-stable 异常则第一动作
官方 rollback master，随后恢复旧 egress。

迁移 `0183_luna_verification_runs` 先把 Luna 激活为 hidden，并建立 exact
release/generation/session-prefix 绑定的验证赞助。只有上述测试身份、两个固定模型和本次
verification run 命中的请求才零扣费；每笔仍在 `usage_records` 保存名义成本与 run ID。
普通用户与 `v5-canary` 不享受此赞助。`0184_emergency_containment_debt` 建立紧急止血债务门。
两个迁移按 §4.5 在线 apply 并用旧 stable smoke 后，才可进入本批 canary。

```bash
# 普通发布：--canary 自动跑固定矩阵并写 exact release/generation evidence；缺证据的
# --finalize 会先 abort。涉及 commercial egress/计费代码时必须带 --egress。
bash scripts/deploy-v5.sh --canary --egress
bash scripts/deploy-v5.sh --finalize

# Luna 只在 stable active 与当前 generation 已有双模型证据后公开；该操作有 admin_audit。
bash scripts/deploy-v5.sh --publish-luna

# Luna 公开后若出现新异常：先按 deploy_state 官方 rollback，恢复稳定后再隐藏目录入口。
bash scripts/deploy-v5.sh --hide-luna
```

**dx-declared P0 exception** 只在 dx 同时明确“线上正持续造成真实用户/资金/安全损失”与
“最小止血立即上线、审查/用例事后补”时启用。它只跳过固定双模型 full matrix，不跳过
worktree、远端 commit provenance、clean canonical exact HEAD、production-mutation lease、
官方 canary/finalize、异常先 abort、计费/数据不变量、smoke 与 V3 inactive：

```bash
INC=INC-20260723-EXACT-SYMPTOM
SHA=$(git rev-parse HEAD) # 必须已 push 到 origin task branch，且 canonical 正好 fast-forward 到它
APPROVAL='dx:<可审计的明确止血指令引用>'

# 必须先用独立 invocation 记录 dx 的一次性明确批准；canary 只能消费，不能自建授权。
# JSON 只接受以下精确语义，文件须 root-only 保存。
cat > /root/v5-emergency-approval.json <<JSON
{
  "schema": 1,
  "approver": "dx",
  "decision": "APPROVE_P0_CONTAINMENT",
  "ongoingRealUserFinancialOrSecurityHarm": true,
  "smallestContainmentFirst": true,
  "incidentId": "$INC",
  "exactCommit": "$SHA",
  "approvalRef": "$APPROVAL",
  "approvedAt": "$(date -u +%FT%TZ)"
}
JSON
chmod 600 /root/v5-emergency-approval.json
bash scripts/deploy-v5.sh --authorize-emergency="$INC" \
  --emergency-approval="$APPROVAL" --emergency-commit="$SHA" \
  --emergency-approval-evidence=/root/v5-emergency-approval.json

bash scripts/deploy-v5.sh --canary --egress \
  --emergency-containment="$INC" --emergency-approval="$APPROVAL" --emergency-commit="$SHA"
bash scripts/deploy-v5.sh --finalize \
  --emergency-containment="$INC" --emergency-approval="$APPROVAL" --emergency-commit="$SHA"
```

预授权 invocation 会把 dx approval evidence 哈希、exact incident/commit 与 admin audit 独立落库；
canary 在真实 mutation lease 下原子消费该 one-shot authorization，生成 debt 并绑定 candidate release。
canary/finalize 每次都重新核对 clean canonical exact HEAD 与远端 commit provenance。
止血稳定后 open debt 会阻断所有普通生产写 lane；仅 `abort/rollback/recover/hide-luna` 与
同一 incident 的收敛仍可执行。立即补回归、单一 Codex full-diff PASS、受保护 PR/CI，
canonical 与 origin protected head 对齐后，用以下 schema 的 root-only JSON 关账：

```json
{
  "schema": 1,
  "commit": "<protected merge 40-char sha>",
  "protectedBranch": "feat/v5-aurora-rewrite",
  "codexReview": "PASS",
  "regressionTests": "PASS",
  "ci": "PASS",
  "ciUrl": "https://github.com/<owner>/<repo>/actions/runs/<run>"
}
```

```bash
bash scripts/deploy-v5.sh --close-emergency-debt="$INC" \
  --protected-merge-sha="<same protected merge sha>" \
  --ci-evidence-file="/root/<root-only-evidence>.json"
```

债务关闭前只能汇报“止血已上线”，不得称根治完成。

**CCB baseline 存量容器收敛**（仅 baseline 内容变化或修复历史漏挂时执行）：先确认
`deploy_state.phase=stable`，按当前 active slot 选择 unit（A=`openclaude-v5.service`，
B=`openclaude-v5-b.service`），先 dry-run 再真实执行。工具只处理
`runtime_channel=v5`，逐个走容器内认证 drain；`busy/failed` 会重试并在 deadline 后
失败退出，绝不强杀活跃 turn，命名卷、managed/uid/channel 身份 labels 和 runtime
labels 会在每个容器重建后复验。真实 remount 只能经 deploy 正式模式运行：它会在
整个 census/drain/reprovision 窗口持有 `/var/lock/oc-v5-deploy.lock`，避免 release、
runtime tuple 或 slot 同时翻转；独立 TS 工具只允许 `--dry-run`，破坏性直跑会拒绝。
V5 不启动远程 baseline server；正式 unit 会依赖
`openclaude-v5-baseline-port-guard.socket`，仅在 `127.0.0.1:18893` 做端口占位。
这是为旧 release 自动回滚准备的兼容保险：其 `0.0.0.0:18893` bind 必须得到
`EADDRINUSE`。smoke 会同时核对 socket active、唯一回环 listener 和真实 wildcard
bind 失败；不要把这个回环占位误删，也不要开放为 `0.0.0.0`。
容器 bind 的 Source 是当次 master 的不可变 `rel-*` 真实路径；release GC 会先完整
inspect 全部 managed V5 容器，把仍被三条 baseline bind 引用的 release 加入保护集。
Docker census、inspect 或 Source 解析任一失败时，整轮 GC 在首个 `rm` 前安全跳过。

```bash
# deploy 脚本从 deploy_state 自动解析 active A/B，不手填 unit/path。
scripts/deploy-v5.sh --census-ccb-baseline
scripts/deploy-v5.sh --remount-ccb-baseline

# 仅需调整总 deadline 时（单位：秒，允许 60..7200）：
OC_V5_BASELINE_REMOUNT_TIMEOUT_SECONDS=3600 \
  scripts/deploy-v5.sh --remount-ccb-baseline
```

红线:只从部署树发;绝不手工 rsync+restart 绕过脚本;v3 的 service/env/Caddy 一律不碰。

### 4.2b 极少数跨 master/runtime/dist 的离线切换
默认走在线构建 + 普通 deploy + 存量容器自然/逐个回收。只有无法兼容运行的
master/runtime/dist 组合才走本 lane。**数据库迁移必须可向后兼容，并在服务在线时
独立完成；离线 lane 禁止任何 DDL/DML。** 不兼容数据库变更必须另做带数据库
快照/恢复的专门维护方案，不能用 break-glass 绕过。

```bash
# 0) 服务保持 active：先完成耗时构建、镜像 label/二进制验证和向后兼容 migration。
#    构建绝不能发生在停机窗内。migration 后用旧版本再次跑 health/public smoke。
ssh kl-mirror 'systemctl is-active --quiet openclaude-v5'
# build runtime image ...（见 §4.3）
# 在线 apply backward-compatible migration ...（见 §4.5）

# 1) 仍在线时 prepare。脚本验证 internal/public health、目标镜像 immutable ID、
#    required migration；生成 30 分钟一次性 nonce，并完整快照旧 source、VERSION、
#    web dist/assets、env、unit 与旧 image identity。
bash scripts/deploy-v5.sh --prepare-offline-cutover \
  --target-image=openclaude/openclaude-runtime:v5-ccb-<sha>
# 保存输出的 CUTOVER_NONCE=<32hex>

# 2) prepare 成功后才允许停 master（egress 不动）。监控 maintenance marker 只静默
#    svc_v5/http_v5/public_route；egress/磁盘/内存/容器池/镜像仍照常报警。
ssh kl-mirror 'test "$(systemctl is-active openclaude-v3 2>/dev/null || true)" = inactive'
ssh kl-mirror 'systemctl stop openclaude-v5'

# 3) 一次性状态机，顺序/重放/过期/host/commit/image ID 任一不符均拒绝。
#    offline-recycle 只删 v5 Docker 容器，数据库零写入。
bash scripts/deploy-v5.sh --offline-recycle --cutover-nonce="$CUTOVER_NONCE"
bash scripts/deploy-v5.sh --stage --cutover-nonce="$CUTOVER_NONCE"
# activate 在持锁状态下把 manifest 中已验证的 target image 原子写入 env；
# 此处不再手改 env、不再构建、不再迁移。
bash scripts/deploy-v5.sh --activate-staged --cutover-nonce="$CUTOVER_NONCE"
```

任一步失败都会恢复 prepare 捕获的完整旧激活面并 `start` 旧服务；即使恢复 smoke
超时也**不会再次 stop**，留给人工继续修复。普通 `deploy/smoke/dist/rollback` 不读取
cutover manifest，也不要求新 migration。仅真正紧急人工维护可为显式危险子命令设置
`OC_BREAK_GLASS_OFFLINE_RECYCLE=I_ACCEPT_V5_OUTAGE`；它不能绕过数据库兼容性禁令。

### 4.3 runtime image 重建

> **runtime tuple(feat/v5-runtime-hotcfg 起)**:激活/回滚原子单元 =
> {OC_RUNTIME_IMAGE(_ID), OC_RUNTIME_RELEASE, OC_PLATFORM_BUNDLE},由 deploy 激活 saga
> 统一写入 env + `/etc/openclaude/runtime-tuple.history`(带 checksum),回滚=翻上一条
> committed tuple(`deploy-v5.sh --rollback`),**禁止手改单个键**。stale 判定按 image
> **immutable ID**(同 tag 重指新镜像不会漏判)。镜像重建从"每个功能批次"降到
> "工具链变更时";重建后跑 `deploy-v5.sh --emergency-tuple` 刷新 break-glass 记账
> (emergency = 完整 pinned tuple,含内嵌源码镜像,兼容性破坏变更必须刷新+smoke)。
> release/bundle GC 保护集含运行容器 label 引用,docker 不可用即放弃本轮 GC。

> **首启实战坑(2026-07-12,均已在 lib 代码注释登记)**:①容器 bridge 网络 DNS 不通
> → deps 安装容器必须 --network=host(同 OC_BUILD_NETWORK_HOST 坑);②bun run build 的
> 嵌套 script 按名字找 bun → PATH 须前置 bun 目录(绝对路径调外层不够);③release 数万
> 文件 files[] JSON 走 --argjson 撑爆 argv → --slurpfile;④结果值函数的子进程 stdout
> 必须 >&2(npm 输出污染 $(…) 捕获);⑤**bun build 不可复现**(同源重建 bytes 都变)→
> ccbDistKey 内容寻址缓存复用 dist,否则每次 deploy 全量容器 churn;⑥strict 壳里
> 守卫式 `[ -n "$x" ] && …` 作函数末条会把空值放大成失败 → 显式 return 0。
> **稳态操作**:瘦身镜像重建传 OC_EMBED_SOURCE=0;重建后跑
> `deploy-v5.sh --emergency-tuple --image=<内嵌tag> --image-id=<ID> --bundle=<bundle>`
> 刷新逃生点;逃生激活=`--activate-emergency-tuple`;禁用轴=`--disable-runtime-release
> --image=<内嵌tag> --image-id=<ID>` / `--disable-platform-bundle`。

```bash
# 在 kl-mirror 上、源=已部署树。⚠️ 非交互 ssh 必须带 bun 的 PATH,否则 FATAL 没 bun
ssh kl-mirror 'cd /opt/openclaude/openclaude-v5 && nohup env PATH=/root/.bun/bin:$PATH \
  PERSONAL_SRC=/opt/openclaude/openclaude-v5 OC_BUILD_NETWORK_HOST=1 OC_BUILD_SKIP_TAR=1 OC_INCLUDE_CODEX=1 \
  bash packages/commercial/agent-sandbox/build-image.sh v5-ccb-<12位sha> > /tmp/v5-image-build.log 2>&1 &'
# 完成判定:docker images 出现该 tag(日志 grep FATAL 会误报 Dockerfile 里的 echo 字符串)
ssh kl-mirror 'sed -i "s|^OC_RUNTIME_IMAGE=.*|OC_RUNTIME_IMAGE=openclaude/openclaude-runtime:v5-ccb-<sha>|" /etc/openclaude/commercial-v5.env'
# 同步 bump 仓内 overrides 的 OC_RUNTIME_IMAGE(单独 chore commit)+ rsync 该文件到远端树
ssh kl-mirror 'systemctl restart openclaude-v5'   # 新容器用新镜像;存量在空闲窗口按需回收
# 镜像清理:保留 current + 上一版(回滚),其余 docker rmi
```

存量容器镜像不一致时,v5 `ensureRunning` 先看最后 WS 活动:距今 <30 分钟只复用并延期;
达到 30 分钟或活动时间为空时,再向容器做带 nonce 的 turn-drain 握手。Gateway ingress 与
SessionManager submit 双闸均确认无在途 turn 才回收,握手失败/繁忙一律延期。紧急安全发布可
临时设 `OC_V5_FORCE_STALE_IMAGE_RECYCLE=1` 绕过延期与握手,但会中断正在执行的工作;普通发布禁用。

### 4.4 env 三层模型
`/etc/openclaude/commercial-v5.env` = V3_ENV 继承 − REMOVE_KEYS + overrides + OC_EGRESS_SECRET(保留链)。
**只有 bootstrap 会重新生成**;平时改 overrides 必须手动把差异同步到线上 env(先 `cp env env.bak-<date>`)。改完核对:线上 env 键集 = 继承∪overrides∪secret(双向差集为空)。

### 4.5 迁移人工 apply(0096+ 惯例)

生产 `DATABASE_URL` 是运行期 `openclaude_app` 角色，**不得**拿它执行 DDL；反过来，直接
以 `postgres` 跑 migration 又会让新对象归属 postgres、绕过 `openclaude` 的 default ACL，
出现“`schema_migrations` 已记账但应用角色无权读写”的假就绪。人工 apply 必须复刻 runner
的同一把 session advisory lock，并在事务内 `SET LOCAL ROLE openclaude`：

```bash
MIG=packages/commercial/src/db/migrations/<NNNN_name.sql>
VERSION=$(basename "$MIG" .sql)
DBNAME=$(ssh kl-mirror 'DBURL=$(grep ^DATABASE_URL= /etc/openclaude/commercial-v5.env | cut -d= -f2-); python3 -c '\''import sys,urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).path.lstrip("/"))'\'' "$DBURL"')

{
  echo 'SELECT pg_advisory_lock(54729267713);'
  echo 'BEGIN;'
  echo 'SET LOCAL ROLE openclaude;'
  cat "$MIG"
  printf "\nINSERT INTO schema_migrations(version, applied_at) VALUES ('%s', now()) ON CONFLICT DO NOTHING;\n" "$VERSION"
  echo 'COMMIT;'
  echo 'SELECT pg_advisory_unlock(54729267713);'
} | ssh kl-mirror "sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d '$DBNAME'"
```

版本记账格式=文件名去 `.sql`(必须与既有行一致,否则 runner 对账守卫会炸)；psql 造数/迁移
**必须显式 COMMIT**。执行后必须核对新表/序列/函数 owner=`openclaude`，并以
`SET ROLE openclaude_app` 做 `BEGIN → 最小 INSERT/UPDATE/SELECT → ROLLBACK` 权限冒烟，确保
零测试残留。`deploy-v5.sh`/`--smoke` 另有 0151 runtime 对象 owner + 逐项权限硬门；仅有
migration 记账行而 owner/grants 不完整会 fail-closed。

`deploy/v5/release-metadata.json.requiredMigrations` 是所有 deploy/dist/rollback/canary/
finalize/abort/recover 等写 lane 的统一硬门；目标 rollback/canary release 还会按自己的 metadata
再验一次。任一缺行都在 symlink/unit/Caddy/状态机副作用前 fail-closed。若新迁移编号低于线上
`MAX(schema_migrations.version)`（例如后补 `0135_deploy_state`，线上已经到 0142），普通 migration
runner 会按 out-of-order 纪律拒绝；必须先备份，再按上面模板手工执行 SQL + 同事务记账，随后
重新跑部署硬门，不能仅补记账或用 AUTO_MIGRATE 绕过。

### 4.6 发版节奏(2026-07-06 起,P1.5 制度化)
全量现网后告别"随改随发"。规则(可按运营数据调整):
- **常规批次攒窗口发**:非紧急任务先在 task branch 完成审查/CI，进入全局发布 FIFO；
  只有队首 active 任务在窗口内合并 canonical 并完成上线，后续 PR 保持未合并。默认每日
  1-2 个北京时间午后/晚间窗口；一窗一条面向用户 changelog(改动可感知时)。
- **hotfix 例外**:现网事故/计费错账/安全面可即时发,但仍必须走 deploy-v5.sh+smoke,并在下一窗口补 changelog。
- **dx 显式 P0 两阶段止血**:仅当 dx 明确确认当前存在真实用户/资金/安全持续损失,并明确要求
  “最小止血先上线、审查和用例事后补”时可启用;agent 不得自行推断。Phase 1 只允许已证实根因的
  最小 diff:从当前 canonical HEAD 建隔离 worktree,先把 exact commit push 到任务分支留远端证据;
  canonical 必须 clean、无夹带未部署 commit、可 fast-forward 到该 exact commit,且不存在另一个
  production mutation owner,方可本地 fast-forward 并仅通过官方 canary/finalize 上线。不得临时放宽
  branch protection、force-push、rsync 或手改运行态;mutation lease、计费/数据不变量、异常先回退、
  smoke、V3 inactive 永不豁免。稳定后立即补复现用例、单一 Codex full-diff 审查和受保护 CI/PR,
  再让 canonical 对齐远端 merge;此前只能说“止血已上线”,不能说完成/根治。
- **生产 mutation 唯一 owner**:以实际持有官方远端 production-mutation flock,且 lease fencing meta
  中 holder identity/`deploy_id` 可佐证的进程为权威;另行验证该 invocation 保存的 nonce 与其
  in-flight marker/sentinel 匹配,禁止拿不同标识的 `deploy_id` 与 marker nonce 互比。已有 owner 时
  其它会话不得竞争 abort/rollback/recover;仅在 holder 退出、flock 释放后按 deploy_state/marker
  走官方 recovery 接管。无法证明 owner 时只读上报。
- **只读诊断边界**:“看下/定位/是否正常/先告诉根因”不得触发部署、回退、重启、清 marker 或写库;
  任务开始前已存在的故障不因另一条 0% canary 自动成为发布异常。健康探测先由
  `deploy_state.active_slot` 推导 active unit/port,禁止固定 A/B 端口。
- **P0 stop-the-line**:已定性且未关闭的 P0 存续期间,同一故障域/子系统禁止再合入或上线功能批;只允许诊断、修复与验证该 P0 的改动。例外必须由 boss 明确批准,不能靠临时放宽 branch protection 绕过。
- **发版门**:check:v5 全绿(typecheck+gateway+mcp-memory+storage+web-react+commercial 基线集 diff)+生效面矩阵分类;镜像面改动放量前 canary(agent uid)。
- **单日多批发布**:允许，但严格按 `release_queue_jobs.seq` 串行。前一项未
  `completed/abandoned` 前，后一项不得合并 canonical。`active` 不做超时自动接管；
  会话丢失时先 `status`，确需释放必须用 `abandon-active --operator --reason
  --result=deployed|not-deployed`，该命令同时持本地 deploy flock 与官方远端
  production-mutation lease，并确认 markers absent、deploy_state stable/candidate empty
  后才原子记审计并释放。任一证明失败都保持 active，禁止手改 SQLite。

### 4.6b 上线后核验清单
- [ ] `/version` = 预期 commit;smoke 通过(含 OC_EGRESS_SPLIT=1 时 egress 无条件断言)
- [ ] `openclaude-v3` 保持 inactive(绝不因 V5 任务启动/重启个人版或 V3)
- [ ] 前端特征串在 dist 产物里 grep 得到
- [ ] 有容器 on-demand 起来且用新镜像 tag(`docker ps`)
- [ ] 涉及移动端的改动 → 提请 boss 真机(iPhone Safari / 鸿蒙 ArkWeb)验证
- [ ] 更新记忆/文档;清理分支与 worktree(§2.5)

---

## 5. 已登记技术债与触发条件(改到相关区域时必须先看)

| 债 | 内容 | 偿还触发 |
|---|---|---|
| AgentGate 错误 message 直显 | useAgentGate/AgentGate 仍 `e.message` 直显(裸露面窄:仅 getAgentStatus 网络/未知错误);因 AgentGate 有独立 requestId 展示行,直接换 apiErrorMessage 会双显追踪号,需连动渲染一并设计(2026-07-11 全站错误文案收口批有意跳过) | 下次改 AgentGate 时连动收口 |
| gateway 域错误信封无 code | 会话/cron/memory/skills 容器代理路径返 `{error:"<string>"}` 无结构化 code,前端 apiErrorMessage 只能靠 CJK 启发式判"是否用户向文案";另有伪 code 当 message(not_in_allowlist)与用户可触发的 422 英文校验(slug required 等) | 迁 `{error:{code,message}}` 结构化信封时,前端同批改走 code 表、删 CJK 启发式 |
| agent 发布胶水双份 | 技能发布已收口 prepareSkillPublish 单一权威(166e9ecc,浏览器路由+容器内部代理同源,bundle/benchmark/逐文件扫描对齐);**agent 发布**的胶水校验(字段序/humanMeta/metaScan → validateAgentManifest)在 marketplaceRoutes 与 internalMarketplaceAgent 仍各一份,本批仅对齐 visibility 剔除清单未收口 | 下次改 agent 发布逻辑时(改一处必须同步另一处,或顺手收口成 prepareAgentPublish) |
| ~~会话归档孤儿清理~~ **已偿还**(2026-07-10,feat/v5-concurrency-guards) | deleteClientSession 软删同事务级联清 archive_chunks/archived_ids | — |
| admin 归档 offset 深翻 O(skip/200) | admin sessions 视图 offset 分页越过尾巴走归档 cursor walk,深 offset 重走前缀页;单人低频诊断可接受 | admin 前端改用与用户面 /archive 一致的 cursor 翻页 |
| ~~团队卡 server-authored 化~~ **已偿还**(4202986b+ac966d6f,P2 批次2) | 生成点=handleDelegateTask 收尾(parser Agent 排除保留);sink agentGroups[]→master role 'agent-group'(srv-*,_delegateStatus 三态)→storage/前端按 _delegateRunId **local-wins** 去重;server 行=骨架+终态(过程树有意不持久化,本设备 IndexedDB 承载)。**部署红线:master-first**(strict schema 新字段,新 gateway→旧 master 400 fatal-drop 整包)。TeamPanel 同批改按 turn 锚点归组 | — |
| ~~hidden reviewer pipeline 硬编排~~ **已退役**(2026-07-07 boss 裁决,被队长自主送审取代) | 演化:preamble 软约束(漂移)→ gateway 硬编排(9c36c34a)→ **队长自主送审**:preamble 纪律"除明显简单任务外都送审"+`request_review` 工具(mcp-memory→delegate hidden-reviewer);平台保证收敛为三件=isReview 按目标身份派生 / hidden guard ≤3次/turn / 团队门(父 turn 非团队 409,权威快照 `session._teamModeTurn`+`_currentTurnUserText`)。final 不再扣住,状态机/continuation/修订标记帧全删(防复活断言在 teamModeHiddenReviewer.test.ts)。**取舍(boss 知情选择)**:低遵循度队长模型可能漏送审,质量门从强制变纪律引导 | 若实测漏审率不可接受 → 复活 gateway 兜底(turn 结束未送审则补审) |
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
| ~~provision 事务窗口过宽~~ **已偿还**(07-07,saga 化,merge ae9036c0) | provisionV3Container 拆 saga 三段:Tx1 短事务(持 uid+host 双锁,cap 门控+ensureV3Volumes+INSERT 占位行 active/cid=NULL,COMMIT 释锁)→ 中段无事务无连接跑 docker+codex 慢 IO → Tx2 短事务落 cid → 补偿翻 vanished+docker rm。消除 idle-in-tx 强断(3/天)+ 部署惊群 statement_timeout 57014 串行失败(33/天)。**新常态**:active+cid=NULL 是合法 provisioning 中间态(≤PROVISION_INFLIGHT_GRACE_MS=15s),所有 provision 入口(WS/media/cronWake/prewarm)汇入唯一 makeUidSingleflight → cid-NULL 观察即孤儿→自愈;cronWake 预检 userHasRunningContainer 排除 cid-NULL。详见 [[v5-provision-saga-cron-codex-fix]] | — |
| ~~v5 告警只入库不推送~~ **已偿还**(3a7e6f53,企微通道) | wecom_bot 通道+v5-only dispatcher(claim 按类型过滤);v3 侧告警亦经共享 outbox 送达企微。**过渡窗口**:v3 旧类型无关 claim 误抢 wecom 行→延迟 1-2min(退役即消失,勿关 v3 告警调度——轮询规则引擎全网唯一)。**v3 退役收尾新增项:轮询告警规则(accountPoolAllDown/LowCapacity 等)必须挪 v5,否则 v3 停服后检测面真空** | — |
| ~~v5 无后台孤儿回收网~~ **部分偿还**(02878333,07-06) | orphanReconcile 已放开 v5-owned(channel 双侧隔离,与 409 自愈错峰幂等,smoke 白名单已登记);**idleSweep/volumeGc 仍钉死**(活跃容器误杀窗口/不可逆删卷) | idleSweep:补 turn 级活跃屏障后再放;volumeGc:v3 退役收尾+观察期结束后单独评估 |

| ~~org 订阅期内桶~~ **已偿还**(二期 8a4c14a9,0115) | 四桶+席位订阅(org-pro/max/ultra 9折池化)+自助开通+席位闸 | — |
| ~~活集生产接线无进程内测试~~ **已偿还**(2026-07-19) | server.ts 改走 runDurableDispatchAdmission 单一生产 helper,锁住 mark→INSERT→首次 receipt→dispatch→finally unmark 顺序;行为用例以真实 SQLite+`OC_TURN_DISPATCH_SWEEP_MS=1000` tick 重叠首达与重复帧,证明重复帧 unmark 不会拆掉首达 live 引用、settle 后下一 tick 才按 recovery 收敛 | — |
| ~~计划滚动重启 mid-turn 无 drain/lease 双闸~~ **已偿还**(2026-07-19) | recycle handshake 在既有 ingress/session gate 上增加 durable `running` 行闸,DB 读失败/TTL 读中到期均 fail-closed;重叠握手由进程内 coordinator 串行化,后请求不得释放先请求已受理的双闸。master turn-tape-state 用单条 PG statement 同快照返回 tape+同租户 dispatch lease,none+活 lease 延后 synthetic。accepted lease 只是 90s 量级 secondary fence,planned recycle 主保护仍是 drain | — |
| 真容器崩溃后无自动内容重派 | 非计划进程/宿主崩溃会清空内存 drain/live registry;短 dispatch lease 过期且 master 无 tape 后仍合成确定性 SERVICE_RESTART crashed(诚实失败+免单),已经生成但未 stage 的内容无法恢复 | master 自动重派 outbox 落地;或 dispatch_lost 类事故月频 >3;或 boss 要求零触达恢复 |
| 远端 host release/bundle 分发 | runtime release/platform bundle 仅本机(kl-mirror);多机硬门:OC_RUNTIME_RELEASE 非空+非 self-host placement → 调度前拒 provision+告警(v3supervisor 带测试) | 新增 compute host 时做 rsync 分发(与 baseline REMOTE_HOST_CCB_BASELINE_DIR 推送同构)+node-agent inspect 契约补 imageId/labels |
| 模型权威独立批次(P2c+seed model) | 模型目录 master 下发(ModelExecutionCatalog:bridge 授权/engine 分类/计费编排/容器执行同快照消费,per-uid 过滤,enabled=false fail-closed)+seed agent model/engine 声明化(bridge 按容器实际 seed revision 推导);设计审 R1-B5/R2-B1 裁定不与镜像瘦身同批 —— **在此之前 platform-seed.yaml 禁放 model/engine/provider 键(schema 硬拒),模型面改动仍走 protocol 常量+release 滚动** | 下一个模型/计费面批次单独设计单独 Codex 审 |
| SupervisorErrorCode 无平台专用码 | platform bundle/release/多机门校验失败统一映射 InvalidArgument(ensureRunning 短重试,功能正确但运维信号不如 CcbBaselineMissing 清晰) | 首次生产遇到 bundle 校验失败排障时加专用码+critical 告警 |
| env.bak 无轮转 | 激活 saga 每次 cp env env.bak-<ts>,/etc/openclaude 缓慢累积 | 目录文件数>50 时加保留最近 10 份的清理 |
| ~~顺序轴与版本游标共用 _seq(数据模型级)~~ | **已偿还(2026-07-17,feat/v5-orderseq-axis)**:首次持久化冻结 `_orderSeq`;展示/turn 分组/phantom dedup/spill/归档水位走该轴,`_seq` 仅保留内容版本与增量游标语义。旧热行读时按耐久数组惰性派生、下一次写冻结;旧归档行按既有物理归档轴兼容冻结。前端改为 `_orderSeq` 元组全序且无缺 ts bail-out,评分卡按 `_clientMessageId` 分组。物理归档列/API 的 `*_seq` 名称为滚动兼容保留,值语义已经是 order 轴。 | **完成;待本批 Codex 审计与上线** |
| CCB bg bash tail 无终态信号 | post-terminal tail 流只能靠 gateway cap/session 销毁兜底止血,CCB 侧后台任务无"命令已退出"的显式终态帧给 gateway 定界 trailing flush | 下次动 CCB task 生命周期时补终态帧,gateway 折叠器改按终态精确 flush |
| **canonical→生产 KP 门分叉(07-17)** | canonical HEAD 含未扫码的 Knowledge Planet 新候选(#72/73/76 批,门钉插件 artifactHash),任何含新候选的 release 部署都被预验证门挡;且 verify 流程 login worker 报 WORKER_FAILED 待排查。kimi-k3 批被迫走 **hotfix 分支 feat/v5-kimi-hotfix**(=生产 f56f4eed + cherry-pick 已合 canonical 的两个 commit)部署 rel-b5facb8b —— 所有部署行都在 canonical 历史里,但生产 ≠ canonical HEAD | boss 扫码过 KP 门后**立即 redeploy canonical HEAD 收敛**(彼时 #72/73/76 一并上线);期间任何新批次上线都必须继续 cherry-pick 到该 hotfix 链或先过 KP 门 |
| modelRolePolicy 策略在代码不在 catalog | 按角色的模型窗口分档(kimi-k3 admin 1M/其他 512k)登记在 commercial/billing/modelRolePolicy.ts 常量表(catalog 只放机制窗口;进 capability_profile 要 bump schema version 老进程 fail-closed,不值得)。**两条投影轴防线不同**(2026-07-17 审计纠偏,旧行误称"双落点漂移都被 409 打回"):列表轴(listForUser 的 DB 角色,进 projectionRevision)有 master↔egress 的 409 对账网;**执行轴(bridge 按连接 JWT 角色签发 descriptor.contextWindow)从不进对账**——15min TTL 内 JWT/DB 角色漂移被设计容忍(收窄方向保守),其一致性**唯一防线=同一纯函数 projectContextWindowForRole + 两处落点单测**(modelRolePolicy.test.ts 纯函数契约 / modelAuthorityBridge.test.ts:431 bridge 签发,均不可删) | 出现第二类角色差异化语义(限速/档位/可见性窗口)时,升格为 catalog 数据列统一承载;**新增任何角色投影消费方必须同步加对应落点单测**(执行轴无对账兜底) |
| kimi-k3 512k 用户档无计费边界硬顶 | 非 admin 的 512k 窗口分档(modelRolePolicy)**只是投影/执行窗口,不是计费上限**:上限的唯一执行点=客户端 CCB auto-compact(descriptor.contextWindow 驱动),master/egress 侧无按角色的 input token 硬顶(staticKeyProviders 的 maxInputTokens 是 provider 级 1M,非角色级)。故单个超大 turn 可越过 512k 一路冲到 1M 机制窗口、按 kimi 费率计费,普通用户成本短时越出预期档位 | 出现成本异常投诉,或单 turn 输入 P99 > 600k(监控)时:在签发/egress 面补按角色的 input token 硬顶(413 拒),把 512k 从"投影提示"升格为"计费边界" |
| moonshot 直连仅验非流式 happy-path | kimi-k3 上游(api.kimi.com/coding,x-api-key)接入只实测了非流式 happy-path(staticKeyProviders 注释所载);**streaming 下 tool_use 的 input_json_delta 是否真增量到达、真实 429 错误信封形态是否匹配 CCB Anthropic 错误解析器(getAssistantMessageFromError 的 429 分支:anthropic-ratelimit-unified-* 头 / `{error:{message}}` 内层提取 / retry-after 头)均未实测** | 部署后人工跑一次 `scripts/probe-moonshot-kimi.mjs`(要真钱+生产 key,不进 CI):streaming 增量断言 + 打真 429 dump 信封与解析器期望比对,通过后销此债 |
| 0160 系新模型迁移 profile 契约 | **model_catalog capability_profile 必须 snake_case**(parseCapabilityProfile wire 契约;07-17 camelCase 曾致快照重建 fail-closed、模型列表面 503 六分钟)。契约测试 migrationCapabilityProfiles.test.ts 已锁死全部写 profile 的迁移;新模型迁移必须 catalog 行先于 pricing 行(ensure_for_pricing 派生函数不认识新 id 会按 anthropic/200k 建错行),catalog 写走 fn_model_stage_version→fn_model_activate(0144 起禁直插 active) | —(已由测试机制守护,此行留作认知锚) |
| 知识库 org 化 | research_documents/artifacts 租户主键 (user_id,doc_id) + 引用权威链须跨 user 重构 | P3.1 稳定后单独立项 |
| 多 org 归属 | V1 单 active org(uq_user_active_org);放开=删索引+payer 选择+/api/org 显式 org_id | 真实客户需求 |
| org 钱包锁竞争 | 同 org 高并发扣费串行化于 orgs 行锁(spendTwoBucket FOR UPDATE) | 大客户并发异常时改乐观扣减 |
| org settle 归属竞态(接受) | resolveOrgBillingContext 不锁 membership,turn 边界毫秒窗口按解析时刻归属(裁决见该函数注释) | — |
| ~~review 降级披露不入 REST 副本~~ **已消失**(2026-07-07) | 随硬编排退役:不再有 gateway 侧降级披露文案(审查失败即工具错误,队长自行叙述) | — |
| dispatchInbound 预处理窗口不计入 client turn | getOrCreate→首次 submit 之间(mkdir/parseDocument 等 ms 级)hello 重连仍可能误判 turn 未开始(Plan1 既有 follow-up,团队批次未扩) | 该窗口误判实际报障时 |
| ~~reviewer 委派成本归并晚一轮~~ **已消失**(2026-07-07) | 随队长自主送审:审查委派在 engine turn 内完成,先于 engine persist → 正常当轮归因;迟到团队卡补 drain(persistLateTurnArtifacts)同步退役 | — |
| master bridge ring 未接帧分级 | userChatBridge 的 storeStamped 恒 content 级(v5 回放权威在容器 ring,master 侧仅兜底),暂不影响 | master 侧 resume miss 成为主要报障源时 |
| 营销邮件无退订机制 | 群发走 inbox 广播(scripts/v5-inbox-broadcast.ts→createInboxMessage 快照),正文只有"回复退订"人工口径;无 List-Unsubscribe 头、users 无邮件偏好列 | 第二次营销群发前:users 加 marketing_email_opt_out + 快照谓词排除 + 邮件带退订链接 |
| 法律文本主体占位 | /terms /privacy(web-react lib/legal.ts 权威源,TERMS_VERSION=条款生效日,**改正文必 bump**)主体用"本平台运营方"、联系邮箱 auth@claudeai.chat 占位;条款未经法务复核 | 商业主体/ICP 定档时:回填 brand.ts + 法务过一遍全文 + bump TERMS_VERSION |
| **邮件通道故障(2026-07-10 发现,待 boss 修)** | claudeai.chat 的 Resend 验证 DNS(resend._domainkey TXT / send 子域 SPF+MX)约 07-08 从 Cloudflare 消失(疑 v3 退役清理误删),所有外发邮件 400 domain-not-verified:验证码/重置/群发全断;RESEND_API_KEY 为 sending-only 无法自查后台 | boss:Resend 后台复制 3 条 DNS 记录→Cloudflare 加回(DNS only)→Verify;恢复后跑待命群发(见 broadcast 脚本头注释) |
| MCP 工具富卡靠解析文本 | 工具卡批(66e91003)裁决:富卡数据源=前端解析 mcp-memory 文本(格式契约两侧单测钉死,失败回退 OutputBlock)。structuredContent 非一等公民:codex 链路裹在 2000 字符截断 item 串里、CCB 链路根本不透传 | 卡片需要文本装不下的数据(分页/大列表)时:两引擎 runner 改造 structuredContent 透传 |
| ~~codex 原生生图关断~~ **已反转**(boss 07-11 拍板启用,merge 18943fa1) | relay 放行 POST /images/generations\|edits + 撤 features 关断 + AGENTS.md 引导优先 imagegen(gpt-image-2);minimax-media 退居备选/非 codex 引擎 | — |
| ~~codex 生图按张计费未接~~ **已完成** | gpt-image-2 generations/edits 统一成功后每张 50 积分;精确标注编辑在遮罩合成原子落盘后结算;余额不足硬拒、单用户并发 1、UTC 每日成功 10 张、失败不扣费、request/job 幂等 | 运维查 `image_generation_usage_records` + `credit_ledger(reason='image_generation')`;改 relay/结算必须 `deploy-v5.sh --egress` |
| mmx 凭据文件通道(镜像常量对) | codex 路径 env 被双重清洗(buildCodexEnv 剥 OPENCLAUDE_* + codex shell 策略剥 *TOKEN*),mmx 凭据走 entrypoint 每 boot 覆写的 container-auth.json;**新增依赖容器 env 的平台 CLI 必须同样走文件或 OC_ 前缀非凭据名**,argv `-c` 回注 = 违反 token 不进日志不变量(有防回归断言) | — |
| 容器 outboundRing.lastSeq 不跨重启 | 容器回收后帧序从零,依赖客户端游标仲裁(resume_failed no_buffer+to:0 归零+cold_start 清游标,7994ac76)闭环;服务端 seq 持久化(seed 自 durable 源)是对称根治 | 再现"冷容器后 live 帧丢失"类报障时 gateway 域根治 |
| 图片缩略磁盘缓存无运行期逐出 | media-thumb-cache 仅启动清(重启节奏封顶增长) | 磁盘告警时加 LRU 逐出 |
| reminder 无独立 label 字段 | 列表标题=prompt 压平截断兜底(reminderFormat.ts);系统任务中文名是镜像常量(权威源 gateway cron.ts DEFAULT_JOBS,两处需同步) | 用户自定义任务名需求出现时:cron job 加 label 一等字段 |
| CI 失败无告警 | v5-ci 挂/红没有任何推送(07-07 起 commercial-unit 门挂死 3 天无人知,2026-07-10 才根治);GitHub→告警 outbox 无桥 | 下次 CI 再次静默红超 1 天时:加 workflow 失败 webhook→admin_alert_outbox(events 已有 ops 组可挂) |
| admin React 化残余小项 | ①Progress 原语无 tone/fill 定制(hosts 自建 Meter)②typedConfirm(打字确认)未平移,一律 useConfirm danger ③表单 Select 原语缺失(P2/P4/P6 各自局部实现)④fmtCents 字符串版 ¥ 格式化器 4 页内联重复⑤org 调余额后端仍 501 占位 | 下次 admin 批次顺手收敛①-④;⑤随 org 计费批次 |
| 既有三 sweeper 未并入统一 retention 注册表 | account_refresh_events(28d)/provider_health(30min)/wechat_audit(7d,daemon 侧)各自清理,与 auditRetention 注册表并存=双清理权威 | 下次触碰任一 sweeper 时顺手迁入注册表(daemon 侧 wechat_audit 需评估进程归属) |
| 市场审核审计是 handler 层 best-effort | marketplace.skill.review/revoke 的业务 tx 在 marketplaceDb 内部,审计在 handler 层补写(失败有 critical 告警,非静默,但非同事务原子) | 若出现"审过了但无痕"实证:reviewVersion/revokeListing 事务内接 writeAdminAudit(需把审计上下文穿透 storage 层,评估耦合代价) |
| ~~deploy 源码同步非原子~~ **蓝绿已激活**(07-11 迁移完成 rel-278a1085-…-migrated+已合 canonical 8fe7e2e3) | 原半同步窗口(26522660 --delay-updates 仅缓解)已被蓝绿根治:REMOTE_SRC=symlink→RELEASES_ROOT/rel-<sha>-<ts>;deploy=git archive **锁定 sha** 建不可变 release(staging→.complete→mv -T 改名;dist 在 staging pinned 源远端 vite build)→原子 symlink 翻转→restart。消崩溃循环+部署树 HEAD 漂移+混源。**未激活**:须先在受控窗口(无并发部署)跑 `deploy-v5.sh --migrate-bluegreen`(几秒停机把实目录转 symlink 布局)再合并该分支;合并前跑 migrate 否则老 canonical deploy 会因 assert_bluegreen_layout 失败 | —(已激活;首次远端 staging vite build 待下一次 dist 部署实证) |
| 蓝绿:bootstrap 未收口 | 新机 `--bootstrap` 仍建实目录,首次 deploy 会被 assert_bluegreen_layout 挡(fail-closed 无声破坏已防);须手动再跑一次 --migrate-bluegreen | bootstrap 直接建首个 release+symlink(下次碰 bootstrap 顺手) |
| ~~deploy 重启窗口监控告警噪音~~ **已偿还**(07-13) | deploy/dist/rollback 在 restart 前写 schema=2 marker(TTL≤180s),scope=即时健康快照;`--egress`才纳入 egress 两项。monitor 锁内单 snapshot 严验 schema/权限/host/commit/TTL/scope,部署前 bad 不压,smoke 后 schema+nonce+flock 清理,cutover recovery 同锁只清自己；超时仍坏 planned→bad 立即告警，stale schema=1 可信+全健康才自动清,否则保留但部署/告警 fail-open；schema=1 offline-cutover 向后兼容 | — |
| 蓝绿:offline cutover lane 未适配 | stage/activate-staged/offline-recycle/prepare-offline-cutover 仍按实目录 in-place+mv 语义操作 REMOTE_SRC,symlink 布局下会破坏不变量 → 已 assert_not_bluegreen_for_cutover **fail-closed 拒绝**(不静默破坏);但也就用不了该 lane 做 GPT56 类离线大切换 | 做下一次离线大切换(image codex 版本切换等)前,把 stage/activate_staged 也改为 build_release+原子 symlink |
| ~~selfheal:Tier1 动作无 host-routed 执行器~~ **已偿还**(2026-07-17,批1a) | Tier1 改**纯机器路径 host-routed**:master policy 声明 execution_class/action_opcode(0156,派单时同事务冻结到 repair 行)→个人版 jobWorker 按冻结 opcode 经**专用限权 ed25519 key**(authorized_keys `command="/usr/local/sbin/oc-selfheal-host-action"`)ssh kl-mirror 跑**版本化无参 opcode**;三层交集(master policy ∩ 个人版 CONDITION_OPCODE_MAP exact ∩ 远端 wrapper),任一漂移 fail-closed。零 clone/零 codex 会话。生产实证:停 egress→90s 自动拉起→probe 确认→resolved/source=auto | — |
| selfheal:disk 仅检测、禁止 host-global 自动清理 | `ops.monitor:disk` 保留探测，但固定 `auto_repair=FALSE`、`execution_class=tier2`、`action_opcode=NULL`。旧 `clean-v5-disk-v1` 会执行 host-global Docker prune 与 journald vacuum，可能删除回滚构建缓存和排障日志，已从个人版执行器与 V5 policy 一并退役；禁止通过改回 tier1/opcode 复活 | 磁盘到高水位时先只读定位 V5 release/runtime/日志的精确占用，再由人工制定 **V5-scoped** 清理清单并走 production-mutation lease；不得运行 `docker system prune` 或全局 journal vacuum |
| ~~selfheal:Tier1×部署互斥靠 marker 不完备~~ **已偿还**(批1b,production-mutation lease；旧“重取 180s / 无锁补偿”例外已删除)。非 deploy-v5 lane 入列走 `scripts/with-production-mutation-lease.sh` | `deploy-v5.sh` 所有写 lane 从首次 build/远端写前持同一远端 flock；本地 deploy lock→远端 lease 固定锁序。每 lane 预置并 fsync+回读 exact-nonce in-flight marker；payload 与 watchdog 各自独立 PGID，lane 内另有 exact PID/starttime sentinel 锚定 PGID 并贯穿最后的 marker-clear SSH，leader 仅在 clear 返回后释放/reap sentinel。watchdog 同时监 outer/holder/本地安全 TTL/sentinel，任一 STOP/失活先 KILL lane 再释放 lease。人工 wrapper 的 command/supervisor/watchdog 也三组隔离且 gate 前 ready。补偿 helper 与 maintenance cleanup 均复核 live lease；manual recovery marker 原子写+回读失败也 crash-stop。marker 仅做告警隔离，不再承担互斥正确性 | lease loss 统一 rc=86，禁止自动重取/cleanup/补偿/回滚。先核对 deploy_state、A/B symlink/unit、runtime tuple、插件门和持久 saga 证据；确认现场后人工移除 `.mutation-lane-inflight`，再显式 `--recover` / `--abort`。详见 `docs/rfcs/RFC-v5-selfheal-batch1b.md` §1 |
| selfheal:writer-guard trigger 有意 deferred | schema_migrations 有 0136 记账行但 **trigger 不存在**(0137 显式 DROP 并把 SQL 移驻 db/deferred/selfheal_writer_guard.sql;当时回滚池仍含旧 writer)。**验收只认 pg_trigger,禁看 migration ledger** | 回滚池候选全部 ≥ selfheal 合并点后,以**新迁移版本**入仓启用(勿复用 0136 号) |
| ~~selfheal:派单候选无优先级~~ **已偿还**(2026-07-17,批1a P4) | sweeper 派单 ORDER BY:critical(及等待>2h 的 warning 提级)优先→同级 opened_at ASC→id;不 LIMIT(熔断/冷却候选不挡后续事故) | — |
| selfheal:Tier2 release 全链未通(批1b) | transport drill + **Tier1 机器路径已生产实证**(批1a),但 Tier2 代码修复的 真commit→verify→pending_release→一键放行→deployDriver 全链从未走通。**根因不止"没演练"**:①admin 放行→个人版 deployDriver 当前是**同步**的,而部署会重启 master → 放行请求很可能在写审计/返回 200 前被自己杀掉;②deployDriver **不懂 v5 生效面**(把 gateway 代码当普通文件一键 `--with-dist`,实际要重建 runtime image;egress 要 `--egress`;迁移/env/lockfile 不能走一键) | 批1b:先把放行→部署改 **durable async**(admin 事务=claim+审计+outbox→202;个人版 durable release job+独立 worker;结果经 callback outbox 回传;UI/脚本轮询 pending_release→deploying→deployed)+ 落 **touched-path 生效面分类器**(不能安全自动的面继续 pending/manual,禁假报 deployed)+ deployDriver merge 后 push origin(失败则不部署);再做 release drill(selfheal.drill:release_v1 seed + drill 脚本 --release,放行走 admin API 但保留显式 `--approve` 二段人工确认) |
| turn-retry:codex 失败 turn 无干净自动重试 | 实测 codex 0.144:turn status='failed' 后 user input **保留**在 thread(rollout response_item 在 API 调用前落盘不回滚;持久化视图失败 turn 记为 completed/error:null)→ 整 turn 自动重发=重复 user input,已按设计审硬门禁止;现行覆盖=①原生乘性重试(request_max_retries=1×stream_max_retries=5,单 API 调用 12 次尝试,mid-turn 无副作用)②turn/start 应用级拒绝窄路径 gateway 重试③终态友好红卡+精确重试 CTA | 协议里有 thread/rollback(ThreadRollbackParams)可先回滚失败 turn items 再重发;若 capacity 类整 turn 失败频率仍高:隔离探测 rollback 语义(rollout 落盘/计费/并发)后走该路,过 Codex 审 |
| turn-retry:delegate/cron/图片/语音无自动重试 | 举一反三清单确认这些链路瞬时失败一次性放弃(delegate 错误已结构化文案,重试未做;cron 有"下轮自愈"语义可接受;图片 IMAGE_SERVER_BUSY/语音 STT 一次性失败) | 对应链路用户报障出现时:复用 turnErrorTaxonomy.retryable + 有界退避,delegate 优先 |
| selfheal:0137 用户通知全关 | incident_policies.user_notice_enabled 全 f;0137 attestation 只认 svc_v5/http_v5 fully_automatic deploy_v5,AUTO_DEPLOY_TIER2=0 下人工放行不产 attestation → 即使修复成功也不会形成用户通知 proposal(设计使然) | 独立批3:审批人绑定+真实影响证据链演练后,先只开一个 policy 试点 |

### 审计体系速记(2026-07-11 整改批)
- **语义三分层**:`admin_audit`=人类管理员操作留痕(**永久保留**,append-only RULE)/`security_events`(0129)=系统安全事件(route_bypass 等,180d)/运维遥测**不进审计表**(health 快照态=compute_hosts 列,审计只记 health.transition、image.promote.apply 等真实迁移;整改前 84% 是心跳,存量 14 万行已清)。
- **写入单一权威**:`writeAdminAudit`(admin/audit.ts)。action 必须先在 `admin/auditActions.ts` 注册(编译期字面量类型+运行时 fail-fast,野字符串直接抛);每个 action 声明 `mode`:`tx`=fail-closed(资金/权限/封禁/计费配置,以及 sessions.read 敏感读——记不下就不给看),`best-effort`=业务成功后经 `writeAdminAuditBestEffort` 补写(**禁止调用点自 catch**,中央函数带 critical 告警+Prometheus 计数;对 tx 档 action 会抛)。
- **中央脱敏**:writeAdminAudit 入口 `redactSensitive`(auditRedact.ts,SENSITIVE_KEY_RE 命中 key 后按值放行:boolean 恒放行/number 仅 TOKEN_COUNT_KEY_RE 计数形状放行(数值型口令照脱)/string·对象·数组一律脱;已脱敏形状逐字段验类型,`{__redacted:true,raw:…}` 夹带不信任);setting key 整值敏感在 systemSettings.set 调用点判。**新调用点不需要也不应该再自行脱敏大对象,但凭据类字段永远别放进 before/after**。
- **retention 单一权威**:`admin/auditRetention.ts` 注册表 + `auditRetentionSweep` 调度器(leader shared 域,24h tick;关停 `COMMERCIAL_AUDIT_RETENTION_SWEEP_DISABLED=1`,覆盖 `COMMERCIAL_AUDIT_RETENTION_OVERRIDES=table=days,…` 只认注册表内表名)。**新增事件表的清理必须登记进该注册表,禁止再造独立 sweeper**;admin_audit 在 PERMANENT_AUDIT_TABLES,配删除政策会 fail-fast。
- 展示面:admin「审计日志」页 4 Tab(管理操作/安全事件/Agent 工具/主机审计)+请求ID反查(`GET /api/admin/trace/:traceId`→turn_traces)。新增 admin 路由记得跑 `npm run baseline:admin-routes` 重钉路由清单基线(2026-07-26 起测试只读,写基线只有这一个入口)。

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

### 2026-07-17 自愈批1a(Tier1 运维自愈激活)速记
- **纯机器路径**:有确定 opcode 的运维类(egress/disk)**不起 codex 会话**——jobWorker 冻结路由后直接 ssh 跑 opcode→机器 done→master probe 裁决。模型对"重启/清盘"这种死动作零决策价值,只增延迟/成本/注入面;且机器 done 由 root 侧绑定真实 SSH exit 签发,天然满足"模型自述 done≠证据"。**tier2(代码类)才 prepareClone+codex,懒执行**。
- **授权链三层交集**:master policy 声明(execution_class/action_opcode)∩ 个人版 CONDITION_OPCODE_MAP(exact,禁前缀)∩ kl-mirror forced-command wrapper 白名单。**任一漂移 fail-closed,绝不退化成 tier2**。路由必须**派单时同事务冻结到 repair 行**(context 从 r.tier/r.action_opcode 读):从 policy 现读会被"派单后改 policy"竞态升级权限。
- **专用限权 key,禁复用 root 通用 key**:`authorized_keys` 配 `restrict,command="/usr/local/sbin/oc-selfheal-host-action"`,远端只认**版本化无参 opcode**(正则 `^[a-z0-9-]+$` 挡注入),broker 被攻陷也只能触发这几个固定动作而非任意 root。`capabilities-v1` 握手核对三层交集。
- **外部动作的崩溃安全四件套**(改自愈动作面必须全满足):①**执行前** durable pre-claim(tier1_claimed_at CAS),仅 winner 传输;②崩在 claimed 无 receipt→判 `unknown` **绝不重发**(restart 功能幂等但**可用性不幂等**=二次中断);③receipt set-once + **写后回读**(graceful shutdown 释 lease 会让新旧 owner 同时在场,必须都从同一 SQLite winner 收口,否则证据双权威);④终态 CAS 与 callback enqueue **同一事务**(CAS 落空=cancel 已终态→绝不 enqueue stale callback),且全程持 `withRepairLock`(与 cancel 同锁,否则"已确认取消后仍重启")。
- **动作已尝试 vs 未获准**:`rejected`(本地白名单/forced-command 拒=没执行)→machine failed;`completed/action_failed/unknown`(到了宿主)→都发 done 进 verifying,**由 probe 裁决恢复**——远端非零 exit 直接判失败会制造假失败+误累加保险丝。receipt 必须强绑定(opcode===requested + `Number.isInteger(exit)` + exit===process exit + outcome/exit 一致),ssh **255=transport 错误→unknown**(不是远端失败)。
- **坑:P8 收口重启 smoke 用 `/api/doctor` 恒假失败**(需鉴权→401),健康端点是 `/healthz`。**寄宿会话重启纪律**:配 env 与重启**合并成一次**(分两次=多中断一次);marker 按目标 SHA 命名(新 commit 才允许下次重启,at-most-once 防复读)。

### 2026-07-16 自愈批0(契约收口+drill 一等公民)速记
- **执行契约三方钉死**:oc-selfheal CLI 四命令(context/report/verify/cutover)= 唯一权威;修复代理 SKILL 权威源在个人版仓 `ops/selfheal/skills/v5-incident-repair/SKILL.md`(provision step_skill 原子安装+装后逐字节校验),prompt(executionLedger.buildRepairPrompt)与 SKILL 教同一契约,三方由 selfhealSkillContract.test.ts 行为测试锁定(SKILL 示例真实 spawn CLI)。**改任何一方必须三方同改**。事故背景:07-11 手放 SKILL 教了 ack/broker 等不存在的子命令,修复代理首条命令即失败。
- **drill 机制**:0155 seed exact policy `selfheal.drill:transport_v1`(常驻 enabled=t/auto_repair=f/user_notice=f);演练=kl-mirror release 树跑 `npx tsx scripts/v5-selfheal-drill.ts`(单 PG 连接 advisory lock+九检查点断言+异常安全清场:auto_repair 先关再翻 condition)。**drill key 是跨仓契约常量**(v5 conditionKeys.SELFHEAL_DRILL_TRANSPORT ⇄ 个人版 broker SELFHEAL_DRILL_TRANSPORT_KEY):dispatcher cooldown 豁免、broker context/report 白名单都只认精确常量,新增 drill 类型必须两侧显式扩表,禁前缀化。
- **归因让位(P3)**:reconciler probe 收口一律走 `resolveIncidentByProbe`(单条 CAS 内嵌 NOT EXISTS verifying 守卫,防 TOCTOU);verifying 窗口归 sweeper 的 succeeded+resolve(source='codex') 同事务。admin/suppression 收口必须能压过 verifying(走无守卫 resolveIncident)。**新增 resolve 调用点先想清归因语义再选函数**。
- **条件键冻结**:个人版 jobWorker 起 turn 前用 root 持有的 capability 从 master context 冻结 conditionKey 到 job 行(set-once,fail-closed);broker 一切 drill 判定只读冻结值。给 repair 加任何"按事件类型区别对待"的能力都必须走这条冻结链,禁信 payload/模型自述。
- **admin = web-react 第二 Vite 入口**(`admin.html` + `src/admin/**`,21 页,hash 路由 `#tab=NAME&k=v` 兼容旧深链);URL 仍 `/admin.html`(+`/admin` 302);鉴权 refresh→me→role gate。地基组件权威在 `src/admin/components`(StatCard/ChartCard/DataTable/FilterBar/useAdminPoll/adminApi),页面禁手写内联样式原语。
- **告警送达不变量**:enqueueAlert 零订阅通道→inbox(uid=1)兜底;critical 恒 inbox 镜像(每 enqueue 至多一次)。shell 侧(monitor/daily/alert-fail)psql 直插 outbox,**判定单一 SQL 权威 = scripts/v5-alert-fanout.sql——改订阅/静默判定必须 TS(alertOutbox.ts)与该 SQL 同改**。注意:企微通道 severity_min=warning 时 info 级(恢复通知/日报)不进企微是订阅语义,非 bug。
- **坑:undici NO_PROXY 不支持 CIDR**。master 全局 EnvHttpProxyAgent 下,fetch 内网桥接 IP(172.31.0.1)必须 per-request `directEgressDispatcher()` 直连(modelOps 容量面曾因此静默降级 local_fallback);任何新的 master→内网 fetch 同此纪律。
- **坑:新增 npm 依赖不随 deploy 上线(07-11 实际停机 ~4 分钟)**。deploy-v5.sh rsync 排除 node_modules 且不跑 npm install;批次若加了新依赖(package.json/lock 变更),master 重启即 ERR_MODULE_NOT_FOUND 崩溃循环(实例:连接器批的 imapflow,由后续无关部署首次带上线引爆)。**纪律:合并含 package-lock 变更的批次后、restart 之前,必须 `ssh kl-mirror 'cd /opt/openclaude/openclaude-v5 && npm install --no-audit --no-fund'`**;止血=同命令补装后 restart(lockfile 已同步,秒级)。根治债:deploy-v5.sh 检测 package-lock 哈希变化自动补装(见 §5)。
- **坑:CI commercial-unit 门曾挂死 3 天(07-07~07-10)**。根因=握手测试对"背靠背同步双帧"用逐次 once('message') 取帧,第二帧在无 listener 窗口被 EventEmitter 丢弃→await 永挂→30min 超时 cancelled。**WS 测试等多帧一律用 userChatBridge.test.ts 的 frameCollector 模式**(持久 listener+队列)。诊断法:TAP 停哪个套件之后+零改动探针 PR 定责基线。

### 2026-07-16 agent 能力批:baseline 评测体系 + SKILLS 菜单排序速记
- **baseline 技能可带评测集**:`ccb-baseline/skills/<name>/evals/evals.json`(源码维护,schema=storage/skillEvals.ts,≤5 case)。形态白名单三处同源:运行时挂载校验(v3supervisor.ts resolveCcbBaselineMounts:skill 目录恰好 {SKILL.md} 或 {SKILL.md,evals/},evals/ 内恰好 evals.json,每条走 assertBaselineLeaf lstat 闭环)+ 部署 guard(scripts/v5-baseline-security.sh)+ 测试(ccbBaselineSkills.test.ts,含 evals.json 可解析门)。**再扩 scripts/ references/ 时必须三处同改**。
- **eval API 平台感知**:GET evals / POST eval-run 对平台技能 includePlatform:true(只读+跑),PUT 仍被 writable 403;"用户向 skill API 禁平台技能"红线只针对**管理面板枚举**(/api/skills 列表),按名评测读取不在此列。draft 评测/训练/AI 生成用例对平台技能仍 404。
- **回归复跑**:`scripts/run-baseline-skill-evals.sh`(独立 `v5-evals` 账号)无参=仓库树枚举带 evals 的 baseline + 该账号用户技能;verdict"反而更差"或 failed → 非零退出。当前仓库 9 个 baseline 技能带 evals(app-connectors/web-context/office-spreadsheet/office-pdf/document-writing/scientific-figures/scheduled-tasks/memory-management/skill-search);周报按仓库树动态核对,缺任一结果即异常。单技能默认等 60min(`OC_EVAL_MAX_POLLS` 可调),覆盖真实 app-connectors 冷启动首 case 已超过旧 20min 窗的生产实证;长跑中 access token 过期会带同一 HttpOnly refresh cookie 静默续期并在退出时 logout,不再把 401 误作永久 poll 故障。整轮由 systemd 12h 外层限时(覆盖 9×60min 串行上界并留重试/汇总余量)。
- **SKILLS slot 排序**:SKILL.md frontmatter 可选 `priority`(-100..100,storage normalizeSkillPriority 钳制);注入菜单=用户技能恒先→平台按 priority 降序→字母序,cap 仍 15(根治字母序截断把 office 套件/web-context 挤出菜单)。管理面/搜索不受影响。
- **生产失败模式修复**:oc-web 抓 SERP 反模式写入 web-context skill(SERP=反爬垃圾/超时,搜索走内置 WebSearch);oc-browser 子命令 --help 改打印用法 exit 0;web-context parser 超时报错带可操作提示(py+mcp 两侧);ccb-baseline/CLAUDE.md 不再手抄技能清单(指向 skill_list,根治腐化)。
- **回归管道(债①已偿还,07-16 债偿批)**:`openclaude-v5-baseline-evals.timer` 每周一 04:30 沪时跑 `scripts/v5-baseline-evals-weekly.sh`(独立 eval 账号全量,结果 JSONL 落 kl-mirror:/var/lib/openclaude-v5/baseline-evals/ 保留 12 轮);runner 非零、仓库 eval 技能缺结果/重复/未完成/两臂 benchmark 不齐、反而更差或 with 臂较上轮降 >10pp → warning 进企微,正常 info 周报进站内信;告警判定同 v5-alert-fanout.sql 权威。单元手动 cp+daemon-reload(部署惯例);eval 凭据=kl-mirror:/root/.secrets/v5-evals.password。**有意取舍:与 deploy 解耦不阻断发版**(单轮 1-2h),模型/镜像升级后想立即验证就手动跑 run-baseline-skill-evals.sh。
- **市场平台实测(债②首迭代已偿还)**:`scripts/v5-market-skill-eval.sh <slug>`=独立 eval 账号临时安装 active 上架技能→跑 bundle 自带 evals→打印平台实测通过率/verdict→还原卸载;`done` 但 without/with 任一臂缺失或非法仍按失败退出。**边界(登记债)**:仅支持 active 版本(安装口对 pending fail-closed,待审版本 sideload=独立安全面改造);实测结果不回写 DB(verified 徽章链路待"评审时需要 UI 内看到平台实测"时立项)。
- **评分卡 a+b(已上线,boss 07-16 批,PR #65)**:a=高成本 turn(≥60s 或工具/团队消息≥3)完成后轮末评分行脉冲高亮 4s(Stop 轮不亮,prefers-reduced-motion 豁免);b=中途打断(>10s 秒停窗)/改写重发(5min 内 bigram Jaccard≥0.55)静默 implicit down。**铁律=显式永远压过隐式**(upsert 冲突 WHERE,PG 集成测试钉死);消费面口径:前端回读/满意度统计/市场公开评分**排除** implicit,差评驱动训练燃料**纳入**;机器标记权威=responseRatings.ts 的 IMPLICIT_RATING_TAG,新增消费面先决定属于哪一侧。
- **债(触发条件)**:①待审(pending)版本的平台实测 sideload。②verified benchmark 徽章(DB 列+admin/用户两侧 UI)。

### 2026-07-11 管理后台全面审计修复批速记
- **cron 引擎错误熔断(容器侧 gateway/cron.ts)**:API 错误产出(CCB "API Error: …" 文本块)一律不作为任务结果送达;`insufficient_credits` 连续 3 次 → 持久化停用任务(cron.yaml enabled=false)+ 恰好一条暂停通知(凌驾 deliver=local);瞬时错误(429/上游)只抑制送达绝不替用户关任务。**错误识别单一权威 = errorClassify.classifyDelegateOutputError,禁再造第二套字符串匹配**。背景事故:402 × 每 5 分钟 schedule,35h 刷 424 条同文站内信(user 66)。
- **inbox-post 同内容去重(master 侧)**:同 uid+同 (title,bodyMd) 6h 窗口只落一条(`{ok:false,reason:'duplicate'}`)。内存窗口重启清零,是信任边界兜底闸,根治在容器侧熔断;逐分钟限频拦不住"低频×长时间"重复轰炸这一类。
- **allow_registration 单一权威恢复**:拆除 handleRegister/handleGetPublicConfig 的 v5 channel bypass(v3/v5 共库过渡脚手架,v3 已退役)。现在 admin 系统设置页翻 `allow_registration` 即真实全链路生效(后端 403 + 前端注册入口隐藏 + linuxdo allowCreate 三面同源)。DB 值已置 true(与放开注册的现实对齐)。
- **告警通道卫生**:ilink_wechat(channel id=4)自 05-13 session 过期不可达,已停用(enabled=false);告警企微送达权威=wecom_aibot(id=5)。恢复 ilink 需重新登录激活后再启用。

### 0105 模型与服务商运维页(2026-07-06)速记
- 服务商枚举权威 = protocol STATIC_KEY_PROVIDERS(+codex 虚拟条目);provider_ops 表**稀疏**只存运维字段,首次 PUT 建行 —— 新增 provider 本页零改动,严禁再造种子清单。
- model_pricing 放开价格列编辑的四重护栏:normalizePriceCents 十进制整数分 + DB CHECK>=0 + 逐列审计 + **lock_version 整数乐观锁**(价格列强制 if_match;不要用 updated_at 毫秒比较,timestamptz 微秒会被 pg→JS 截断)。
- per-model default_effort:注入点在 proxy authorize 后(合并不覆盖 client 显式值);适用性按 spec 推导(allowedOutputConfigEfforts 白名单 / strip output_config→不适用 / deepseek+OAuth 透传全枚举)。
- egress latencyProber:transport 语义(GET 上游端点,零配额),dispatcher 必须按 STATIC_PROVIDER_META.egress 复刻;in-flight guard 防 tick 重叠。
