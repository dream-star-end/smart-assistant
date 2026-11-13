# Selfhost P3 并行门：本地回归与后续 soak

状态：draft #1185，**DO NOT MERGE — 待真 Grok OD / 管家**。本文的本地重复测试不等于
生产列车 soak，不证明生产耗时目标；约 10 班真实列车观察仍待管家另行安排。
本任务只涉及个人版脚本/测试/文档，无 runtime image/toolchain 变更。

## 调度与失败边界

权威实现是 `scripts/lib/v5-selfhost-build-jobs.sh`；调用方是
`build_master_release()`。11 个非 Box C 门与 D 前端任务共用预算，后台 runtime 单独准入。

| 准入时读取的 load1 | 允许新任务的并发上限 |
| --- | --- |
| `<4` | 3 |
| `4<=load1<8` | 2 |
| `>=8`、不可读/非法，或预算计算失败 | 0，等待 |

每次启动前先收集已结束的任务，再重新采样负载。负载升高不会终止已准入的任务，
所以从 3 路降到 2 路时可以暂时仍有 3 个在跑；必须等活动数低于新上限才能再启动。
准入等待沿用 `MASTER_GATE_IDLE_TIMEOUT_S`（默认 900 秒），不是执行/排水超时。
超时或日志/TMPDIR 创建失败会锁定失败状态；已有任务照常排水，后续任务不能补发。
同一采样同时用于预算和 `job.<id>.load1`，避免准入值与证据不一致。

每个 worker 运行在独立进程组，其前台命令继承该组；每个任务有本次构建目录下的
独立 TMPDIR，继承的 deploy EXIT/ERR trap 在 worker 中清除。父进程先 wait worker，
再等待该组内所有非 zombie 成员退出。worker 返回非零或被信号终止，都会阻止 Box 与封存。
worker 返回 0 也必须等同组 surviving command 退出；这只能证明收尾，不能替代命令自己的
退出码汇总：**门命令必须等待其必需的子任务并传播失败，不得 fire-and-forget**。
`ps`/组成员解析失败按仍在运行处理；正常排水不发终止信号，也没有超时强行清理。

C/D 全部成功后才读取前端严格数据 receipt（不 source/eval），随后等待 runtime、执行现有
host-idle 检查、创建本班私有 DB，串行执行 Box success-recovery → continuation →
incident-proofs → 删 DB → ccb-mcp。保留 OCV5-557、15 条 C 命令、18-entry manifest、parity、
Box 重试白名单/loadScale/断言，不能把本地 fixture 绿当成这些真实门通过。

### 明确未覆盖的边界

- 父进程 SIGKILL/宿主崩溃不会执行 EXIT，内存中的 PID/PGID 登记随之丢失。
  现有 stale TMPDIR sweep 按父 PID 是否存在判断，不证明其后代已退出；
  **禁止由本测试推导“父进程被强杀后，下一班清扫也安全”**。
- 子命令主动 `setsid`、改变进程组或关闭继承的锁 FD，超出现有进程组屏障保证。
  不应给并行门引入这类行为；若确有需求，先另做持久归属/隔离与恢复设计并回归。
- 僵尸进程不能写文件，不要求等待它们被非本父进程 reap。活进程不退出或组探测长期失败，
  排水会继续等待；不能为了完成 soak 而清 TMPDIR、释放列车或杀其它会话。

这些边界是后续异常恢复验收的开放项，不以本地重复次数冲抵，也不能宣称已根治。

## 本地/CI 验证

使用现有任务树和依赖，先记录 `git status -sb`、`git rev-parse HEAD`；无需新建 worktree 或装依赖。
共享宿主上，任何共享锁/重测试前必须执行协调脚本并等 FREE：

```bash
"$H/wait-for-trains.sh" --self train-p3
```

下面的调度测试只启动隔离 shell、伪 gate、私有临时文件/锁；不执行真实发布、Box/DB 门、
构建或访问线上。信号仅发给 fixture 自建 PID。CI 的 `release-gate-parity` job 已接入同一
scheduler/cache 命令（CI 用 sudo 与封存证据的 root 权限一致）。本机应在既有 root 开发环境跑，
seal/cache 用例跳过即不算通过；商业版/gateway/web-react 全量留给 CI，不在此做本地并发压测。

```bash
node --test scripts/__tests__/v5SelfhostParallelGates.node-test.mjs \
  scripts/__tests__/v5SelfhostDeploySpeed.node-test.mjs
npx --no-install tsx --test scripts/__tests__/checkReleaseGateParity.test.ts \
  scripts/__tests__/v5SelfhostGateTsxCache.test.ts
bash scripts/v5-selfhost-train-summary.test.sh
npm run typecheck
bash scripts/check-biome-changed.sh --base f55a871a4
bash -n scripts/lib/v5-selfhost-build-jobs.sh
npx --no-install tsx scripts/check-release-gate-parity.ts
npx --no-install tsx scripts/check-v5-incident-regressions.ts --edition=selfhost
bash scripts/check-v5-fix-trailers.sh --repo . --head "$(git rev-parse HEAD)"
```

若另跑 `v5SelfhostBoxGateFlaky.test.ts`，它包含需要 `TEST_DATABASE_URL` 的真实 DB 用例；
本地未提供 DSN 时该条会 skip，必须单列为未执行，由 CI 数据库环境覆盖，不能计入零 skip
的本地 soak 结论。不要为了凑数临时连接生产或共享数据库。

