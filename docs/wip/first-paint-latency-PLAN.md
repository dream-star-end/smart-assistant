# V5 selfhost 首字延迟优化方案(feat/v5-first-paint-latency,R2 修订)

## 背景与实测

近 7 天 webchat 556 turn:发送→首条可见输出 p50=23.3s,p90=55.5s,39% 超 30s。
根因不是流式链路(delta 已逐帧推送)也不是模型(上游 TTFT p50 340ms),而是引擎侧启动:

- cursor-*(one-shot CLI):间隔<2min 首包 1.5s;>2min 33-40s(临时 HOME 每 turn 销毁,冷热差疑似云端会话/登录,本地证据缺失)
- grok-build(one-shot CLI):热也要 7.2s(MCP 每 turn `node+tsx` 冷启动,startup_timeout_sec=30),2min-2h 16-21s,>2h 77s
- glm/CCB(常驻进程):热 1.2s,冷 spawn ~20s(bun + --resume JSONL)
- codex(常驻 app-server,对照组):10min-2h 仍 0.9-1.6s,冷 5-8s

## 改动四项

### 项1 MCP server 预构建(消除 grok/cursor/zcode 每 turn ~7s + CCB/codex spawn 时 npx tsx)

- 新增 `packages/mcp-memory/scripts/build-oc-memory-mcp.sh`:esbuild 把 `src/index.ts` 打成
  `packages/mcp-memory/dist/oc-memory-mcp.cjs`(与 build-oc-memory-cli.sh 同配方:
  `--bundle --format=cjs --platform=node --target=node22 --external:better-sqlite3 --external:sqlite-vec`)。
- `packages/gateway/src/mcpMemoryEntry.ts` 新增 `resolveMcpMemoryLaunch(claudeCodePath?)`,
  返回**完整 launch descriptor** `{ command: string, args: string[], entry: string }`:
  - dist cjs 存在且可读(`fs.accessSync R_OK` 探测)→ `{command:'/usr/local/bin/node', args:[cjs]}`
  - 否则回落现状 tsx 形态(fail-open + `warn` 一条结构化日志);release 构建期靠 hook 的
    fail-loud 断言保证线上不走回落。
  - 消费方一律不再自行推导 tsx 路径。
- 五个消费方改走该 helper:`engine/grokPlatform.ts`、`engine/cursorAdapter.ts`
  (buildCursorMemoryMcpConfig)、`engine/zcodePlatform.ts`、`subprocessRunner.ts`(CCB mcp-config)、
  `codexLaunchOverrides.ts`。
- 部署面 hook(dist/ 被 gitignore、master release 是 git archive,不加 hook 则 host 引擎吃不到):
  - `scripts/v5-selfhost-master-release-lib.sh` `build_master_release`:web-react vite 之后调用
    MCP 构建,断言产物存在且非空,fail-loud。
  - `scripts/v5-runtime-release-lib.sh` `oc_hotcfg_finalize_release`:现有 CLI 构建旁并列加
    MCP 构建(容器 CCB/codex 同收益;旧源无脚本则跳过,回滚兼容)。
- 不进 platform bundle(扩展名白名单无 .cjs 且 native addon 需从 node_modules 解析)。
- 测试:launch helper 单测覆盖「cjs 优先/cjs 不可读回落/tsx 回落」及 host(live 树)与
  runtime(/opt/openclaude)两种布局候选;更新 `cursorAdapter.test.ts` 钉死的 tsx argv 断言;
  mcpMemoryEntry 既有断言同步。

### 项2 cursor 诊断门(本批不做 persist HOME,防白改)

依据:HOME 每 turn 都销毁但 <2min 仍 1.5s → 30-40s 冷启动无法归因本地 JWT;先取证再动生命周期。

`oc-cursor.sh` 加 env gate `OPENCLAUDE_CURSOR_AGENT_DEBUG=1`(默认关,关时零行为变化):

- 开启时不设 `CURSOR_AGENT_DISABLE_DEBUG_LOG`,并把 CLI stderr 同时落盘:
  `2> >(tee -a "$log" >&2)` 进程替换,**不用管道**——`$!` 仍指向 setsid 的 CLI 进程组 owner,
  退出码不被吞,stderr 照常回传 gateway(tee stdout 重定向回 wrapper stderr);tee 是 wrapper
  的子进程、不进 CLI 进程组,cleanup 杀进程组后 tee 随 EOF 自然退出,断言无残留。
- 日志路径与治理:
  - 目录 `$OPENCLAUDE_HOME/logs/cursor-cli/`,`mkdir -p` 后强制 `chmod 0700`;目录或文件为
    symlink → 拒绝并回退关闭 debug(fail-open 到"无日志",不失败 turn)。
  - 文件名 `cursor-cli-<sha256(sessionKey) 前 16 位>.log`,原值不进路径;`umask 077` 下创建
    (0600),追加写。
  - 容量:每次启动前若文件 >10MB → `mv` 为 `.1`(覆盖旧 `.1`,每会话至多 2 份);同时
    `find -mtime +7 -delete` 清理 7 天前日志。
  - 不记录 env/API key(只落 CLI 自身 stderr);
  - `/api/file` 读取面:`FILE_BLOCKED_PATTERNS` 增加 `/logs\/cursor-cli\//` 防泄露。
