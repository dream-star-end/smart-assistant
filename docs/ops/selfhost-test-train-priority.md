# Selfhost 列车优先的测试准入（P5）

`npm test` 在第一组测试前检查列车状态；`test:gateway`、web-react workspace 的
`test`（含根目录 `test:web-react`）和已有 commercial wrappers 都经 `test-mutex.sh`。
测试命令、断言、发布门列表保持原样。新增回归由 selfhost-gates CI 执行。

权威信号是个人版 `/var/lib/openclaude-v5-selfhost/lease.db` 和
`/run/openclaude-v5-selfhost/deploy.lock`，沿用 `OC_V5_LEASE_DB` /
`OC_V5_SELFHOST_DEPLOY_LOCK` 路径配置。只读 SQLite，不调用会初始化库的 `oc-lease status`。
开放列车（除 committed/failed 外，包括 planned 和 recovery_required）、granted lease、
被排他持有的 deploy.lock 都拒绝新测试，退出 75，提示先运行
`wait-for-trains.sh --self <会话名>`，收到 FREE 后重试。registered ride 只是排队意图，
本身不阻止测试。缺省路径确实不存在的普通开发机/CI 仍可测试；显式配置路径缺失、
数据库损坏/不可读或 schema 不匹配均拒绝（退出 2），`CI=true` 不会绕过检查。

正常准入只在“状态检查 → 尝试获取测试锁”期间持 deploy.lock 的短暂共享锁，
防止 worker/人工发车同时打开新列车。等待测试锁时每秒重查准入，最多仍为 1800 秒；
不持 deploy 共享锁等待，不用一个长时间休眠的 npm test 进程继续挡住列车 admission。
已获准的测试不打断，原有进程组清理、执行看门狗、退出码透传保持；列车等待旧测试自然结束。
因此本改动减少新测试插队造成的 admission 超时，并不保证已有测试或其它负载永不超时。

列车自己的 callback proof 也使用 `commercial-proof` mutex。放行必须同时证明：唯一
开放列车处于 building/cutover、数据库 executor_pid 位于调用者实际 `/proc` 父进程链、
执行器 fd 8 指向官方 deploy.lock 的同一 device/inode，且内核 fdinfo 记录该 fd 的
`FLOCK ADVISORY WRITE`。这也支持 worker 传下来的锁描述符。既不获取/解锁执行器的 fd，
也不信任 train-id、owner 或 HELD 环境标志；proof 仍须获取原 family mutex 并受看门狗保护。

`test-mutex.sh <family> '<command>' [args...]` 将参数原样作为 command 的 `$@`，例如
web-react 的 `vitest run "$@"` 保留文件和 filter 参数。`OC_TEST_MUTEX_LOCK_DIR` 仅用于
隔离 fixture 的测试锁目录，缺省仍是 `/var/lock`，不会绕过列车检查。

本批只提交个人版 draft PR，不发版、不登记 ride、不改商业树。须等当前 tip 列车 live 后，
由管家按 **P2 → P5 → P1** 安排合入。旧 worktree 的旧 wrapper 不会自动获得新规则，
需要后续同步已审提交；商业树工具另行 PR。
