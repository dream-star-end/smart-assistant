# RFC — v5 自愈批1b:Tier2 代码自愈(放行→部署 durable async + 生效面分类器)

> 状态:**设计稿 v2**(v1 骨架被 Codex 判 HOLD/6 BLOCKER,本稿按其裁定重做)。
> 前置:批0(drill 一等公民 + 机器 ack)、**批1a(Tier1 运维自愈纯机器路径,已生产实证)** 均已上线。
> 目标:让 **Tier2 代码自愈**安全走通 —— codex 改代码 → 四层 verify → pending_release → boss 一键放行 → 真部署 → probe 归因。

## 0. 为什么不是"补个演练就行"

v1 以为缺的只是 release drill。实际有两个结构性根因:

1. **放行→部署是同步的**:v5 admin handler 同步等个人版返回 deployed;个人版 deployDriver 同步跑 `deploy-v5.sh --with-dist`,而**部署会重启 master** → 原 HTTP handler 很可能在写审计/返回 200 前被自己杀掉。
2. **deployDriver 不懂 v5 生效面**:固定 `--with-dist`,只有一份窄 denylist。

## 1. 与"正常部署/开发"的协调(boss 硬要求:不得互相冲突)

### 1.1 现状与其不足(诚实标注)

批1a 已落两闸:① monitor 在 planned-maintenance 窗口不投影 condition → 自愈不被派单(**主场景有效**:`deploy --egress` 的 marker 含 egress 两项);② host-action wrapper:marker 活跃则任何 opcode 让路(exit 66)。

**但 marker 不能充当互斥锁**(Codex B2,必须承认):

- marker TTL 仅 180s,且**在部署构建/远端 staging 后期才创建** —— 不覆盖整个 release build 段;
- 无健康检查时 marker 可 `SKIPPED`,部署仍继续(此时闸不存在);
- wrapper 是"先检查再执行" → **check→action TOCTOU**;
- host-global disk cleanup（旧 `clean-v5-disk-v1`，现已退役）会与 Docker/runtime build 抢;
  egress restart 会与 `--egress` 激活/回滚抢。

→ 当前残留风险**低但非零**(disk 类未开;主场景 marker 覆盖 restart 段),但**不得宣称已根治**。

### 1.2 根治:kl-mirror **production-mutation lease**(独立于 marker)

- kl-mirror 上一把独立 flock(如 `/run/openclaude-v5/production-mutation.lock`)。
- `deploy-v5.sh` **每个写 lane**(deploy / --dist / --with-dist / --egress / rollback / P3 / baseline-remount / tuple 激活)**从第一次远端写或 build 之前**一直持有到 **smoke/补偿结束**。
- host-action wrapper **不是查询它**,而是 `flock -n` **取得同一把锁并持有整个 opcode 执行期**;拿不到 → exit 66 让路(消灭 TOCTOU)。
- 本地 `/var/lock/oc-v5-deploy.lock` 与远端 host-mutation lease **固定锁序**(先本地后远端),防死锁。
- **marker 回归本职**:只做告警隔离,不承担互斥正确性。
- **失锁一律 crash-stop（旧的“重取 180s / 无锁补偿”例外已删除）**：每条写 lane 在首个副作用前预置 exact-nonce `.mutation-lane-inflight`；独立 PGID watchdog 同时监督 outer、远端 holder、更早到期的本地 TTL 与 lane 内 exact PID/starttime sentinel。sentinel 与 leader 同 PGID，并一直保留到最后的 marker-clear SSH 返回；leader 随后才释放/reap sentinel，故 leader 被提前 reap 时仍有不可复用的 PGID 锚点。任一监督面失活先 `SIGKILL` 整个 lane PGID，再释放残余 lease。失锁后禁止自动重取、cleanup、补偿或回滚，返回专用 rc=86 并保留 in-flight / saga 持久状态。运维必须先核对 deploy_state、symlink/unit、runtime tuple 与插件门，人工移除 in-flight marker 后才可运行显式 `--recover` / `--abort`；不得按旧 runbook 在另一 holder 可能已写入后继续盲补偿。
- **非 deploy-v5 lane 也必须入列**(Codex MAJOR4):人工 migration / env 同步 / systemd unit 安装 / runtime image build+tag 切换等,要么走持同一 lease 的受控 wrapper/runbook,要么在 durable maintenance inhibit 下执行。`with-production-mutation-lease.sh` 的 command、supervisor、watchdog 分属独立 PGID；watchdog 在 gate 前 ready，并把 supervisor/holder/TTL 的 STOP/dead 与失锁同样裁决，先 KILL command 再断 lease——否则"绝不冲突"不成立。

