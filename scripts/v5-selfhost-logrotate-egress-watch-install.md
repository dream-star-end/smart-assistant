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

`--check-host-readonly` 只扫描 `/etc/logrotate.conf` 和 `/etc/logrotate.d` 里这两条精确路径，并用私有 state 跑 `logrotate -d /etc/logrotate.conf`。它不使用 `-f`。`DUPLICATE_EGRESS` 或 `DUPLICATE_WATCH` 不是 0 就停。`LIVE_DRY_RUN` 必须是 0。

宿主上真正放入 `/etc` 时按同一顺序手工做。`include /etc/logrotate.d` 会读点文件、`.old` 和 `.tmp`，但跳过以 `~` 结尾以及 `.bak`、`.disabled`、`.rpmnew`、`.rpmsave`。所以临时文件必须放在目标目录里且以 `~` 结尾，校验后再 `mv -T`；备份不要放在 `/etc/logrotate.d` 里面。logrotate 会忽略 include 目录里属主不是 root 的文件，临时文件要 `chown root:root`，不能只改权限位。

```bash
name=openclaude-v5-selfhost-egress-watch
dest=/etc/logrotate.d/$name
src=deploy/v5-selfhost/logrotate.d/$name
bash scripts/v5-selfhost-logrotate-egress-watch-install.sh --check-host-readonly
install -d -m 0755 /var/backups/openclaude-v5-selfhost-logrotate
if [[ -f $dest ]]; then
  cp -a -- "$dest" "/var/backups/openclaude-v5-selfhost-logrotate/$name.$(date -u +%Y%m%dT%H%M%SZ)"
fi
tmp=$(mktemp --suffix '~' -p /etc/logrotate.d "${name}.XXXXXX")
cp -a -- "$src" "$tmp"
chown root:root "$tmp"
chmod 644 "$tmp"
state=$(mktemp)
if ! logrotate -d -s "$state" "$tmp"; then
  rm -f -- "$tmp" "$state"
  echo "syntax failed; destination not replaced" >&2
  exit 1
fi
rm -f -- "$state"
sha256sum "$tmp" "$dest" 2>/dev/null || sha256sum "$tmp"
mv -T -- "$tmp" "$dest"
sha256sum "$dest"
```

禁止把 `-d` 换成 `-f`。禁止 `systemctl restart`、`stop` 或槽位切换。禁止删除或清空 `/var/log` 下的现有文件。安装只是增加一条轮转规则，下一次既有 logrotate 调度才会生效，不是当场清日志。
