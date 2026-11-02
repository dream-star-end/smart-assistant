# V5 个人版宿主内存采样与列车 cgroup 收口

## 状态和适用范围

本文对应当前代码与 fixture，不是上线或验收完成记录。**尚未上线**；运行策略变更、启用/更新采样 unit，以及在宿主创建真实 synthetic unit 验证 SIGKILL/子孙回收，仍待用户针对具体方案批准。代码提交与正式发布已有任务授权，须在这些运行态批准到位并通过既有门禁后执行。

仅适用于个人版发布宿主 **v5-dev：38.55.252.217，hostname 必须为 `v3-dev-sg`**。不适用于 Aurora、kl-mirror、商业生产、其他 GCP VM 或账号池。连接沿已批准的专用 SSH 密钥与主机密钥检查进行；不新增权限，不访问 Secret Manager 或其他凭据。

采样器不需要账号、登录态、数据库或上游 API。它不发网络请求、不改 cgroup、不暂停任务、不杀进程。本文中的部署/恢复设计不构成新的执行授权。

## 两个独立改动

### 列车退出后的 cgroup 兜底

`scripts/v5-lease-worker.sh` 继续用独立 transient service 启动 `oc-v5-lease-train-*.service`，不把长命列车塞回短命 worker oneshot 的 cgroup。其受控停止参数为：

| 属性 | 值 |
| --- | --- |
| `KillMode` | `mixed` |
| `ExitType` | `main` |
| `RemainAfterExit` | `no` |
| `SendSIGKILL` | `yes` |
| `FinalKillSignal` | `SIGKILL` |
| `TimeoutStopSec` | 原有 `35min`，保持不变 |

`mixed` 保留主 deploy 接收 TERM、执行现有 trap/收口的机会；**MainPID 退出，或停止超时触发最终清理时**，systemd 对该 unit 剩余 cgroup 成员实施最终 SIGKILL。它不是“F.prewarm 阶段结束就自动清场”：只要 MainPID 仍活着，不能声称被杀 supervisor 的全部后代已经由 systemd 收走。35 分钟是现有列车停止窗口，不是预热阶段的新增运行时限，也不能当作每次都要等待的固定时长。

主服务、egress 和故障恢复 survivor 使用独立 unit，必须留在该清理域外。不能按进程名、PPID=1 或历史 PID 表清理。此改动不改变列车内存/OOMPolicy 限制，不新增 `--allow-inflight` 授权，不替代已有预热 subreaper；非 systemd 的原 fallback 也不能作为此兜底已验收的证明。

### 独立常驻采样器

| 内容 | 固定位置 |
| --- | --- |
| release 内源程序 | `scripts/v5-selfhost-host-memory.py` |
| release 内 unit 模板 | `deploy/v5-selfhost/openclaude-v5-selfhost-host-memory.service` |
| 独立安装程序 | `/opt/openclaude/v5-selfhost-breakglass/host-memory/sampler.py` |
| 安装 unit | `/etc/systemd/system/openclaude-v5-selfhost-host-memory.service` |
| JSONL 日志 | `/var/log/openclaude-v5-selfhost/host-memory/` |
| 操作回执与首次 snapshot | `/var/lib/openclaude-v5-selfhost/host-memory-install/` |

程序复制到独立 stable path，不依赖之后的 live symlink 指向；应用回退到旧 release 不会自然撤销它。采样器的 `MemoryMax=64M`、`CPUQuota=2%`、`TasksMax=16`只约束采样器自身，不是 train、浏览器或宿主的内存限额。

## 数据、节奏与观测局限

正常目标间隔为 **10 秒**；已知有精确匹配 `oc-v5-lease-train-*.service` 的 cgroup 时为 **1 秒**。每条记录都新读主机内存/PSI、system/user及已知train指标与身份，并轻量检查固定`/system.slice`中的精确train名称。完整slice发现每 **10 秒**一轮；进程top快照每 **60 秒**一轮，不再每秒遍历全机进程。扫描和写入耗时会占用间隔，不能当成硬实时承诺。记录包含 UTC、monotonic、boot ID、采样耗时与采集CPU秒数。