### 1.3 批1b Tier2 部署面

- **只部署"恰好获批的 SHA"**,绝不部署"当前 canonical HEAD";**canonical 被他人推进 → 放弃部署**(`manual_required` + 告知 boss),绝不夹带别人未验证的 commit。
- **禁止部署前 push canonical 分支**(v1 的错):失败候选会被下一次无关的人工部署夹带上线 → 走**不可变 candidate ref**(§4)。
- 双 master A/B:**只允许 `deploy_state=stable` 时进入 Tier2 普通 deploy,且在 merge 前锁内检查**。
- **offline cutover 与 "repair cutover" 是两回事**(同名易误用):蓝绿下 offline lane 本就 fail-closed,**Tier2 不得调用**。
- 全局熔断只拦 **Tier2 新部署**,**不拦**人工 `rollback/recover/abort`。

## 2. P1:放行→部署 durable async(两套独立账本)

**不给 `selfheal_jobs` 加 kind**:它的 `starting/running` 租约是为"崩溃后重新 claim/redrive"设计的,而 release deployment 要求"claim 后绝不重放" —— 恢复语义相反,混表会被通用 reclaim 误重放。

- v5 PG:`selfheal_release_requests`(关系化,唯一活跃请求由约束保证)+ delivery outbox
- 个人版 SQLite:`selfheal_release_jobs`(独立于 `selfheal_jobs`)

状态机:
```
repair: running ──────────────────────────────────> verifying
                   release request
queued → accepted → deploying → deployed
                        ├──────→ deploy_failed
                        └──────→ deploy_unknown   ← 全局熔断
```

要点:
- admin 放行事务内:锁 repair + 验证**结构化** pending_release + 插入唯一 release request + 永久 admin audit + enqueue → 返回 **202 + releaseRequestId**(不再同步等)。
- **废除 JSON `detail.release_claimed` 第二权威**:唯一活跃请求由关系约束保证。
- webhook body 带**不可变 `releaseRequestId`**;个人版按 request id + payload hash 幂等,落盘后立即 202。
- 个人版 job **接收时冻结** `sha / baseSha / deployPlanHash / manifestHash`(执行时不再从可变记录推导)。
- callback outbox 唯一键 `(release_request_id, phase)`(不再只 `(repair_id, phase)`);新增 phase `deploying/deployed/deploy_failed/deploy_unknown`(传输上仍映射 progress/done/failed)。
- `deployed` callback **同一 PG 事务**:更新 release request + 追加事件 + 把 repair 推到 `verifying`(复用现有 done→verifying 收口)。
- **`deploy_unknown` 拉全局 Tier2 部署熔断 + critical 告警**,禁下一次自动 cutover,直到人工按 `/version` / deploy_state / 远端 ref 裁决。**不能**当普通 failed 释放后继续部署。
- 崩溃规则:claimed 无 receipt 时,**先确认没有遗留 deploy 子进程仍在跑**(systemd cgroup 保证),再落 `deploy_unknown` —— 否则会一边显示"未知待人工"、旧脚本却仍在后台切生产。
- cancel/release 互斥按 `releaseRequestId` 重定义:未 pre-claim → cancel 可赢并撤销 queued release;已 pre-claim → cancel 返回 too late/in progress,结果由 receipt 裁决。

## 3. P2:生效面分类器(fail-closed,与 playbook §4.1 同源)

**v1 分类是过时认知**:hotcfg 后 gateway/CCB/storage/protocol/mcp-memory 走 **runtime source release 轴**,不再一律重建镜像;真正的 image 面主要是 Dockerfile/apt/pip/浏览器/CLI pin/sudoers。

一键可部署(返回**生效面集合 + 精确 deploy argv**,多面取并集):

| 面 | 处置 |
|---|---|
| master 源码 / docs | 普通 `deploy-v5.sh` |
| web-only | `--dist`;web+其他代码 → `--with-dist` |
| runtime source | 普通 deploy,但**必须活体确认 runtime-release 轴已启用**,否则 manual |
| platform-runtime | 普通 deploy,**必须确认 platform-bundle 轴已启用** |
| egress(`packages/commercial/src/egress/**`) | 上述基础上**追加 `--egress`**;**需 boss 明确放行后机器执行**(不是无人值守) |

**manual-only(fail-closed)**:DB migrations / env overrides / `scripts/**` / `deploy/**` / `.github/**` / 任意 `*.sh` / **所有层级 `package.json` 与全部 lockfile** / Dockerfile / 镜像工具链 / sudoers / `agent-sandbox/ccb-baseline/**`(存量容器需 remount)/ **自愈 TCB 与分类器 manifest 自身** / AGENTS/CLAUDE/changelog / symlink/gitlink/typechange / **未知路径或未知 manifest 版本**。

