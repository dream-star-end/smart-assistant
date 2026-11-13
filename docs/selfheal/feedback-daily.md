# 反馈日报

`scripts/v5-selfhost-feedback-daily.ts` 把个人版里已经记下的回合、工具、恢复、评分和摩擦收成计数，并附上可以执行的 trace 命令。只给管理和开发看。不进 master 进程，不发站内信，不开单，不写业务表。

## 跑法

```bash
cd /opt/openclaude/openclaude-v5-selfhost
node_modules/.bin/tsx scripts/v5-selfhost-feedback-daily.ts --dry-run
node_modules/.bin/tsx scripts/v5-selfhost-feedback-daily.ts
node_modules/.bin/tsx scripts/v5-selfhost-feedback-daily.ts --days 7 --date 2026-10-31
node_modules/.bin/tsx scripts/v5-selfhost-feedback-daily.ts --include-765 --dry-run
```

连接是本机 `sudo -n -u postgres psql -d openclaude_v5_selfhost`（Unix socket peer）。不读连接串，也不接受连接串参数。每段查询在 `BEGIN READ ONLY` 里，`statement_timeout` 20 秒，时区 `Asia/Shanghai`。分组查询带 `LIMIT`。

`--date` 是 CST 的截止日期。窗口是该日 23:59:59+08 往前 `--days` 天（默认 7）。同一日期重跑，结果相同。

正式跑写入 `/opt/openclaude/var/feedback-daily/<YYYY-MM-DD>.md` 和同名 `.json`，模式 `0600`。目录不存在就创建，模式 `0700`。`--dry-run` 只把 markdown 打到 stdout，不写文件。

退出码：0 成功，2 PG 失败且不写文件，4 参数错误。

## 人群

默认排除验收号，谓词是 `user_id <> 765`。`--include-765` 才把验收号算进主体。两种模式都在文首写明人群。

H：ex765（除非 `--include-765`），`session_id LIKE 'web%'`，`client_message_id LIKE 'm-%'`，`client_message_id NOT LIKE 'm-recover-%'`。回合比率用 H。时间列默认 `admitted_at`。`SERVICE_RESTART` 的时长用 `terminal_at` 落入窗口，时长是 `terminal_at - coalesce(accepted_at, admitted_at)`。

ex765：工具、评分、摩擦、引导。这些表不用 H 的 client_message 条件。

恢复作业的 `status=completed` 只是作业行的 status，不等于用户回合完成。

摩擦按 code 并列行数和会话数。行数不是回合数。

trace 命令只有一种写法，单独一行：

```text
npx tsx scripts/oc-trace.ts <traceId>
```

没有 trace、有 session 时写 session_id，并写「无 trace」。

列车摘要目录是 `${OC_V5_TRAIN_SUMMARY_DIR:-${OC_V5_LEASE_LOG_DIR:-/opt/openclaude/tmp/lease-trains}}`。目录不存在时报告写「未找到」，退出码仍是 0。存在则只数 `"final": true` 和 `"final": false` 的文件个数，不抄 note、命令行或路径。目录改到别处时用这两个环境变量。

## 定时

本页只给出建议。人在宿主 root crontab 安装（每天 08:20 CST）。仓库和这张 PR 都不改 crontab。

```text
20 0 * * * cd /opt/openclaude/openclaude-v5-selfhost && /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin node_modules/.bin/tsx scripts/v5-selfhost-feedback-daily.ts >> /opt/openclaude/var/feedback-daily/cron.log 2>&1
```

上线随下一趟批次。
