# v5 selfhost watch 安装说明

本文件只说明安装。实现回合不执行这里的命令，不替换宿主 `/opt/openclaude/v5-selfhost-watch/watch.sh`，不删除 `watch-disarmed`。

timer 实际执行的是安装目录里的 `watch.sh`，不是 git 工作树。

从 OCV5-404 起，`scripts/deploy-v5-selfhost.sh --deploy` 在 committed 之后会从新 live release 原子同步 `watch.sh`（同目录临时文件，内容一致且 `bash -n` 通过才 `mv -T`），只换这一支脚本，`watch.env`、`alert.sh`、停用标记都不动。同步失败只告警不回滚；`--smoke` 会因看护漂移失败，`--status` 的 `watch:` 行显示 `install=same|drift`。下面的手工步骤只在同步失败或首次安装时用。

## 不要做的事

- 不要 `rm` `/opt/openclaude/v5-selfhost-watch/watch-disarmed`，不要改它的内容。`WATCH_DRY=0` 时这个文件是自动回滚的闸门。
- 不要改 `watch.env` 里的 `WATCH_DRY`。
- 不要在 timer 还在用目标文件时，用重定向或 `cp` 把 `watch.sh` 原地截断覆盖。
- 不要 `systemctl restart openclaude-v5-selfhost.service`，也不要重启 egress。
- 不要因为 `recovery_armed=false` 去制造每拍非 0 退出。停用不是 healthy，但只读观察正常完成时进程退出码是 0。健康看状态文件的 `health=`。

## 原子替换

在安装目录内写临时文件，校验后再 `mv -T`。同一目录的 rename 不会留下半截旧脚本。

整段在 `set -euo pipefail` 的子 shell 里执行：任何一步失败都会在 `mv -T` 之前退出，临时文件由 trap 删除，已安装的 `watch.sh` 保持原样。源文件用仓库根目录的绝对路径，不依赖当前目录。

```bash
(
  set -euo pipefail
  d=/opt/openclaude/v5-selfhost-watch
  repo=/opt/openclaude/openclaude-v5-selfhost   # 已快进到含本改动的提交
  src="$repo/scripts/v5-selfhost-watch.sh"
  test -s "$src"
  bash -n "$src"
  before="$(stat -c '%i %y %s' "$d/watch-disarmed") $(sha256sum < "$d/watch-disarmed")"
  tmp="$(mktemp "$d/watch.sh.XXXXXX")"
  trap 'rm -f -- "$tmp"' EXIT
  cp -- "$src" "$tmp"
  test "$(sha256sum < "$src")" = "$(sha256sum < "$tmp")"
  bash -n "$tmp"
  chmod 0755 "$tmp"
  mv -T -- "$tmp" "$d/watch.sh"
  trap - EXIT
  after="$(stat -c '%i %y %s' "$d/watch-disarmed") $(sha256sum < "$d/watch-disarmed")"
  test "$before" = "$after"
  sha256sum "$src" "$d/watch.sh"
  echo INSTALL_OK
)
```

没有打印 `INSTALL_OK` 就是没装上：已安装副本没有被替换，不要手工补做后面的步骤。

标记的 inode / mtime / 大小 / sha256 在安装前后必须一致（上面的 `test "$before" = "$after"`）。alert.sh 这次不用换：观察成功退出 0，不会每 30 秒触发 `OnFailure`。

下一拍 timer（约 30 秒，AccuracySec 5 秒）会执行新文件。装完后只读核对状态文件：`recovery_armed=false`，`observation_executed=true`，`health` 为 `green` 或 `red`，`checked_at` 有值。日志里不能把 `recovery_armed=false` 写成 healthy。

## 重新武装（OCV5-404）

停用标记只能用已安装副本的 `--rearm` 解除，不要 `rm`：

```bash
/opt/openclaude/v5-selfhost-watch/watch.sh --rearm
```

它要求：标记是普通文件；`WATCH_DRY=0`；已安装副本就是正在执行的这份；没有 manual-recovery；没有活的发布锁、维护窗口、cutover grace；连续 `WATCH_REARM_CHECKS`（默认 3，间隔 `WATCH_REARM_INTERVAL_SEC` 默认 5 秒）次复合健康绿且 healthz `deps.pg=ok`。任一不满足打印 `REARM_REFUSED <原因>` 并退出 1，标记和失败计数都不动。

通过后先把失败计数清零，再把标记改名为 `watch-disarmed.rearmed-<UTC>` 留作证据，状态文件写 `recovery_armed=true`，打印 `REARM_OK archived=<路径>`。下一拍 timer 按武装路径检查，日志应出现 `复合健康绿,清失败计数`。