- 主机：白名单 `/proc/meminfo`、`/proc/vmstat`、memory/cpu/io PSI。`meminfo_kib`保留 KiB；vmstat 保留内核原生计数；PSI `total`是累计微秒。
- cgroup：root、system.slice、user.slice及观测到的 train。包含 memory current/peak、限制值、events/events.local、swap、pids、memory PSI 和白名单 `memory.stat`。cgroup v2根节点可能正常缺少memory.current/high/max/events及pids等接口；必须留unknown并记录文件缺失，不能为了零error填零。system.slice/user.slice/train的实际可用接口须分别验收。
- `memory.stat` 的 `anon`、`file`、`kernel`、`slab_*`、active/inactive 等是当前量，不能当作累计故障数或把下降当“计数重置”。只有 `MEMORY_STAT_COUNTERS` 白名单中的 paging/workingset 等计数（如 `pgfault`、`pgmajfault`、`pgscan`、`pgsteal`、`workingset_refault_*`）计算增量；完整分类以程序常量为准。
- 累计事件与计数按 boot、cgroup设备/inode及指标身份分隔。首次、缺失、权限失败、身份变化和计数回退均不伪造零增量；检查 reset/错误字段。`memory.peak`是峰值，不是限额或当前 RSS；不同 cgroup 与 RSS 不能无条件求和。
- 进程每轮默认最多扫描 **512个PID**，先单读stat选出候选top16，再只对选中者读cgroup并复读stat校验身份；不能因为进程复用把两种身份的数据拼在一起。最多输出16份 PID、PPID、start_ticks、comm、RSS 和 cgroup。**不读 `cmdline`、`environ`、会话内容或用户文件**。

扫描有目录、train数量、进程数、读取字节和时间预算；单条输出也有大小限制。`current_scan_complete`只描述本次实际执行的有界扫描，缓存记录不把它标成当前完整，**`history_complete=false`**。没有发现 train 不代表没有列车运行过，也不能证明采样间隙没有 OOM、内存尖峰或短命进程。top16来自该次成功读到的进程集合，扫描截断或身份校验失败时不保证是全机真实top16。

### 缓存新鲜度与CPU预算

`process_discovery`和`train_discovery`带`captured_utc`、`captured_monotonic`、`age_seconds`、`scan_performed`、`refreshed`、`cached`、`last_scan_complete`及`expired`。未在本条重新扫描的`pids_scanned`/`directories_scanned`为null，旧数量在`last_scan_*`；不能把缓存RSS和本条UTC拼成“当前进程内存”。

- 进程快照60秒刷新，超过 **120秒**仍无法有效刷新时`top_processes=null`，不是零进程。部分扫描保留其不完整标记，boot变化或monotonic回退清缓存。
- 完整train发现10秒刷新，超过 **30秒**无有效快照时`observed_units=null`。`quick_scan`仅表示本次固定`/system.slice`观察；其他slice里的新train可能延迟到下一次完整发现，最多还受扫描失败/截断和调度间隔影响，不保证10秒内必定发现。
- `known_units`保留已经识别的对象，即使完整发现失败或过期，仍逐条读其当前指标/身份。权限或整个cgroup层级不可用时标unknown并保留；只有层级可观察且对象确定消失才记录`observation=missing`墓碑并移出已知集合。未知不伪装成消失或零值。

unit仍为 **CPUQuota=2%**，约每墙钟秒20ms CPU额度；不提高限额，也不新增自动节流控制器。静态设计把昂贵工作摊到10秒/60秒：目标为core+quick约14ms/秒以内，完整发现约20ms/10秒，进程快照约180ms/60秒；这些只是待实测的预算，不是已达标承诺。`sample_cpu_seconds`仅是采集函数CPU观测，不含后续序列化和日志写入；它不调整策略、不发信号、不控制其他任务。验收须覆盖冷启动和稳态，结合真实unit CPU时间、throttling、采样时间差及扫描freshness，确认总开销与快采延迟；单次`--once`或Mac fixture不能证明2%配额下持续1秒采样成立。

