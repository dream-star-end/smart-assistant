# 被 needrestart 排除的 unit：补丁后如何受控重启

本清单对应 `needrestart-openclaude.conf` 排除的三类 unit。needrestart 不再在 `apt-daily-upgrade` 后自动重启它们（2026-09-05 #4：openssh 升级 → needrestart 杀掉 `openclaude-v5-deploy-*` 与 `openclaude-selfheal-tunnel` → 发布 lease 丢）。**排除 ≠ 永不重启**；库/内核升级后由人按本清单在安全窗口重启。

不要用 `KillMode=none`。不要 `systemctl restart openclaude*` 通配（同机还有老个人版 `openclaude.service`）。

## 1. `openclaude-v5-deploy-*`（发布 runner）

- **不要** systemctl restart / kill 这些 unit。
- 它们是一次性 `systemd-run` 的 deploy 控制器（`scripts/v5-deploy-detached.sh`），权威收口走 `scripts/deploy-v5.sh --abort` / `--rollback` / `--recover`。
- RemainAfterExit=yes 的 `active (exited)` 残留不是在飞发布；`MainPID=0`。清残留用 `systemctl stop <unit>`（会跑 ExecStopPost 恢复 apt timer）。
- 在飞判定：`systemctl show openclaude-v5-deploy-*.service -p MainPID -p SubState`，MainPID ≠ 0 才是活的。

## 2. `openclaude-v5-selfhost*`（自用 V5 网关 / egress / watch / proxy）

- **受控重启 = 官方发布脚本**，不要对 live 直接 `systemctl restart openclaude-v5-selfhost.service`。
- 命令（宿主）：`/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh --deploy`（或已有 live 时的 `--cutover`）。
- 先扫：发布锁、其他 `openclaude-v5-deploy-*` MainPID、在飞 grok-native / 会话。非空则等收口。
- 禁止对 `/opt/openclaude/openclaude-v5-releases/*` 做 `cp -al` / `rm -rf`。

## 3. `openclaude-selfheal-tunnel.service`（个人机 ⇄ kl-mirror 自愈隧道）

- 只在**没有发布 lease / 没有在飞 `openclaude-v5-deploy-*`（MainPID≠0）**时重启。
- 只读核验：`systemctl is-active openclaude-selfheal-tunnel.service`；`/run/openclaude-v5/` 或 deploy holder 是否有锁。
- 重启：`systemctl restart openclaude-selfheal-tunnel.service`（写全名）。
- 不要从 uid3 容器对 kl-mirror 做任何写入；隧道挂了先看本机 unit，再只读查对端。

## 4. 商业版 master（`openclaude-v5.service` / `openclaude-v5-b.service`）

- **本 conf 不排除它们**（它们跑在 kl-mirror，不在 v3-dev-sg 的 needrestart 域）。
- 商业 master 重启只走 `scripts/deploy-v5.sh` 官方路径。本清单不授权碰 kl-mirror。

## 5. 安装 needrestart 排除后怎么核验

```bash
# 语法：conf.d 被 default 配置 include
needrestart -c /etc/needrestart/needrestart.conf -b | head
ls -l /etc/needrestart/conf.d/openclaude.conf
# 升级演练时（不要在发布窗口）看 needrestart -l 不应再列出
# openclaude-v5-deploy-* / openclaude-selfheal-tunnel / openclaude-v5-selfhost*
```

## 6. 发布期 apt timer

发布脚本会在写 lane 开始时 `systemctl stop apt-daily.timer apt-daily-upgrade.timer`（若当时 active），状态写入 `/opt/openclaude/tmp/maint-suspended.json`，EXIT / ExecStopPost 恢复。6h 未恢复且无在飞 deploy → `openclaude-maint-restore.timer` 兜底（需人工安装该 timer，本 PR 只准备 unit 文件）。
