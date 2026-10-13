# v5 selfhost watch 安装说明

本文件只说明安装。实现回合不执行这里的命令，不替换宿主 `/opt/openclaude/v5-selfhost-watch/watch.sh`，不删除 `watch-disarmed`。

timer 实际执行的是安装目录里的 `watch.sh`，不是 git 工作树。`scripts/deploy-v5-selfhost.sh` 不复制这支脚本，合入或发版不会自动换掉它。

## 不要做的事

- 不要 `rm` `/opt/openclaude/v5-selfhost-watch/watch-disarmed`，不要改它的内容。`WATCH_DRY=0` 时这个文件是自动回滚的闸门。
- 不要改 `watch.env` 里的 `WATCH_DRY`。
- 不要在 timer 还在用目标文件时，用重定向或 `cp` 把 `watch.sh` 原地截断覆盖。
- 不要 `systemctl restart openclaude-v5-selfhost.service`，也不要重启 egress。
- 不要因为 `recovery_armed=false` 去制造每拍非 0 退出。停用不是 healthy，但只读观察正常完成时进程退出码是 0。健康看状态文件的 `health=`。

## 原子替换

在安装目录内写临时文件，校验后再 `mv -T`。同一目录的 rename 不会留下半截旧脚本。

```bash
d=/opt/openclaude/v5-selfhost-watch
src=scripts/v5-selfhost-watch.sh
stat -c '%i %y %s' "$d/watch-disarmed"
sha256sum "$d/watch-disarmed"
tmp="$(mktemp "$d/watch.sh.XXXXXX")"
cp -- "$src" "$tmp"
sha256sum "$src" "$tmp"
chmod 0755 "$tmp"
mv -T -- "$tmp" "$d/watch.sh"
stat -c '%i %y %s' "$d/watch-disarmed"
sha256sum "$d/watch-disarmed"
```

两段 `stat` / `sha256sum` 必须一致。alert.sh 这次不用换：观察成功退出 0，不会每 30 秒触发 `OnFailure`。

下一拍 timer（约 30 秒，AccuracySec 5 秒）会执行新文件。装完后只读核对状态文件：`recovery_armed=false`，`observation_executed=true`，`health` 为 `green` 或 `red`，`checked_at` 有值。日志里不能把 `recovery_armed=false` 写成 healthy。