- 不改 HOME 生命周期、不动 key 轮转、不预 mint grok relay token(one-turn 语义 + 并发占槽)。
- grok 冷启动大头由项1 覆盖。persist HOME 是否做,等 debug 证据后另立批次。
- 测试:wrapper 测试(`cursorCliWrapper.test.ts` 增补):debug 关=行为与现状 bit 相同;
  开=日志落盘、0600、退出码透传、Stop 后无 tee/CLI/tool 残留、symlink 拒绝。

### 项3 会话打开时引擎预热(CCB spawn ~20s / codex 5-8s 藏进打字窗口)

- env gate:`OC_ENGINE_PREHEAT=1`(默认关;selfhost env 打开)。不复用 OC_PREHEAT_DISABLED
  (那是 v3 镜像预热,语义相反)。
- **并发收口(两个 runner 都改成共享 in-flight promise)**:
  - `SubprocessRunner`:新增实例字段 `_startPromise: Promise<void> | null`;`start()` 一律
    `return (this._startPromise ??= this._doStart().finally(自身 identity 清理))`;
    submit 与 preheat 都 await 它(修掉现状 `starting=true 直接 return → submit 下一行 throw` 的窗)。
  - `codexAppServerRunner.ensureSpawned()`:同样收口为共享 in-flight promise
    (现状"已 spawn 未 initialized 直接 return"会让 submit 在 initialize 完成前继续);
    新增 public `preheat()` = ensureSpawned 全套(含 ensureLaunchOverrides,与 runTurn 走
    **同一条 repo snapshot/cwd/launch overrides 解析路径**,不另写一份),**禁止**
    thread/start、thread/resume、turn/start——零上游 LLM 调用、零 LLM 计费。
- `SessionManager.preheatSession(input)`:
  - gate 关 / 已 isRunning / `_plannedTeardown` / `_replacing` / prompt-queue in-flight → skip(记原因)
  - **执行授权(评审点)**:先按 bootAutoResume 同款调用
    `resolveLocalExecutionIfEnforced({ kind: 'prewarm', ... })` 取投影;投影失败/拒绝 →
    skip(记 `skipped_authority`),**不得**绕过 fail-closed;成功则把
    `localExecutionOverride(preExec)` 与会话权威记录的 agentId+modelId 一并传入 `getOrCreate`
    (避免首条消息 model 不一致触发 3880-3904 shutdown-respawn)
  - 抢 `session.lock` 后二次校验,再按 engine 分派:ccb→`runner.start()`;codex→`preheat()`;
    grok→仅 `projectGrokPlatform()`(写 GROK_HOME/config,无进程);cursor/zcode→skip
  - module 级 singleflight Map(sessionKey 去重)+ 全局并发 cap 1;完成刷新 lastUsedAt
  - 语义边界(测试与注释都写明):预热不发 LLM turn、不产生 LLM 计费;但 CCB/codex spawn 会
    拉起 MCP 子进程与连接,用户自配 MCP 的初始化可能有网络/资源副作用——由并发 cap、
    失败日志与 gate 兜底。
- 钩子:`server.ts` `GET /api/sessions/:id` 的 **full 与 `?since=` 增量两条 200 路径**,
  在鉴权通过、会话行取到之后 fire-and-forget;agentId/modelId 取自该次已读出的
  client_sessions 权威行(不重复查询)。sessionKey 拼法与 autoResumeFromHello 一致:
  `agent:${agentId}:webchat:dm:${sessId}`。明确不挂 bootAutoResume/全量 hello/POST read。
- 观测:结构化日志 `engine_preheat`,字段 `{engine, outcome: started|already_running|skipped_<reason>|failed, spawn_ms, initialize_ms?}`,
  上线后可区分「未触发/被 cap 排队/预热失败/模型切换重启」。
- 测试:preheatSession 单测(gate/各 skip 原因/model 传递/**authority 投影失败→skip**/与
  submit 并发时 submit await 同一 promise 不 throw);`_startPromise` 可重入单测(并发 start、
  失败后可重试);codex preheat 不发 thread/turn 的断言。

### 项4 冷启动可见状态(前端把"白屏 30s"换成"引擎启动中/恢复会话中")

- 协议:`packages/protocol/src/frames.ts` OutboundTurnStatus 第一支 union 增加
  `'engine_starting' | 'engine_resuming'`(gateway 显式映射,不透传 raw)。