当前优化版的真实Linux只读profile测得首样本约101ms CPU、常规热帧约5–11ms、偶发约65–72ms；逐文件归因显示尖峰分散在meminfo、vmstat及不同阶段，不能归因于memory.stat单项。该测量不是正式受限unit验收：1秒仍是soft目标，2%配额与宿主抖动会造成延迟，实际持续时效须获批后在真实受限unit中验证，目前不声称1秒已达标。

### 只记录 flags，不控制任务

| flag 条件 | 持续观察时间 |
| --- | --- |
| MemAvailable低于15% **或** 2 GiB | 30 秒 |
| MemAvailable低于8% **或** 1 GiB | 10 秒 |
| memory PSI `some.avg10 >= 10%` | 30 秒 |
| memory PSI `full.avg10 >= 2%` | 15 秒 |

计时采用连续有效样本与 monotonic；缺失读数中断该观察，未知值不解释为零。PSI的avg10本身是内核滚动平均，不是独立瞬时值。这些flags仅表示已观察到的条件；不能证明样本之间连续压力的完整历史，不能代替归因，也不会发送告警、自动回收、改变阈值或阻止发车。

## 日志与 unit 保护

- 自有目录 `0700`，JSONL文件 `0600`；拒绝目录和日志 symlink，不读取或写入其指向的文件。
- 单条默认最多 **64 KiB**，超大记录替换为小型错误标记，不带原始payload；单文件最多 **8 MiB**。
- **7天**与**512 MiB**总量限制同时执行，总量包含活动文件。只轮转/删除严格匹配自有命名的日志，不清理其他目录或无关文件。磁盘异常、权限错误与采集异常不能当成正常零值。
- unit以`root` UID运行，但`CapabilityBoundingSet=`和`AmbientCapabilities=`为空，`NoNewPrivileges=yes`；不提供账户或令牌。
- `PrivateNetwork=yes`、`RestrictAddressFamilies=AF_UNIX`，程序本身没有网络功能。
- `/proc`和`/sys/fs/cgroup`为只读采集面；`ProtectSystem=strict`、`ProtectHome=yes`、`ProtectControlGroups=yes`及内核保护开启，只允许日志路径写入。`PrivateDevices=yes`。
- `Restart=on-failure`、5秒重启间隔及启动/日志限速是采样器自己的约束，不能说明业务或采样数据持续可用；stderr仅输出错误类型/指标，不输出命令结果或秘密值。

## 正式接入流程

正式路径是现有 release-policy owner 的 finalizer，不是独立运维 shell：

1. 先取得明确的个人版发布/采样器启用授权，封定审核通过的候选SHA、CI、准确主机、回退范围和本次官方操作ID。
2. 使用官方列车、原部署进程持有的锁、租约、fencing及intent barrier；不能另起控制器竞争，不清 barrier、不以环境变量或命令行标志代替owner。
3. `release_policy_original_finalizer()`在应用进入committed、原有survivor/boot/watch步骤成功且watch核定相同后，才对包含采样器的新候选调用`host_memory_sampler_finalize()`。旧候选没有collector时保持旧行为。
4. policy lane内由原部署进程启动private stdio adapter；每次`OWNER_CHECK`均由这个原进程重新执行现有`release_policy_require_owner`。只有精确`OWNER_OK`才能继续；EOF、超时、拒绝或协议异常不制造授权。
5. `Installer.apply()`只接收**当前真实selfhost live release**的已审核程序与unit。它核验源、现状、drop-ins及回执，先持久化本操作首次snapshot和operation receipt，再原子替换文件、daemon-reload、enable/restart并核验active/enabled。文件替换与服务操作合起来不是一个事务。
6. 同一`operation_id`重试必须使用相同来源及hash，复用首次snapshot，不把部分安装后的状态重新保存成“原状态”。receipt中的operation ID只是绑定身份，不是授权；状态或文件与expected不符时停止，不能换一个ID掩盖未知结果。