提交后再跑 exact-head trailer 门；记录每条命令的退出码。fixture 中的伪门用于验证调度，
不能代替 parity、事故契约或 CI 真实门。新增用例覆盖：

- 准入时准确负载采样、3→2→0→3 变化，不终止已运行任务；不可验证预算 fail-closed；
- 日志/TMPDIR 初始化失败锁定后续准入，等待已有任务完成；
- 并发任务写同名临时文件仍各自读回自己的数据；
- worker TERM、正常退出但同组命令仍存活、瞬时 `ps` 失败，以及调用方 monitor mode 复原；
- 任一 C/D 失败阻止 Box/封存；全 15 C + D 按 pinned staging 执行，Box 与 runtime/C/D 隔离。

### 串行重复 fixture（本地 soak）

例如 5 轮，每轮都是新进程/临时目录；不把多个整套测试再并发起来。完整 TAP 留在独立证据目录，
任一非零/skip/失败立即停止。该目录仅包含本地证据，不是列车日志或发布目录。

```bash
set -euo pipefail
p3_evidence="$(mktemp -d "${TMPDIR:-/tmp}/p3-local-soak.XXXXXX")"
git rev-parse HEAD >"$p3_evidence/commit.txt"
git diff --stat >"$p3_evidence/working-diff.txt"
printf 'Evidence: %s\n' "$p3_evidence"
for p3_round in 1 2 3 4 5; do
  p3_log="$p3_evidence/round-$p3_round.tap"
  if ! node --test scripts/__tests__/v5SelfhostParallelGates.node-test.mjs >"$p3_log" 2>&1; then
    cat "$p3_log"
    exit 1
  fi
  grep -qx '# fail 0' "$p3_log"
  grep -qx '# skipped 0' "$p3_log"
  grep -qx '# cancelled 0' "$p3_log"
  tail -8 "$p3_log"
done
```

对未提交改动的测试，须另存 `git diff` 并明确“工作树证据”；最终证据须绑定提交 SHA。
报告格式如 `local-fixture=5/5, tests=<实际计数>, skipped=0, production-soak=NOT_RUN`。
不把重复轮次称为 trains，不给出生产加速百分比。

## 排水/限流取证

父进程日志会显示任务启动和最终 `rc/elapsed/log`；需要等同组命令时会额外打印一次
`worker rc=...; 等待存活命令/进程组探测恢复(pgid=...,TMPDIR 保留)`。
默认日志在 train summary 目录（通常 `/opt/openclaude/tmp/lease-trains`）；手工无 train ID 时
attempt log 在 `/opt/openclaude/tmp/box-gate-attempts`，也可能被显式目录覆盖。

| 证据 | 含义 |
| --- | --- |
| `job.<id>.load1 / slots / admissionWaitSec` | 该次准入采样、上限、等待秒数 |
| `job.<id>.admissionFailure` | 未启动原因：`admission-timeout`、`log-setup`、`tmpdir-setup` |
| `job.<id>.pgid / tmpdir / log` | 本次已准入任务的组、临时目录和持久日志 |
| `job.<id>.workerRc / drainSec / rc` | worker wait 状态、之后的排水秒数、含读日志失败的最终结果 |
| `job.<id>.elapsedSec` | 启动到组排水完成的总时间，不含准入等待 |
| `C.parallel`、`frontendElapsedSec`、frontend mode | 重叠墙钟阶段、D 实际耗时、built/reused |

`tsum_note` 先缓存在父进程，下一次 phase mark/finish 才写 summary；挂在排水时不能要求这些
字段已全部落盘。`slots` 是上限而非实际并发数，`drainSec=0` 也可能发生过亚秒排水；
未启动任务没有 PGID/退出码是正常的。summary 值会清洗/截断，原始路径与现场以完整日志为准。

只读取证时，从本班日志取父 PID/PGID、完整 TMPDIR，再观察：

```bash
ps -eo pid=,ppid=,pgid=,stat=,etimes=,args=
cat /proc/loadavg
```

核对同组非 zombie 成员是否仍在工作、attempt log 是否更新、是否存在探测错误。
PGID 是本次进程归属记录，历史数字可能被复用，**不是事后发信号或接管的授权**。
若发现排水卡住、TMPDIR 提前消失、Box 与 C/D 重叠或未知退出状态，保留日志并暂停验收；
不得运行 pkill、按命令名清场、手工清 marker/锁/TMPDIR，也不能扩大重试白名单掩盖失败。

## 后续真实列车观察（本会话不执行）

只有真 Grok OD/管家批准并安排窗口后，才可观察约 10 班真实 selfhost trains。
先等当前 tip live，由管家控制 P2→P5→P1 合入顺序；本分支仍为 draft + DO NOT MERGE。
观察不授权发车、merge、ride、故障注入或生产写操作。

每班保留 train ID、exact source SHA、CI/review 链接、完整 train/attempt logs、final summary、
cache mode、准入负载与 host context。核对所有门成功、失败不封存、C/D 与 runtime 都在 Box
前收尾、Box 串行、私有 DB/TMPDIR 无跨班互踩。比较耗时必须区分 cache hit/miss、负载和等待，
不能把重叠任务耗时相加当墙钟。任一异常保留失败班证据，不以重试后的成功替换。
缺失班次、summary 非 final、日志不完整、或上述未覆盖的崩溃/脱组场景，都应记未验证，
交持有实际归属/锁的 owner 按正式流程处置，不能用本地 fixture 结果补写“生产 soak 通过”。