纪律:
- **禁 first-match,禁"未命中即普通 master"** —— 未知一律 manual。
- 同源:trusted canonical 放机器可读版本化 manifest `deploy/v5/selfheal-deploy-surfaces.json`;deployDriver **读合并前的 trusted manifest**(严格 schema 校验);playbook §4.1 对应表**由 manifest 生成**,测试锁定生成结果。
- cutover 时**冻结 manifest hash**;放行时 hash 漂移 → 重新分类 + 重新审批。
- 无法安全自动的面 → pending/manual + 明确告知 boss,**禁假报 deployed**。

## 4. P3:远端权威 = 不可变 candidate ref(禁部署前推 canonical)

### 4.1 锁交接协议(Codex B1 —— 必须先闭合,否则两个坏选项都错)

坏选项:①worker 在 merge 后才让脚本抢锁 → **人工 deploy 可在中间插入,先部署 candidate,自愈再部署一次**;②worker 预先抢锁再启动脚本 → 脚本重开同一 lock file 会**等自己持有的锁** → 900s 超时失败(`deploy-v5.sh` 在入口自行抢 `/var/lock/oc-v5-deploy.lock`)。

受支持的协议:

1. release worker **在任何 canonical mutation 之前**取得全局 deploy lock;
2. **锁内**重新检查:clean branch / local HEAD / origin HEAD / `deploy_state=stable` / 无 recovery marker / **P3 rollout 检查**(脚本现在是启动后才查 → 先 merge 再被拒会污染本地 canonical,**必须提到 merge 前**);
3. **锁内**执行 ff merge → candidate push/readback → deploy → 按面证明 → canonical push;
4. `deploy-v5.sh` **接受并严格验证 inherited lock FD**(不能用可伪造的 `LOCK_HELD=1` env);
5. canonical push 长期失败**不得无限占锁**:持久化 applied checkpoint + 拉熔断 + 释放锁供人工 rollback/recover。

### 4.2 候选流程

```
① (锁内)冻结并核对 local canonical HEAD == origin canonical HEAD
② ff merge 到本地 canonical
③ push 不可变候选 ref:refs/heads/selfheal/candidates/<repairId>-<sha12>
④ ls-remote 回读必须精确 == SHA;否则不部署
⑤ deploy(继承同一把锁 + 远端 production-mutation lease)
⑥ 按面证明通过后,写 durable checkpoint,再 fast-forward push canonical
⑦ ⑥ 网络失败只重试 push,绝不重跑 deploy
```
禁 force push。candidate ref 保留/GC:**`deploy_unknown` 永不自动删**;canonical 已推且事故已收口后才按保留期清理。

### 4.3 失败裁决:必须**按生效面**证明(Codex B3)

deploy 脚本一旦 spawn,非零退出/timeout/信号/post-deploy HEAD mismatch **都不能直接叫 `deploy_failed`**(可能已切生产)。而 `/version + deploy_state + recovery marker` **只能证明 master 面**,不足以证明 web/egress/runtime/platform/slot。**部署事实证明**须纳入冻结 deploy plan,逐面证明:

| 面 | 已部署的证明 |
|---|---|
| master/docs | `/version==sha` + active release `VERSION.json` + `deploy_state=stable` |
| web | 线上 `oc-build` == 目标 release 的 dist build |
| egress | unit active + 进程 cwd 指向目标 release + egress health/capability 通过 |
| runtime / platform | live tuple 的 release/bundle digest == candidate 构建产物 |
| A/B slot | active slot / active release 与目标一致 |

**任一 touched surface 无法证明已部署或已完整回滚 → 一律 `deploy_unknown`**(否则违反本 RFC 自己的"禁假报 deployed")。

### 4.4 durable checkpoint(Codex MAJOR1)

post-deploy / pre-canonical-push 之间必须有 **set-once** 的 `deploy_effect_applied` / `canonical_push_pending` receipt(含 SHA、plan/manifest hash、candidate ref、**按面证明结果**)。**只有存在该 receipt,恢复进程才允许"仅重试 push"**;否则必须 `deploy_unknown`,**绝不重跑 deploy**。

## 5. P4:release drill

