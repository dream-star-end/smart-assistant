# Box Claude Code 多账号（profile）—— 设计与运维

状态：商业版（0299）。个人版代码同源，没有表时每个账号只用默认登录，行为不变。

## 背景

一个 Cursor 账号 = 一个 Box；Box 里原先只有一个 Claude Code 登录（`/home/box/.claude`）。它的 5 小时额度用尽时，
所有 Box Claude 轮次都失败（2026-10-06 白天，约 23:20 重置）。Box 里本来就能并存多个登录（每个一个
`CLAUDE_CONFIG_DIR`，如 `/home/box/.claude-account2`），产品只是没用上。

## 模型

- **profile** = Box 里的一个 Claude Code 登录：`default` → `/home/box/.claude`（启动时不设 `CLAUDE_CONFIG_DIR`，与以前
  字节一致）；`<名称>` → `/home/box/.claude-<名称>`（名称 `[a-z0-9][a-z0-9-]{0,31}`，`default` 保留）。
- 表 `box_claude_profiles(account_id, profile, enabled, is_default, login_state, projects_mode, email_hint,
  account_fingerprint, org_type, utilization, cooldown_until, last_reason, …)`。**没有凭据**：邮箱在 Box 里脱敏
  （`a***@b***.com`）、账号指纹是 sha256 前 12 位。
- 账号没有任何行 = 隐式只用默认登录（迁移上线后行为不变，直到管理员第一次“扫描”）。扫描首次发现时只把
  已登录的 `default` 置为启用+默认，其余新发现的登录都是未启用。

### 为什么历史/清理/原生续聊不用改

产品的 Box 脚本一直读写 `/home/box/.claude/projects`。profile 目录里的 `projects` 必须是指向它的软链，
所以会话文件对所有登录可见，stage / cleanup / prelaunch / native GC 一行没动。**只有启动那一条请求**按 profile
加 `CLAUDE_CONFIG_DIR`（`boxProfileExec.ts` 包装 `target.exec`）。目录里有自己的真实 `projects`（例如开发用的账号目录）
一律不可勾选，也不会被修改——这同时把开发账号隔离在产品流量之外。

## 安全护栏

- 候选只含 `enabled && login_state=logged_in && projects_mode ∈ {root, shared}` 的行：手改数据库行也不能把流量路由到未登录或自带
  真实 `projects` 的目录。
- **Box 端现场校验**：每个非默认登录在交出目标前（解析阶段、尚未占用容量/写账本）都过一次 Box 端 `GUARD`
  脚本（目录 fd + `O_NOFOLLOW`，确认登录仍在、`projects` 仍是指向共享目录的软链、共享目录仍是本用户的真实目录），
  结果缓存 30 秒。被拒绝的登录冷却 1 小时（原因 `profile_unsafe`）并改选其它登录，最多重试 3 次。数据库里的发现结果不是安全边界。
- 发现/接入/校验脚本全部用目录 fd 相对操作，不跟随符号链接；`projects` 是否“共享”按软链目标文字精确判定；邮箱在 Box 里脱敏，
  后端和 API 出口再各校验一次脱敏格式。
- 配置读取失败**关闭**（不会把“全部关闭”的账号当成未配置）：只有“表不存在”走旧行为；其它数据库错误只在同一账号集合
  60 秒内读过缓存时沿用，否则这一轮报 `BOX_PROFILE_STORE_UNAVAILABLE`。
- 候选集里没有任何账号有保存的登录（或没有表）→ 走**原来的**加权随机选账号，与上线前完全一致；
  只要有一个账号配置了登录，就按下面的亲和调度（没配置的账号按隐式默认登录参与）。

## 调度（`boxProfileScheduler.ts`，纯函数）