- 类型同步(评审点):`packages/gateway/src/engine/engineEvents.ts` `EngineTurnPhase`、
  `server.ts` `_turnStatusWireFields()` 的**显式返回 union**、`session.currentTurnStatus`
  缓存类型、相关注释与测试全部同步。
- 发帧(sessionManager `_runOneTurn`):
  - submitTurn 前若 `!session.runner.isRunning` → `onEvent({kind:'turn_status', status:'engine_starting'})`
  - per-turn `runner.on('spawn', info)` → `engine_resuming`(resumed)/`engine_starting`,
    detach() 卸监听
- **清态统一在 gateway(评审点)**:per-turn 维护 `startupPhaseActive` 标志,
  首个"可观察事件"到来时结束启动态——`kind:'block'`、`kind:'permission_request'` 到达且
  标志仍在 → 先发 `{turn_status: null}` 再转发该事件;任何后继 `turn_status`
  (compacting/working/retrying/waiting_for_user/null)到达 → 直接置标志失效(其自身语义接管,
  含 working 只刷 hint 的情况也先发 null 清阶段态)。turn 终态(final/error/interrupt)同样清。
  前端 applyOutboundMessage/权限帧的清理只作为丢帧兜底。
- 前端:`model.ts` TurnStatusState 加两值;`reducer.ts` applyTurnStatus 识别 + 首内容/权限帧
  兜底清理(对齐 retrying 清态);`TurnActivity.tsx` 在 compacting 之前加两支(优先级低于
  retrying/recovery):「{name} 正在启动引擎 (Xs)」/「{name} 正在恢复会话 (Xs)」;
  `pure.ts` computeTypingLabel 同模式。遵守"长任务状态 UI 单一归属"——只改既有活动行文案,
  不新增卡片/按钮。
- sideband 语义复用:deliver() 已跳过微信/Telegram adapter;桥侧 milestones 不受影响。
- 兼容:旧前端对未知 status 已有"忽略置空"语义与单测;补 rolling 用例(新 status 打旧
  reducer 路径 = 清态不粘)。
- 暖启动(cursor/grok 每 turn spawn 1-2s)会短暂闪启动态,可接受;CCB 暖进程不 emit spawn,无误报。
- 测试:
  - 单测:chat.test.ts(applyTurnStatus 两新值/首块清态/rolling)、turnActivity.test.tsx 文案分支、
    gateway spawn→turn_status 映射与统一清态、frames 协议测试。
  - **真浏览器**(playbook 门禁,`packages/web-react/browser-tests/` + `npm run test:browser`):
    新用例覆盖「启动态出现→首内容清除→终态不粘→重连不粘」,并做红绿对照
    (撤掉清态逻辑跑一遍必须红)。

## 不做清单(明确出界)

- cursor persist HOME / CLI 常驻化(等项2 debug 证据,另立批次)
- grok relay token 预 mint
- bootAutoResume/hello 全量 spawn 预热
- 微信/QQ 等 adapter 面(sideband 不进 adapter)
- LRU 时长调整

## 测试与部署(多生效面,逐面断言)

- 单测/集成:gateway / web-react / protocol / mcp-memory targeted 实跑;web-react 真浏览器测试;
  新增 integ 测试(若有)登记 `.github/integ-tiers/`。
- 构建验证:worktree 实跑 build-oc-memory-mcp.sh,`node dist/oc-memory-mcp.cjs` 做 stdio 握手 smoke。
- 部署生效面矩阵(selfhost):
  1. gateway/protocol/mcp-memory/sessionManager 源码 → master release
     (`scripts/deploy-v5-selfhost.sh --deploy`);活体断言:live 树存在
     `packages/mcp-memory/dist/oc-memory-mcp.cjs` 且非空。
  2. web-react → 同一 --deploy 的 vite build;活体断言:live dist 指纹变化 + 页面加载新 bundle。
  3. `oc-cursor.sh`(platform-runtime)→ platform bundle 面;活体断言:新 bundle rev 中
     该文件含 debug gate。
  4. runtime release finalize(容器 CCB/codex 的 MCP bundle)→ 随 --deploy 的 runtime 轴;
     活体断言:runtime release 目录含 MCP cjs。
  5. env 增量 `OC_ENGINE_PREHEAT=1` → 手动写入 /etc/openclaude/commercial-v5-selfhost.env
     (env overrides 红线:手动同步 + 在交付说明登记)。
- smoke:`--smoke` 通过后实测——打开冷会话看「正在启动引擎」;发消息测首字耗时;
  `OPENCLAUDE_CURSOR_AGENT_DEBUG=1` 单独临时开启一轮取 cursor CLI 日志证据后关闭。
- 效果验收:对照 PG tape/friction 指标看部署前后 p50/p90(首条 tape 记录延迟、first_*_frame)。
- 回滚:四项彼此独立;MCP dist 缺失自动回落 tsx;preheat/debug gate 关闭即回现状;协议新值旧前端忽略。
