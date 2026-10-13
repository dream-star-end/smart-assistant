# selfhost egress / watch 日志轮转（OCV5-400）

这个片段只覆盖两条还没进宿主 logrotate 的日志：

- `/var/log/openclaude-v5-selfhost-egress.log`
- `/var/log/openclaude-v5-selfhost-watch.log`

`/var/log/openclaude-v5-selfhost.log` 和 `/var/log/cloudflared-v5-selfhost.log` 仍由已经在用的 `/etc/logrotate.d/openclaude-v5-selfhost` 负责。这里不加通配，不写 `postrotate`，不重启服务，也不截断现有日志。

发布列车不会安装它。`scripts/deploy-v5-selfhost.sh` 只按文件名复制 unit；`snapshot_cutover_units_from_release` 同样只复制具名的 service、socket 和 sysctl。本文件不在那份名单里，合入或发车都不会把它放进 `/etc/logrotate.d`。

## 策略，以及它不保证什么

选项与现有 selfhost 片段一致：`daily`、`maxsize 200M`、`rotate 14`、`compress`、`delaycompress`、`missingok`、`notifempty`、`copytruncate`。另外写了 `su root adm`。

`maxsize` 不是实时上限。宿主 `logrotate.timer` 是 `OnCalendar=daily`、`AccuracySec=1h`，同时还有 `/etc/cron.daily/logrotate`。两次运行之间日志可以超过 200M，要等下一次 logrotate 才会按体积提前轮转。

`copytruncate` 不改当前文件的 inode，已经打开的写入 fd 会继续写到同一个文件。复制和截断之间写入的字节可能只出现在其中一边，也可能被截掉。不能把这两份日志当成无损审计。对照：不用 `copytruncate`、只用 `create` 时，logrotate 会换 inode，原 fd 的后续写入进归档而不是当前文件。

`/etc/logrotate.conf` 里的全局 `create`、`weekly`、`rotate 4` 会被本片段里的周期、份数和 `copytruncate` 盖住。man 页写明使用 `copytruncate` 时 `create` 不生效，因为原文件还在原地。`delaycompress` 让最新一份归档保持未压缩，更老的才 gzip。`rotate 14` 保留 14 份归档，更老的删除。`notifempty` 在 logrotate 3.21 上即使 `-f` 也不轮转空文件。`missingok` 允许文件还不存在。

`/var/log` 是 `drwxrwxr-x root:syslog`。logrotate 3.21 在没有 `su` 时会因父目录可被非 root 组写而跳过文件。全局配置已经是 `su root adm`；片段里再写一次，是为了单独对这个文件做 `logrotate -d` 时仍然用同一个身份，而不是改成另一个用户。

## 正式安装

审查通过之前不要做。本说明对应的提交只加入仓库，不执行下面的写入。脚本拒绝 `--root /`，也拒绝目标解析到真正的 `/etc/logrotate.d`。彩排用临时目录：

```bash
bash scripts/v5-selfhost-logrotate-egress-watch-install.sh --check-host-readonly
root=$(mktemp -d)
bash scripts/v5-selfhost-logrotate-egress-watch-install.sh --root "$root"
rm -rf -- "$root"
```

`--check-host-readonly` 先统计 `/etc/logrotate.conf` 和 `/etc/logrotate.d` 里这两条精确路径的裸 token，再用私有 state 做一次合并的 `logrotate -d`：同一条命令同时纳入现有 `/etc/logrotate.conf` 和候选片段。这不是“先扫一遍、再单独 `-d` 候选”或“再单独 `-d` 现网配置”，两次分开的 `-d` 不能当作合并验证。带引号的路径和能覆盖这两条日志的通配，只有合并进同一次 dry-run 才会被 logrotate 报成 `duplicate log entry`。`DUPLICATE_EGRESS` 或 `DUPLICATE_WATCH` 不是 0 就停。`LIVE_DRY_RUN` 必须是 0。它不使用 `-f`，也不写 `/etc`。