- 迁移号:**先查生产 ledger 取下一个单调编号**(0157 已被 lossless_runtime_batches 占;实现期间 0160 又被 moonshot_kimi_k3 并行批占走 → 实际落号 0161/0162,再次验证"不得假定")。
- seed exact `selfheal.drill:release_v1`(常驻 `auto_repair=f`,`execution_class=tier2`)+ broker 分级白名单(release drill → context/report/verify/cutover;Tier1 拒)+ SKILL release 分支(append 唯一 repairId/UTC 行到 `docs/selfheal/RELEASE_DRILLS.md` → commit → verify → cutover → report progress 等放行)。
- drill 脚本 `--release`:翻 policy → 轮询 pending_release → **`--approve <repairId>` 二段人工确认**(走**真实 admin 身份** API,凭据从受限 stdin/fd 或既有安全会话;**禁**写脚本/env 文件,禁 operator bypass)→ 断言真部署 + `/version` 翻转 + repair 终态 + 归因。
- **condition 必须保持 firing**,直到同时确认:① `/version == candidate sha` ② deployed callback 已落库 ③ repair 已进 `verifying` —— 才写 false。提前翻 false 会让 probe 以 `source=probe` 抢先收口,演练归因失真。
- cooldown 精确豁免(同 transport drill,只认精确常量)。
- 清场断言:policy 恢复 `auto_repair=false` / 无活跃 release request+job / 无 deploy recovery-unknown fuse / 无用户通知副作用 / candidate ref + canonical ref + `/version` 关系可解释。
- **频率**:批1b 验收低峰真跑一次;**不做常态高频回归**(docs-only commit 仍会推进 canonical、重启 master、可能构建 runtime release)。仅在下列变更后触发:release outbox/worker、deployDriver/classifier、callback 状态机、push/ref 流程、deploy-v5 核心 lane、隧道或审批链。最多季度低峰人工监督一次。

## 6. 其他必办(Codex MAJOR)

- **verifier 分层不足**:现只有 lint/typecheck/gateway/web;对 commercial/storage/mcp-memory 改动不够 → 按 touched surface 追加对应测试(或走 `check:v5` 受控子集)。
- **human gate 是真信任锚**(verifier 自己承认候选可改测试脚本):admin 放行页必须展示 base/sha、changed files、**分类结果**、验证层结果、manual reasons —— 不能盲点一键。
- **全局熔断双侧执行**:SQLite 在**接收/claim 新 release 前本地阻断**(不等 callback 抵达 PG),PG 同时阻止 boss 再批准;人工 clear 走带审计的双侧收敛协议。熔断只拦 Tier2 新部署,**不拦人工 rollback/recover/abort**。
- **分类器 raw diff 语义**:不能沿用 `--name-only` 风格 → 以 **NUL 分隔 raw diff** 读 mode/status;删除看**旧路径**;rename/copy **同时分类新旧路径**(R/C 可直接 manual-only);拒绝 malformed path / symlink / gitlink / typechange。否则 **rename 可绕过 manual-only 路径规则**。
- **webhook 冻结字段必须本地权威复核**:`sha/baseSha/deployPlanHash/manifestHash` **不能只信 webhook payload** → 与个人版已有 **committed cutover/verification record** 核对,SHA 取自**本地 durable cutover 记录**,并由 deployDriver 用 trusted canonical manifest **再分类一次**(现有 broker 正是以 durable cutover SHA 为权威,批1b 不得回退)。
- callback outbox 按 release request **分代**,保证 `deploying` 先于终态。
- manual-required 候选的人工收口、singleflight 释放、timeout 规则。
- claimed 后**遗留 deploy 子进程**的识别与 systemd cgroup 杀进程保证。
- canonical/origin 在部署期间被其他 writer 推进:不 force、**不部署超出获批 SHA**。

MINOR:202 附 `releaseRequestId`/`Location`/当前状态;request/job/outbox 保留期 GC + admin 查询;`release_requested`/`deploy_unknown`/`manual_required` 告警事件与计数;文案区分"**代码已部署**"与"**事故已由 probe 验证恢复**"(deployed ≠ resolved)。

## 7. 上线序(建议)

1. v5:release request 表 + admin 202 异步化 + callback phase 扩展(dormant:无 release 请求即零行为)
2. 个人版:release job 表 + release worker + deployDriver 分类器(读 trusted manifest)+ candidate ref 流程
3. manifest `deploy/v5/selfheal-deploy-surfaces.json` 入仓 + playbook §4.1 由它生成 + 测试锁定
4. drill seed 迁移(查 ledger 取号)+ drill `--release` 模式
5. 低峰:release drill 真跑一次(docs-only commit)→ 全链实证
6. 之后 Tier2 才可视为"可用",且 `OC_SELFHEAL_AUTO_DEPLOY_TIER2` 仍保持 0(人工放行)
