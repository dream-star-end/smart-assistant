# RFC: 同机双 master 蓝绿交接 + 按用户 cohort 分批切流（P3）

状态:**设计审 PASS**(Codex 4 轮:R1 状态机收敛→R2 恢复矩阵/资产/lease loss→R3 epoch 化→R4 安装顺序→PASS;实现审计重点=旧 epoch 迟到 ACK 与等待 fence 时 desired 反转两类竞态)
分支:feat/v5-p3-cohort
日期:2026-07-12
前置:P2(会话权威 PG)已上线;两轮架构测绘完成
R1 核心裁决(全盘采纳):**流量角色/18894 所有者/leader 所有者/systemd slot 必须收敛到同一个 PG 部署状态机**,禁止三个独立竞态"通常一致"。

## 1. 目标

部署升级从"单实例硬重启(11s 真空+全员 4509)"升级为:新旧 master 并存,按用户 cohort 分批切流,秒级回退,用户零感知。

## 2. 测绘确认的地基(不需要新机制)

- 会话续传跨实例透明:bridge=master dial 容器,与用户 WS 同进程结构性恒等(userChatBridge.ts:901/1226);容器 clientsByPeer 多 bridge 并发,outbound 按 peerKey 广播;resume 权威=容器 ring+客户端游标。
- 会话正文/计费权威在 PG(P2,双 master 同毫秒双写安全);turn 流不经 egress;容器 provision 跨进程安全(0089 唯一索引)。
- v5-owned 调度器 6/8 安全双跑(SKIP LOCKED/per-account advisory/收敛写);需交接的=shared 域全部+orphanReconcile+wecomAibot/wecomAlert+cronWake。
- **静态资产:共享加法式 /assets 池 + slot 专属根文件(R2 B2 修正)**:共享整个 webDistDir 会让 candidate 的 index.html 覆盖 active=前端全量发布,破坏 cohort。定稿布局:①`/assets/<content-hash>` 共享加法式资产池(Caddy 直接服务 /assets/*,双 slot 构建产物并集,GC 保护双在役 release+回滚代+浏览器谱系≥14 天)②index.html/manifest 等**可变根文件 per-slot**——candidate 用户拿 candidate 前端,active 用户拿 active 前端,懒加载 chunk 跨 lane/abort 后仍可得(池是并集)。③**Service Worker 例外(R3 M2)**:sw.js scope=/ 且 skipWaiting+clientsClaim=origin-global,**无法 per-slot 隔离**——定性为 release-neutral 平台资产:--canary preflight 强制断言 active/candidate 的 sw.js **字节一致**,SW 行为变更单独走协调全量发布(不随 cohort 灰度);generation-aware 统一 SW 登记为长期增强。

## 3. 部署状态机(R1 B1/B2/B3/M2 的统一答案)

PG 表 `deploy_state`(singleton,0135 迁移):

```
generation      BIGINT      -- rollout 代次(单调;cookie/salt 编码用)
phase           TEXT        -- stable|canary|finalizing|aborting  CHECK
active_slot     TEXT        -- 'A'|'B'(当前主:默认流量+VIP 控制口+leader 归属)
candidate_slot  TEXT        -- 灰度中的 slot(NULL=无)
active_release  TEXT        -- rel-* 目录名(权威记录,Caddy 生成器/回滚以此为源)
candidate_release TEXT
desired_leader_slot  TEXT   -- leader lease 竞争资格(唯一授权 slot)
desired_control_slot TEXT   -- VIP 控制口 18894 bind 资格(唯一授权 slot)
cohort_percent  SMALLINT CHECK(cohort_percent BETWEEN 0 AND 100)
cohort_salt     TEXT        -- per-rollout 固定(R1 m1:同 rollout 内 5%⊂20%⊂50%;新 rollout 才换)
cohort_allowlist BIGINT[]
lock_version    BIGINT      -- 一切转移 CAS(WHERE lock_version=$n),脚本崩溃后按 phase 幂等恢复
updated_at      TIMESTAMPTZ  -- 展示用;并发权威=lock_version/generation(R2 MINOR)
```

字段补充(R2 B1):`transition_step SMALLINT`(当前 phase 内已完成的最后一步,每个外部效果——Caddy reload/unit start|stop/drain——完成后立即 CAS 推进)+`operation_id TEXT`(本次操作唯一 id,journal 表 deploy_state_journal 记录每步{operation_id, step, action, at},审计+崩溃诊断)。

**四个角色面全部由它派生**:Caddy 生成器读 active_slot/candidate_slot/generation/phase/transition_step 产出配置;master 运行时按 desired_* 决定 lease/VIP 资格;deploy 脚本**每个操作起手先 CAS phase**(stable→canary、canary→finalizing、canary|finalizing→aborting),每步外部效果完成即 CAS transition_step——崩溃后重跑读 (phase, transition_step) 从**恢复矩阵(§8)**唯一确定续作方向。

slot=A/B 静态映射:A={unit openclaude-v5, port 18790, 私有控制口 18896, HOME /root/.openclaude-v5};B={openclaude-v5-b, 18795, 18897, /root/.openclaude-v5-b}。

## 4. 设计

### D1 cohort 路由(R1 B4 修订)
- **cookie 值编码代次与 slot**:`oc_v5lane=g<generation>.<slot>`(如 g42.B)。Caddy matcher 只匹配**当前 generation** 的 candidate 值;陈旧 cookie(上一代 g41.B)不命中任何 matcher → 自动落 active slot。休眠浏览器旧 cookie 永不误路由(R1 B4)。
- **下发点统一三处**:login response/refresh/`/api/me` 共用同一 `evaluateLane(uid)`(读 deploy_state:allowlist ∪ lane_hash(uid,salt)<percent;**lane_hash 钉死单一实现**:sha256(salt+':'+uid) 前 8 hex 转 uint32 无符号 mod 100,TS/SQL/脚本共用同一定义,穷举测试三处一致),下发/清除 cookie 并在响应体带 `lane` 字段。前端 authStore 持 lane;**socket connect 前置 laneReady gate**(login/恢复流程拿到 lane 决策后才建 WS,防首连落错 slot 再被 cookie 纠正的抖动)。
- **promote 生效速度诚实语义**:改 percent 只改 PG;在线用户在下一次 /api/me(页面加载/定期 session 校验)重评。"N%"=活跃评估者的 N%,对分批灰度足够;主动 kick(bridge 下发 sys.lane_changed→前端安全点重连)登记为增强项,不阻塞 P3。**放量观测(R2/R3)**:admin 暴露 lane_evaluations{generation,slot,count}(请求次计数)+unique-user 口径 lane_users{generation,slot,distinct uid 计数,(generation,uid) 去重},operator 由此判断 N% 已覆盖多少活跃用户;前端 session 校验周期=现行 /api/me 调用节奏(页面加载+token 刷新),RFC 不新增轮询。
- **cookie 非安全边界(R1 m2)**:任何人可手工构造 cookie 命中 candidate → candidate 必须按"可被任意生产用户访问"运维(它本来就是生产 release+生产 env;allowlist 只是流量选择)。RFC 显式声明。
- **Caddy fallback 语义(R1 M1,写到可验证)**:candidate upstream 配 active health(`health_uri /healthz` interval 3s timeout 2s 期待 200)+passive(max_fails 2, fail_duration 10s);`lb_policy first` 顺序=[candidate, active]。**fallback 只发生在连接建立失败/健康摘除**——Caddy reverse_proxy 默认不重放已发送 body 的请求,非幂等 POST 不盲重放(显式不配 retry);WS handshake 失败允许落 active(浏览器重连语义兜底)。abort 顺序=**先 reload Caddy 摘 candidate matcher → 再停 candidate**(存量 WS 收 4509 重连,此时路由已只剩 active)。**failback 语义定稿(R2 M1)**:接受自动 failback——candidate 恢复健康后 lb_policy first 重新优先 candidate(它是灰度中的同一 release,恢复即继续灰度,与 phase 语义一致);持续不稳定由 operator --abort 裁决。WS/请求重试显式配置:仅连接建立失败(未发送 body)允许尝试下一 upstream(lb_try_duration 2s),POST body 已发送不重放。

### D2 slot 实例形态
- B slot unit `openclaude-v5-b.service`:独立 HOME(openclaude.json port=18795;副产物 sessions.db/uploads 独立)、同 env 文件+drop-in(OC_SLOT=B 等)、WorkingDirectory=/opt/openclaude/openclaude-v5-b(独立 symlink→rel-*)。
- **P2 权威 manifest 共享读**:`OC_SESSIONS_MANIFEST_PATH` env 覆盖(storage/authority 小改),两 slot 指同一 /root/.openclaude-v5/sessions-store-authority.json(写方唯一=割接工具,双进程只读安全)。
- webDistDir=per-slot 根文件目录+共享 /assets 池(布局见 §2;R2 B2)。

### D3 控制口:VIP + 私有双 listener(R1 B3 修订)
- **每 slot 常驻私有诊断控制口**(A=18896/B=18897,同一 dispatcher,healthz/smoke/运维直达本 slot)。
- **VIP=127.0.0.1:18894**(egress 唯一目标,零改动):仅 `desired_control_slot` 匹配的实例尝试 bind;retry-bind **只对 EADDRINUSE 重试**(2s 间隔),权限错误/非法地址/handler 初始化失败 fail-loud 拒起。运行时监听 deploy_state 变更(轮询 5s):desired 不再是本 slot → 主动 close VIP listener(优雅:in-flight 完成)。
- **广播退化完整清单(R1 M3)**:VIP 真空/异 slot 窗口内,cost_charged/cost_waived/codex 与 image charge 等**全部进程内 user broadcast** 对"用户 WS 在另一 slot"的场景不实时;PG 权威(扣费/退款/正文)不受影响,refresh/resume 可见。终态方案(Redis pub/sub fanout 双 master)登记为增强,P3 不做。
- **cost 队列诚实边界(R1 B3)**:egress costEventSink 队列 TTL 120s/上限 2000/进程重启即失/重试无 event-id 去重——"积压排空"只是有界正常路径。finalize 的 VIP 交接窗必须<TTL(设计目标:停旧→新 bind<10s),且 finalize 门槛=①VIP owner 探测(私有口自检报告"我持有 VIP")②只读 `/internal/v5/control-probe`(带 egress secret;自检 dispatcher 路由表+PG 连通+身份组件+"本实例持有 VIP"断言;R2 M2:不打写接口——写链验证仅预发演练用测试租户+唯一 operation_id+事务清理)③egress /healthz pendingCostEvents==0 ④**egress health 单调计数差分(R2 M4+R3 M3)**:暴露 processStartId(systemd invocation id)/pendingCostEvents/enqueuedTotal/sentTotal/expiredDropsTotal/overflowDropsTotal/oldestPendingAgeMs;**finalize 起手前置=pendingCostEvents==0**(有 backlog 先等排空再开始,防基线污染);门槛=**startId 未变** ∧ pendingEnd=0 ∧ enqueuedDelta==sentDelta ∧ expired/overflow delta=0——egress 中途重启(计数归零假绿)被 startId 变化拦截,进补偿/人工核对。任一超时(60s)→**补偿动作**:回滚 desired_control_slot=旧 slot、重启旧 unit、phase=aborting,绝不带病宣告 stable。

### D4 LeaderBundle + lease 生命周期(R1 B1 修订)
- **LeaderBundle**:把全部全局单例职责收口为一个可幂等 start()/stopAndDrain() 的 bundle——shared 域全部调度器+orphanReconcile+wecomAibot/wecomAlert+cronWake(改造:这四个从各自 gate 迁入 bundle)。stopAndDrain=停止接纳新 tick→在飞 tick 有界等待(30s)→逐个 stop。composition root 只构造 bundle,不再散装启动。
- **lease controller**(独立模块,复用 P2 专用连接纪律):
  - 资格=`OC_CONTROL_PLANE_LEADER`(=0 硬 kill-switch,保语义兼容)∧ `deploy_state.desired_leader_slot == 本 slot`。**资格不满足不竞锁**——systemd Restart=on-failure 拉起的旧 slot 因 desired 不匹配无资格,不会抢回(R1 B1 kill -9 场景)。
  - 竞得后**二次确认 desired 仍匹配**才 start bundle;heartbeat(10s)+连接 error/end→**立即 fence:stopAndDrain bundle**→重建连接→资格仍在则重竞。
  - **lease loss 无双跑协议(R2 B3+R3 B1 epoch 化,消 ABA/陈旧 ACK)**:lease 状态行 `leader_lease{lease_epoch BIGINT, holder_slot, holder_instance_id UUID(进程启动随机), holder_pid, holder_pid_start_ticks(/proc/<pid>/stat starttime,防同 boot 内 PID 复用), fence_requested_epoch, fenced_ack_epoch}`。协议(R4 B1 安装顺序定稿——**fence-request 先行,ACK 之后才安装新 holder**,否则覆盖行会让旧 holder 的带 epoch 条件 ACK 永远落空):①新进程竞得 advisory lock②读取并冻结 predecessor {epoch, instance_id, pid, start_ticks}③**保留旧 holder 字段**,仅 CAS 写 fence_requested_epoch=predecessor_epoch④等待 `fenced_ack_epoch==predecessor_epoch` **或** predecessor 进程身份({pid,start_ticks,instance_id})确认已死(45s>drain 上限 30s;超时=fail-stop 告警人工裁决,绝不带重叠启动)⑤再次确认 desired_leader_slot 仍=自己(**等待期间 desired 变更→立即放弃并释放 advisory lock,不得安装**)⑥CAS 安装新 holder:`WHERE lease_epoch=predecessor_epoch AND holder_instance_id=predecessor_instance_id`,写 lease_epoch=predecessor_epoch+1+新身份+清空 request/ack 字段⑦才 start LeaderBundle。旧 holder ACK=`UPDATE ... SET fenced_ack_epoch=$heldEpoch WHERE holder_instance_id=self AND lease_epoch=$heldEpoch`(迟到上代 ACK 不污染新代)。graceful=drain→写本 epoch ACK→unlock,新 holder 拿锁即见 ACK,零等待零重叠。
  - graceful shutdown 顺序固定:标记退出(迟到的 acquire 不再 start)→stopAndDrain→unlock/销毁连接。
  - healthz 暴露 `leadership: {state: ineligible|standby|acquiring|leader|fenced, slot, generation, leasePid}`(R2:standby=有 env 资格但 desired 非本 slot;ineligible=env kill-switch)——env=1 不再等同 active leader(smoke 断言随之更新)。`OC_CONTROL_PLANE_LEADER` 真值表:严格 '0'|'1',unset 与非法值在 v5 生产=fail-closed 拒起(与 P2 开关纪律一致)。
- controlPlaneEnabled 静态布尔的消费面改造:启动期分支(auto-migrate 等一次性)保持读 env 资格;**调度器启动全部迁入 bundle**(这是主要工程量,测绘已确认 shared 域 18 个的注册点)。

### D5 deploy lane(全部经 deploy_state CAS)
- `--canary <release>`(R3 M1):**起手 CAS{phase=canary, transition_step=0, candidate_* 预留, operation_id}**——Caddy 生成器约定 transition_step<READY 步时**不生成 candidate matcher**(准备期对流量不可见);→build/选 release(step1)→初始化 candidate slot(HOME/openclaude.json/unit,step2)→起 candidate unit(自检:私有口 healthz、PG authority、leadership=standby、VIP 未 bind;step3)→**capability matrix preflight(R1 M7)**:release-metadata capabilities 校验(sessions-store-pg-v1+新增 bridge-frame-schema/runtime-api 版本键,candidate 与 active 的兼容矩阵:新 master↔旧容器/新 master↔旧前端/双 master↔同容器 bridge 帧;不兼容 fail)(step4)→CAS{generation+1, salt=新随机, percent=0, allowlist=内部账号, transition_step=READY}→re-render Caddy(此刻起生成 matcher)+reload(step5)→内部账号验证。恢复矩阵细化:canary 各 step 逐行进 §8(step<READY 崩溃=stop unit+只清本 operation 产物即回 stable,零流量影响;HOME 不删)。
- `--promote <pct>`:断言 phase=canary→CAS percent。观察面=双 slot healthz+错误日志 diff+计费一致性抽查。
- `--finalize`(R1 B2 七步序+R2 B1 步进持久化):**起手 CAS{phase=finalizing, transition_step=0, operation_id=新}**→①percent=100 观察窗(step=1)②Caddy 默认 upstream 切 candidate+reload,验证新请求全落 candidate(step=2)③旧 WS 自然存活或有界 drain(step=3)④CAS{desired_leader_slot=candidate, desired_control_slot=candidate}(step=4)→旧 master fence+close VIP;candidate 竞得 lease+bind VIP⑤D3 四门槛校验(step=5;超时→转 aborting 按 §8 恢复)⑥stop 旧 unit(step=6)⑦CAS{active_slot=candidate, active_release 更新, candidate_*=NULL, phase=stable, transition_step=0}。每步完成即 CAS transition_step+journal。
- `--abort`(R2 B1):**起手 CAS{phase=aborting, transition_step=0}**→**恢复前置(关键)**:若 finalize 已过 step6(旧 unit 已停)——先 `ensure 旧 unit running + 私有口健康 + capability 校验`,**旧 slot 确认健康后**才继续→①re-render Caddy 摘 candidate/恢复默认=旧 slot+reload②CAS{desired_*=active_slot}(旧 master 重竞 lease/VIP,等待其 leadership=leader+VIP owner 确认)③stop candidate unit④CAS{phase=stable, candidate_*=NULL, percent=0}。绝不在旧 slot 未确认健康时先切流(防全停)。cookie 靠 generation 不匹配自动失效。
- **finalize 后回滚(R1 B2)**:stable 后发现问题→正常再跑一轮 --canary(旧 release 为 candidate)——**回滚=对称的前滚**;紧急整流(不起第二实例)=deploy-v5.sh --rollback(蓝绿 symlink+restart,回到今天的 11s 语义,capability gate 照拦)。旧 release/unit 保留=蓝绿 GC 现行 6 代策略;DB migration 兼容边界=现行 backward-compatible 纪律+capability matrix。
- V5_PORT/smoke 参数化(按 slot);smoke 白名单语义确认"允许集非必现集"。

### D6 前端横幅延迟(R1 m3 细化)
- 断开>2s 才显示横幅;2s 内恢复零闪烁(计时器随重连成功取消,flap 场景旧 timer 必清);断线期间发送行为不变(现行=排队/禁发语义保持,不因横幅延迟而改);横幅延迟只作用于连接横幅,不掩盖 HTTP 请求错误 toast。

### D7 OAuth pending state(R1 M5)
- GitHub/LinuxDo OAuth pending state 从进程内 Map 迁 PG 短 TTL 表(0135 附带)——跨 slot callback 天然成立;abort/drain 不丢在飞绑定流程。表语义(R2 M3):state_key 存 **hash**(不存可直接使用的 bearer);消费=`DELETE ... WHERE state_hash=$1 AND expires_at>now() RETURNING payload` **原子单次**;unique+expiry index+GC;payload 含 verifier 等敏感字段用 OPENCLAUDE_KMS_KEY 加密;**保留现有 state-cookie/用户绑定双校验**(迁 PG 不弱化 CSRF)。

## 5. 上线自举(R1 M6)
P3 分两个 release:
1. **基建版**(传统 deploy,11s 语义最后一次):deploy_state 表+LeaderBundle+lease controller+VIP/私有双 listener+lane 评估与 cookie 下发+laneReady gate+OAuth state 迁移+Caddy 生成器状态机化——**默认行为完全兼容**(无 candidate 时:A slot=desired 一切,evaluateLane 恒 active,Caddy 无 canary matcher)。
2. 基建版稳定后,**下一 release 首次走 --canary**(自举验证)。

## 6. 明确不做
- egress cohort-aware/Redis 广播 fanout(徽章类短窗退化接受,增强项登记)。
- 账号池 inflight 分布式化(N×cap 债;切流窗内账号池水位监控告警兜底;常态双活前偿还)。
- promote 主动 kick(sys.lane_changed 增强项)。
- 多机分片。

## 8. 恢复矩阵(R2 B1,脚本崩溃后重跑的唯一裁决表;编号即 §8)

| phase | transition_step | 外部事实核验 | 恢复动作 |
|---|---|---|---|
| canary | <READY(准备期) | candidate 对流量不可见 | stop/disable candidate unit+**只清理本 operation_id 的 staging/临时文件/未激活 symlink(R4:HOME 是持久 slot 状态含 uploads/诊断数据,可能是上一轮 active 的家,绝不递归删)**→CAS 回 stable(零影响);或重跑续作 |
| canary | ≥READY | candidate unit 死? | 死→Caddy fallback 已兜底,重启 unit 或 --abort;活→继续 promote/finalize |
| finalizing | 0-1 | 默认流量仍在 active | 安全:继续 step2 或转 aborting(零损) |
| finalizing | 2-3 | 默认流量已在 candidate,desired 仍旧 | 继续 step4;或 aborting(Caddy 切回,旧 slot 仍健康) |
| finalizing | 4-5 | desired 已=candidate,VIP/lease 可能已交接 | 门槛校验通过→继续 step6;失败→aborting(desired 收回,等旧 master 重竞得) |
| finalizing | 6 | **旧 unit 已停** | 前滚优先:candidate 已全量服务→直接 step7 完成;candidate 异常→aborting 走"先起旧 unit 并核验健康"前置 |
| aborting | any | 旧 slot 健康? | 未确认→先恢复旧 unit;确认→按 abort ①→④ 幂等续作 |

## 7. 验收(含 R1 全部补充)
- lease:双进程竞锁/持有者 kill -9+systemd 自动重启(断言旧 slot 因 desired 不匹配不抢回)/pg_terminate_backend(lease pid)(旧 bundle fence、新实例接管、无双跑窗口重叠断言)/shutdown 与迟到 acquire 竞态。
- VIP:EADDRINUSE 重试→释放→接管;非 EADDRINUSE fail-loud;desired 变更主动 close;cost 队列近 TTL/上限/response 丢失重试;四门槛超时补偿路径。
- deploy 状态机:每个 CAS 转移点注入脚本崩溃→重跑幂等恢复;finalize 后立即回滚(对称前滚)→会话/runtime/dist/Caddy/leader/VIP 全部同 slot 断言。
- 路由:无 cookie 首请求/陈旧 generation cookie/新登录(login response 下发)/静默恢复/在线 promote 重评/laneReady gate 时序。
- WS/流程:abort 时在飞 turn(resume 续传)/空闲 WS/HTTP 上传中/OAuth callback 跨 slot/懒加载 chunk(共享 assets)。
- 预发全流程演练(kl-hk):canary→promote→finalize→abort 各路径+真 WS 用户跨 lane resume 无感实证(交付 WS turn 冒烟客户端,P1d 遗留)。