不要手工运行apply、import后自行调用API、构造恒真owner回调、向adapter预喂`OWNER_OK`，或把CLI的fixture callback当正式owner。安装器默认CLI仅为只读plan；`--apply`/`--rollback`在无正式callback时拒绝写入。plan成功也不代表获准部署或已验收。

### 终态解释

| 返回/记录 | 应如何解释 |
| --- | --- |
| hook成功且回执可核 | 安装流程完成；仍须核对采样日志、权限和真实运行限制，不能仅凭RESULT宣布OOM问题根治 |
| 普通失败 `79` | 此finalizer阶段应用可能已经committed；**sampler未accepted**，按现有policy保持受控失败/hold，不能冒称整个应用已回退，也不能把旧collector仍在跑当新安装成功 |
| owner失权 `86` | 原owner已不再有权继续；原样上抛，不转换成普通失败后继续写hold/补偿，不竞争租约或人工清barrier |
| `RecoveryRequired`或结果未知 | 保存原snapshot/回执，先只读确认服务job、文件和enable/active状态，由正式owner恢复路径处理，不盲目重复systemctl或覆盖expected |
| 显式sampler restore核验成功后 `79` | 仅独立sampler已恢复；原lease以failed收口且原应用hold/intent仍保留，不代表应用重新验收、OOM完成或允许继续forward |

安装器会对可确认的普通失败尝试在仍有owner时恢复原文件/状态；服务调用超时或结果不明时不假称恢复成功。`applied`回执、应用committed和任务“OOM验收完成”是不同层次。

## 批准后的验收清单

以下是验收设计，不是已执行记录。只读核验也应在批准的目标和范围内进行，记录UTC、候选SHA、实际unit、source/stable程序hash、operation ID与snapshot路径。

1. 核对hostname为`v3-dev-sg`、当前live完整release及官方发布owner，确认未进入商业目标。核对实际worker/deploy调用链，不能只看canonical里有新代码。
2. 核对本次train实际unit的mixed/main/no/yes/SIGKILL及原35min参数；独立master/egress/survivor不在其cgroup。旧unit或已collect后的默认属性不能证明新策略已生效。
3. 在用户批准的真实Linux验收中，用独立synthetic unit和普通合成进程验证：主进程正常结束、supervisor自身SIGKILL、停止超时及detached后代的最终回收，记录成员、PID/starttime、退出码和cgroup状态；不借生产进程或真实用户会话作破坏性测试。Mac fixture或普通setsid测试不能替代这一步。
4. 核对独立采样unit为active/enabled、stable程序和unit对应获批来源；只取白名单unit属性，不全量打印Environment、ExecStart内可能存在的秘密或用户命令行。
5. 核对最小能力、private network、只读采集面和日志权限。检查连续JSONL、错误/未知指标、boot身份、计数增量、扫描完整性字段及采样耗时；精确train出现/消失时观察目标间隔1s/10s。
6. 用非敏感fixture验证rotation、单条/单文件/总量、7天保留、缺失/重置及symlink拒绝；不要为验证轮转制造宿主磁盘压力或修改系统时钟。flags用fixture验证，不能通过压垮宿主来触发。
7. 核对应用健康和正式发布终态，并分别记录“应用发布状态”“sampler安装回执”“采样验收”“cgroup回收验收”。旧版本、legacy成功、archive replay、存在旧日志或只读plan均不自动代表本任务完成。

## 回滚：应用与采样器分开

应用仍走官方个人版回退流程和当次封定的完整上一release。独立sampler的stable path、unit、enable/active状态和日志不随live symlink自动回退；不能把应用回退当成collector已撤销，也不能手删稳定文件或以临时systemctl命令代替受控恢复。

当前代码新增了同operation的正式sampler-only恢复接入；**尚未在宿主执行或验收**。它不是自由选择旧snapshot、撤销任意已完成操作或回退应用的入口。批准后由官方协调流程使用以下命令形态；尖括号是原操作记录中必须核实并替换的占位，不能原样执行：

