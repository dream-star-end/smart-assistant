# 商业 B 槽 master 日志轮转（OCV5-579）

`openclaude-v5-b.service` 用 `StandardOutput=append:/var/log/openclaude-v5-b.log` 写日志。生产机上的 `/etc/logrotate.d/openclaude-v5` 是宿主手工维护的文件，不在仓库里，只覆盖 A 槽的 `openclaude-v5.log` 和 egress/monitor 等，漏了 B 槽。2026-10-22 体检时 B 日志约 346MB、约 167 万行，最早一条在 7 月。

本片段 `deploy/v5/logrotate.d/openclaude-v5-b` 只管 B 槽这一条路径，单独成文件，不改现有的 `openclaude-v5` 片段。发布脚本不会安装它：`deploy-v5.sh` 只按名字复制 unit 和 env overrides，合入或发布都不会把它放进 `/etc/logrotate.d`。

## 策略，以及它不保证什么

选项和个人版 egress/watch 片段（OCV5-400，见 `v5-selfhost-logrotate-egress-watch-install.md`）一致：`su root adm`、`daily`、`maxsize 200M`、`rotate 14`、`compress`、`delaycompress`、`missingok`、`notifempty`、`copytruncate`。各项的含义和局限也相同：

- `maxsize` 只在 logrotate 运行时检查，不是实时上限。
- `copytruncate` 不改 inode。systemd 持有的 fd 继续写同一个文件，所以不用重启 unit。但在复制和截断之间写入的字节可能丢失，不能把这份日志当作无损审计。
- `delaycompress` 让最新一份归档保持未压缩。第一次轮转后，约 346MB 的 `openclaude-v5-b.log.1` 会原样留一天，第二天才压缩。

A 片段的周期和保留份数仓库里没有记录。安装前先只读对照（见下面第 1 步）。如果和本模板不一致，先另提 PR 把模板改成一致，再安装。

## 安装器与测试（只在临时目录里写）

- `scripts/v5-logrotate-b-install.sh --check-host-readonly`：统计 `/etc/logrotate.conf` 和 `/etc/logrotate.d` 里能覆盖 B 路径的规则数（精确路径、带引号的路径、通配都算；通配用 fnmatch 判断，不依赖文件当时是否存在），再把现网配置和候选片段放进同一次 `logrotate -d`。输出 `DUPLICATE_B` 和 `LIVE_DRY_RUN`，不写任何文件。
- `--root <tmp>`：彩排安装，只接受 `/tmp`、`/var/tmp` 下的目录。拒绝 `--root /` 和最终解析到真实 `/etc/logrotate.d` 的目标，也拒绝符号链接越界。
- `scripts/v5-logrotate-b.test.sh`：25 项行为检查，包括 copytruncate 后 inode 不变、持有的 fd 继续追加、delaycompress、保留 14 份、拒绝重复/通配/postrotate、A 槽和 egress 的诱饵文件不被轮转，以及真实日志、unit 和 host 片段前后不变。只对 `/tmp` 下的夹具做 `logrotate -f`。

## 生产安装（商业生产变更：交管家，用户回「发」后才做）

在 v5-dev 上、在已合入的 canonical 里执行。全程不用 `logrotate -f`，不重启任何服务，不碰 `openclaude-claude-egress`。

```bash
cd /opt/openclaude/openclaude-v5-aurora
D=/root/ocv5-579-g579
ssh kl-mirror "mkdir -p $D/scripts $D/deploy/v5/logrotate.d" </dev/null
rsync -a scripts/v5-logrotate-b-install.sh kl-mirror:$D/scripts/
rsync -a deploy/v5/logrotate.d/openclaude-v5-b kl-mirror:$D/deploy/v5/logrotate.d/

# 1. 只读：DUPLICATE_B=0 且 LIVE_DRY_RUN=0 才继续；对照 A 片段的周期和份数
ssh kl-mirror "bash $D/scripts/v5-logrotate-b-install.sh --check-host-readonly; \
  grep -nE '^\s*(daily|weekly|rotate|maxsize|size|copytruncate|compress|delaycompress)' /etc/logrotate.d/openclaude-v5; \
  stat -c '%i %s' /var/log/openclaude-v5-b.log; df -h /var/log" </dev/null

# 2. 写入（变更租约下；先断言，后动作）
scripts/with-production-mutation-lease.sh ssh kl-mirror "set -euo pipefail; \
  test ! -e /etc/logrotate.d/openclaude-v5-b; \
  ! grep -q 'openclaude-v5-b.log' /etc/logrotate.d/openclaude-v5; \
  tmp=\$(mktemp --suffix '~' -p /etc/logrotate.d openclaude-v5-b.XXXXXX); \
  install -o root -g root -m 0644 $D/deploy/v5/logrotate.d/openclaude-v5-b \"\$tmp\"; \
  mv -T \"\$tmp\" /etc/logrotate.d/openclaude-v5-b; \
  sha256sum /etc/logrotate.d/openclaude-v5-b; \
  logrotate -d /etc/logrotate.conf 2>&1 | grep -nE 'openclaude-v5-b|duplicate|error' || true" </dev/null

# 3. 收尾
ssh kl-mirror "rm -rf $D" </dev/null
```

验证：等下一次日常 logrotate（timer 每天一次）跑完后，`/var/log/openclaude-v5-b.log.1` 出现，当前文件 inode 不变且继续增长，`openclaude-v5-b.service` 状态和 NRestarts 不变。

回退：`rm /etc/logrotate.d/openclaude-v5-b`。这不影响任何服务，已经轮转出来的归档保留。