`--root` 在第一次 `mkdir`、`chmod` 或复制备份之前检查目标目录和备份目录的每一级。父目录若是指向外部的符号链接，脚本退出 2 并打印 `REFUSE_ESCAPE`，不会在链接目标里创建 `logrotate.d`。合并 dry-run 用的是候选的私有副本，失败时不留下 `~` 文件，已有目标的内容不变。

宿主上真正放入 `/etc` 时按同一顺序手工做。`include /etc/logrotate.d` 会读点文件、`.old` 和 `.tmp`，但跳过以 `~` 结尾以及 `.bak`、`.disabled`、`.rpmnew`、`.rpmsave`。所以临时文件必须放在目标目录里且以 `~` 结尾；备份不要放在 `/etc/logrotate.d` 里面。logrotate 会忽略 include 目录里属主不是 root 的文件，参与合并的文件要 `chown root:root`，不能只改权限位。

合并视图必须同时看见“除正在替换的目标文件以外的现有片段”和候选。只对临时文件做 `logrotate -d` 看不到引号和通配。若目标已经存在，不能再让 `/etc/logrotate.conf` 的 `include /etc/logrotate.d` 把旧文件和候选一起算进去，否则重装会被报成自己跟自己重复。顶层配置另放独立临时文件，不能写进片段目录（现有片段也可能叫 00-existing.conf）。失败就删掉临时文件，不执行 `mv -T`。

```bash
name=openclaude-v5-selfhost-egress-watch
dest=/etc/logrotate.d/$name
src=deploy/v5-selfhost/logrotate.d/$name
bash scripts/v5-selfhost-logrotate-egress-watch-install.sh --check-host-readonly
install -d -m 0755 /var/backups/openclaude-v5-selfhost-logrotate
if [[ -f $dest && ! -L $dest ]]; then
  cp -a -- "$dest" "/var/backups/openclaude-v5-selfhost-logrotate/$name.$(date -u +%Y%m%dT%H%M%SZ)"
fi
tmp=$(mktemp --suffix '~' -p /etc/logrotate.d "${name}.XXXXXX")
cp -a -- "$src" "$tmp"
chown root:root "$tmp"
chmod 644 "$tmp"
stage=$(mktemp -d)
parent=$(mktemp)
existing=$(mktemp)
state=$(mktemp)
fail_closed() {
  rm -f -- "$tmp" "$parent" "$existing" "$state"
  rm -rf -- "$stage"
  echo "combined dry-run failed; destination not replaced" >&2
  exit 1
}
for f in /etc/logrotate.d/*; do
  [[ -f $f && ! -L $f ]] || continue
  base=$(basename -- "$f")
  [[ $base == "$name" ]] && continue
  case $base in
    *~|*.bak|*.disabled|*.rpmnew|*.rpmsave) continue ;;
  esac
  cp -a -- "$f" "$stage/$base"
  chown root:root "$stage/$base"
  chmod 644 "$stage/$base"
done
python3 - "$existing" <<'PY'
import os, sys
dest = "/etc/logrotate.d"
out = sys.argv[1]
kept = []
for raw in open("/etc/logrotate.conf", encoding="utf-8", errors="replace"):
    code = raw.split("#", 1)[0].strip()
    parts = code.split()
    if len(parts) >= 2 and parts[0] == "include" and os.path.realpath(parts[1]) == os.path.realpath(dest):
        continue
    kept.append(raw)
open(out, "w", encoding="utf-8").writelines(kept)
PY
chown root:root "$existing" "$parent" "$tmp"
chmod 644 "$existing" "$parent" "$tmp"
printf 'include %s\ninclude %s\ninclude %s\n' "$existing" "$stage" "$tmp" >"$parent"
if ! logrotate -d -s "$state" "$parent"; then
  fail_closed
fi
rm -f -- "$parent" "$existing" "$state"
rm -rf -- "$stage"
sha256sum "$tmp" "$dest" 2>/dev/null || sha256sum "$tmp"
mv -T -- "$tmp" "$dest"
sha256sum "$dest"
```

禁止把 `-d` 换成 `-f`。禁止 `systemctl restart`、`stop` 或槽位切换。禁止删除或清空 `/var/log` 下的现有文件。安装只是增加一条轮转规则，下一次既有 logrotate 调度才会生效，不是当场清日志。
