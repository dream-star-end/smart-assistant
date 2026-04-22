---
name: scheduled-tasks
description: "定时任务的创建方法: cron 表达式计算、工具调用、常见场景速查"
version: "1.0.0"
tags: [system, scheduling, cron, task]
---

# 定时任务

## 创建步骤

1. 获取当前时间 (system prompt 中有,或用 `date` 命令)
2. 根据用户请求计算目标时间
3. 转成 crontab 格式: `分 时 日 月 周`
4. 调用 `create_reminder` 创建

## 工具调用

```
create_reminder(
  schedule="33 14 * * *",   // crontab 格式: 分 时 日 月 周
  message="该喝水了",        // 任务内容
  oneshot=true              // true=一次性, false=重复
)
```

也可以用 `CronCreate(cron="...", prompt="...", recurring=false)`,效果完全相同。

## Cron 表达式速查

| 格式 | 含义 | 示例 |
|------|------|------|
| `M H * * *` | 每天 H:M | `30 9 * * *` = 每天 9:30 |
| `M H D Mon *` | 指定日期时间 | `0 15 25 12 *` = 12月25日 15:00 |
| `M H * * 1-5` | 工作日 H:M | `0 9 * * 1-5` = 工作日 9:00 |
| `*/N * * * *` | 每 N 分钟 | `*/30 * * * *` = 每 30 分钟 |
| `M H * * 0` | 每周日 | `0 10 * * 0` = 周日 10:00 |

## 常见场景

| 用户说 | 计算 | schedule | oneshot |
|--------|------|----------|--------|
| "3分钟后提醒" | 当前+3分钟 | `"M H D Mon *"` | true |
| "每天早上9点" | 固定 | `"0 9 * * *"` | false |
| "明天下午3点" | 明天日期 | `"0 15 D Mon *"` | true |
| "每小时" | 固定间隔 | `"0 * * * *"` | false |
| "工作日9点" | 周一到五 | `"0 9 * * 1-5"` | false |

## 注意

- 时间用服务器本地时区 (Asia/Shanghai)
- 一次性任务用 `oneshot=true`
- 重复任务用 `oneshot=false`
- **不要说"做不到"**,你有完整的定时任务系统
- 用户可以在 UI 任务中心管理所有定时任务