1. 候选 = 所有可用的 Cursor 账号（沿用原有资格、配额类、slot 权重）× 其已勾选的登录。账号没有行 → 默认登录。
2. 剔除冷却中的登录（额度用尽 / 登录失效）。
3. **亲和优先**：加权 rendezvous hash（key=uid）对候选排序。同一用户固定落在同一个登录/同一个 Box（提示缓存、会话续接），
   不需要保存分配；某登录掉出候选只会移动它自己的用户，恢复后自动回来。默认登录权重 ×1.5。权重是静态的，
   不随负载或额度漂移，否则亲和会被破坏。
4. **兜底**：沿着该用户的排序往后找第一个“健康且不忙”的登录：额度利用率 < 0.92；近 90 秒该登录启动数 < 10、
   该 Box（所有登录合计）< 14（约 6 路并发，等于商业路线每账号上限）。切换是确定性的、平滑的。
5. 全部过热：留在健康登录里选最空的；都不健康选利用率最低的（`last_resort`）。
   全部冷却：只因额度冷却的登录仍会被尝试（`quota_benched`）——CLI 立刻免费地返回用量上限拒绝，用户看到真实的
   “额度用尽”提示，额度恢复的那一刻自动恢复；登录失效 / 校验被拒的登录永远不尝试，全部如此才返回 `BOX_ACCOUNT_UNAVAILABLE`。
   （上线后第一次真机金丝雀暴露：单登录被额度冷却后，所有请求变成笼统的 BOX_ACCOUNT_UNAVAILABLE，而不是用量上限提示。）

## 额度/故障怎么学到（不额外花钱）

每个 `claude -p` 的 stream-json 都带 `rate_limit_event`（真实形状见 `boxProfileSignals.test.ts` 的夹具，取自
2026-10-06 的真机输出）。`boxProfileExec.ts` 在 `target.exec` 上旁听 stdout（按行重组，行可以被切在任意字节处；运行失败退出 1 时同样会读到）：
`allowed*` → 更新利用率；`rejected` → 冷却到该窗口的 `resetsAt`（缺失则 15 分钟，上限 7 天）；合成助手消息
`Not logged in` → 登录失效冷却 30 分钟。状态先写进程内存，再尽力镜像到表（重启和管理页可见）。

## 已知限制（诚实写在这里）

- 同一个**请求**不会在失败后换登录重试：账本对相同指纹的第二次 admit 返回 `BOX_CALL_AMBIGUOUS`，自动重放有重复
  计费风险。因此第一次撞上额度的那一次请求仍会失败，之后的请求立刻换走（亲和 + 利用率 0.92 的提前避让会让这种情况很少见）。
- 负载是“近 90 秒启动数”的估计（后台运行没有可见的结束信号），不是精确并发；硬并发上限仍是账本里的每账号/每用户上限。
- 路线 B（`box-claude-*`，整个代理跑在 Box 里）仍只用默认登录。商业版路线 B 已停用。
- 调度状态的“启动数”是每个 egress 进程各自一份；利用率/冷却通过表共享。

## 运维

- 管理页：账号池 → Cursor 账号行 → “Box 内的 Claude Code 账号”。扫描 / 勾选生效 / 选默认。
- API：`GET /api/admin/box-claude-profiles?account_id=`；`POST …/discover {account_id}`；`PUT … {account_id, enabled[], default}`。
- 新增一个 Claude Code 账号（需要账号所有者登录授权，不能自动化）：在该 Box 里
  `mkdir -p ~/.claude-<名称>` → `CLAUDE_CONFIG_DIR=~/.claude-<名称> claude` 里 `/login` → 回管理页“扫描”
  （会自动给已登录的目录建 `projects` 软链）→ 勾选并保存。不要用含有真实会话记录的目录。
- 紧急回到只用默认登录：管理页只勾 `default`，或 `UPDATE box_claude_profiles SET enabled = (profile='default'),
  is_default = (profile='default') WHERE account_id = <id>`。要完全撤销：迁移文件里的 TESTED MANUAL ROLLBACK 块
  （删表 + 删 ledger 行）；代码在表缺失时自动退回隐式默认登录。