```text
scripts/deploy-v5-selfhost.sh --deploy --resume-release-policy --restore-host-memory --lease-train=<原tr-ID> --target-sha=<原40位SHA>
```

只接受原operation尚未解除的barrier、精确原train/SHA，继续走官方resume claim、flock与fencing。已archived的操作被拒绝，不为其重造应用barrier。入口不接受调用者任意指定的snapshot路径；`snapshot_for_operation()`仅读原receipt并核对manifest身份，再由原owner stdio adapter的`restore`动作调用恢复原语。operation ID、resolver或恢复参数本身都不授予写权限；仍不能手工调用Installer或伪造owner响应。此resume没有dry-run模式，不应为“看看会怎样”而运行。

这条路径只探测目标与恢复采样器，不做应用phase/pointer写入、不走forward、不启动制品quiesce/prepare或切流。核验sampler恢复后会把原lease记为failed并返回79，保留原hold与intent；后续forward必须另有明确请求，不能因为看见`restored=true`就自动续发或宣称应用/OOM成功。

受控恢复步骤应满足：

1. 由当前官方流程选定并证明同operation合法owner；核对仍存在原unresolved barrier及原train/SHA，在同一正式锁、fencing及intent/recovery约束下操作，不能由另一会话竞争接管，不能重放archive来撤销已accepted的collector。
2. 绑定**原操作**的operation ID及首次snapshot，核验`operation-<sha256(operation_id)>.json`、snapshot manifest、来源hash、备份hash、当前expected files/state和无pending job。snapshot只允许来自固定state目录，不能接受任意路径。
3. 每次文件/服务写入前继续由原owner判定授权；未知服务结果先观察，不自动重发。prepared/applied/restored等终态要求精确匹配回执expected；中断的applying/restoring仅在显式恢复中允许原操作可证明的旧/新文件组合及稳定服务状态，不能覆盖第三方内容、mode变化或未决服务job。drop-ins或无法辨明的现场变化仍停止处理。
4. 用恢复原语还原原program/unit的**存在性、内容和mode**及先前enable/active状态。首次安装前不存在的文件应恢复为不存在；先前disabled/inactive不能被强行启用。masked/linked、已有failed或不稳定服务状态等需要单独审查，不强行“修正”。
5. 对服务先核现状，按恢复逻辑停止/禁用本次状态、恢复文件、daemon-reload，再只按snapshot原状态启用/启动并复核。恢复本身失败或不明，保留`RecoveryRequired`及snapshot，不写成成功。
6. 更新原operation receipt为restored；保留snapshot、manifest和JSONL供追溯，不删除日志。仅在本任务创建且仍为空时清理特定程序目录，不删别人新增文件。正式restore分支仍以79结束并保留原应用hold，后续明确forward请求是独立步骤。

多次更新可能有多份snapshot；“原样恢复”指所选原操作在**首次目标变更前**保存的状态，不能随手选最近一份或在失败重试时覆盖原快照。恢复结果必须与原操作回执核验一致。

## 实现索引

- `scripts/v5-selfhost-host-memory.py`：有界只读采样、flags、日志保留。
- `deploy/v5-selfhost/openclaude-v5-selfhost-host-memory.service`：独立采样unit与保护。
- `scripts/v5-lease-worker.sh`：train transient service停止策略。
- `scripts/lib/v5-selfhost-host-memory-install.py`：只读plan、受控apply/rollback、首次snapshot与operation receipt。
- `scripts/lib/v5-selfhost-host-memory-owner.py`、`v5-selfhost-host-memory.sh`：原owner stdio握手与hook。
- `scripts/lib/v5-selfhost-release-policy.sh`：原finalizer及intent barrier；`scripts/deploy-v5-selfhost.sh`加载hook。

代码测试、Linux fixture、正式发布和生产验收的实际执行记录需另行填写；本文没有声称任何服务已启用或真实cgroup实验已通过。
