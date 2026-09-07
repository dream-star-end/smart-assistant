# 问题卡每日审查（selfhost）

宿主 cron 跑 `scripts/v5-problem-card-review.ts`：只读 PG 聚合 `product_friction_events` 的问题卡 / 裁决 / job / visible_fallback，达阈值则经容器内 `oc-task` 开 backlog bug 单（人批准），已有单追加当日计数评论，digest 落盘并站内信给 uid 3。

Phase 1 **不改恢复策略**。本脚本不进 master 进程。

## 前置

```bash
mkdir -p /opt/openclaude/var/problem-card-review
# u3 容器在线
docker exec oc-v5-u3 /home/agent/.local/bin/oc-task project list
```

需要：

- `DATABASE_URL`（或 `/etc/openclaude/commercial-v5-selfhost.env` 里的 `^DATABASE_URL=`）
- live canonical worktree `/opt/openclaude/openclaude-v5-selfhost`（脚本只读 PG + 调 CLI，不依赖 dist）
- 迁移 0278 已应用后 `path`/`reason`/`presentation` 才有值；未应用时脚本把这三列当 NULL，指纹为 `stage:code:-:-`

## cron（root crontab，CST 07:45 = UTC 23:45）

以实际 live release 路径为准。`/opt/openclaude/openclaude-v5-selfhost` 是 canonical worktree。

```
45 23 * * * cd /opt/openclaude/openclaude-v5-selfhost && /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin node_modules/.bin/tsx scripts/v5-problem-card-review.ts >> /opt/openclaude/var/problem-card-review/cron.log 2>&1
```

安装由人执行，脚本本身不改 crontab。

## 手动跑法

```bash
cd /opt/openclaude/openclaude-v5-selfhost

# 只读：不建单、不评论、不写 state、不发站内信
node_modules/.bin/tsx scripts/v5-problem-card-review.ts --dry-run --window 24h

# 聚合 + digest + 站内信，不动工单
node_modules/.bin/tsx scripts/v5-problem-card-review.ts --no-tickets --date 2026-09-08

# 指定 state 目录 / 容器 / 项目 key
node_modules/.bin/tsx scripts/v5-problem-card-review.ts --dry-run \
  --state-dir /tmp/pcr-state --container oc-v5-u3 --project OCV5
```

`--window` 范围 `1h..720h`（默认 `24h`）；7 天窗口始终另算。`--date` 默认今天 CST，必须 `YYYY-MM-DD`。

## 开单阈值

某 fingerprint 的 24h 计数满足其一：

- `failed >= 3` 且 `affected_users_failed >= 2`
- 或 `failed >= 5`（单用户也开）

fingerprint = `stage:code:path:reason`；NULL 记 `-`，过不了 `^[a-z0-9_]+` 的 token 记 `other`。

已有单：title 精确匹配 `problem-card: <fingerprint>` 且 status 不是 `done` / `cancelled`（含美式 `canceled`）。identifier **只用** `oc-task` 返回值。当日 counts 与 state 中 `last_counts` 不同且今日未评论 → 评论一条。连续 7 天 24h-failed=0 → 评论「建议关单：7 天无新样本」一次，**不自动关**。

所有 `oc-task` 走 `docker exec -i <container> /home/agent/.local/bin/oc-task …`（`execFile` argv 数组，title/body 不经 shell）。digest 进容器走 stdin：`docker exec -i … sh -c 'cat > /home/agent/.openclaude/generated/problem-card-digest-<YYYY-MM-DD>.md'`，日期白名单 `^\d{4}-\d{2}-\d{2}$`。

## 退出码

| 码 | 含义 | 副作用 |
| --- | --- | --- |
| 0 | 成功 | digest 已写；非 dry-run 时 state / 站内信按开关执行 |
| 2 | PG 连接或查询失败 | **无任何写动作** |
| 3 | 面板不可用（oc-task 退出 3/4） | digest 已写，**不改 state** |
| 4 | 参数错误 / `DATABASE_URL` 缺失 / `state.json` 损坏 | 无写动作 |

oc-task 退出 5（409）重读后再试一次；6（423）跳过该张单。

stdout 第一行是 JSON 摘要；`--dry-run` 随后打印人类可读 digest。

## state 结构

`<state-dir>/state.json`（默认 `/opt/openclaude/var/problem-card-review/state.json`），原子写（临时文件 + rename）：

```json
{
  "fingerprints": {
    "problem_card:upstream_failed:immediate:-": {
      "identifier": "OCV5-170",
      "created_at": "2026-09-08",
      "last_comment_date": "2026-09-08",
      "last_counts": {
        "shown": 6,
        "recovered": 1,
        "failed": 5,
        "cancelled": 0,
        "pending": 0,
        "affected_users": 2,
        "affected_users_failed": 2
      },
      "daily": [{ "date": "2026-09-08", "failed": 5 }],
      "close_suggested_at": null
    }
  }
}
```

`daily` 最多保留 14 个自然日。digest 另写 `<state-dir>/digest-<date>.md`，并复制到容器 `/home/agent/.openclaude/generated/problem-card-digest-<date>.md`。

## 重置某个 fingerprint

只删 state 里那一键，不动工单（关单是人的动作）：

```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path("/opt/openclaude/var/problem-card-review/state.json")
data = json.loads(p.read_text())
fp = "problem_card:upstream_failed:immediate:-"
data.get("fingerprints", {}).pop(fp, None)
p.write_text(json.dumps(data, indent=2) + "\n")
PY
```

下次跑会按阈值重新匹配已有 title；没有 open 单才会再 `ticket create`。

## 隐私边界

- 只读 `product_friction_events`（`START TRANSACTION READ ONLY`）
- **绝不**查 `messages` / tape / 任何正文表
- 工单 body / digest 只有有界枚举、计数、最多 3 个 `trace_id`
- fingerprint / 正文不进 `sh -c` 参数；digest 正文只走 stdin
