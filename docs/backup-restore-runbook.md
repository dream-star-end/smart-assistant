# PG Backup & Restore Runbook (M7 / P1-10)

最后更新: 2026-05-23

> **当前拓扑**:v3 prod master = KL (154.193.246.236);P0.3 backup-pull 集中点 = sg
> (38.55.252.217, 薄荷云 Cloudvalley, 16-core)。
>
> **2026-05-23 变更**:原 45.32 master 决策废弃,P0.3 集中点已迁到 sg。历史拓扑变更
> (Tokyo→KL prod master / Vultr→GCE 45.32 / GCE→sg P0.3 target)见 git history。

## 备份架构

```
[v3 commercial VM (KL .236)]              [sg (38.55.252.217 薄荷云 Cloudvalley)]
  /usr/local/bin/pg-backup-openclaude.sh   /usr/local/bin/pull-v3-backups.sh
    daily 17:15 UTC via systemd timer        daily 18:00 UTC via /etc/cron.d/pull-v3-backups
    runuser -u postgres -- pg_dump -Fc       SSH backup-pull@v3 info → fetch=<basename>
    -> /var/backups/postgres/                sha256/size verify
       openclaude_commercial-YYYYMMDD-HHMMSSZ.dump
    14d retention                          -> /var/backups/v3-commercial/kl-master/
                                              30d retention
  /usr/local/bin/pg-restore-test.sh
    Sun 03:00 UTC via systemd timer
    runuser -u postgres -- pg_restore --no-owner --no-acl
    into throwaway DB, asserts claude_accounts present
```

恢复点目标(RPO)≤ 24h(每日一次 dump + pull)。
恢复时间目标(RTO)≤ 30min(从 sg scp 回 + pg_restore + service restart)。

## 跨云 DR 矩阵

| 灾难场景 | 恢复路径 |
|---------|---------|
| v3 VM 数据库损坏(可登录) | 本机 `/var/backups/postgres/` 14d 之内任一 dump → `pg_restore` |
| v3 VM 整机丢失或不可达 | 从 sg `/var/backups/v3-commercial/kl-master/` 30d 之内任一 dump → 新 VM `pg_restore` |
| sg 整机丢失 | v3 VM 本机 14d dump 仍在,推迟设置新集中点不影响日常 |
| **双机同时损坏** | **数据丢失,RPO 不可避**(本期不覆盖,见 Limitations) |

## Limitations(必读)

1. **sg 是临时集中收集点,不是独立备份系统**
   - sg = 38.55.252.217,薄荷云 Cloudvalley,16-core,同时承载 boss 日用 AI 入口
     + v3 commercial 开发任务,运维平面与备份目的地耦合
   - 真正的独立 backup-only 设施需要专建一台只跑 sshd + cron 的 VPS,本期未做
   - 长期演进:加第二个 pull target(例如 AWS/Cloudflare R2 / 另一家 VPS),
     让 pull 脚本同时推送两份

2. **风险边界:sg 与 KL 跨账号、跨 ASN;二者仍都在国内云**
   - sg(38.55.252.217)与 KL(154.193.246.236)分属不同账号、不同 ASN,
     抗 KL 单 cloud / 单账号灾难(账号被封 / 单 cloud 跑路 / 单 cloud DC 烧)
   - **但都在国内云,不抗"中国互联网整体级事故"**(如全国出口受阻 / 政策性
     大面积停服)。这一层需要海外目标机(GCE/AWS/自建 NAS),本期不覆盖

3. **pull 失败多日恢复后只拉当日最新,不补中间缺口**
   - 若 pull 5 天连续失败,第 6 天恢复 → 只拿到第 6 天的 dump(sg 侧)
   - 中间 5 天的恢复点仍在 v3 VM 本机的 14d 保留中(只要 VM 还活着)
   - 若 v3 VM 在这 5 天里丢了 → 数据丢 5 天

4. **restore-test 只在 v3 VM 本机跑,不验证 sg 副本可恢复**
   - v3 VM 上的周日 03:00 UTC drill 只验证"本机 dump 可恢复"
   - **每月手工演练(必做)**: 从 sg 上的副本拉一份 dump 到测试环境,跑 `pg_restore --list` 验证可读
   - 见下方"每月手工 DR 演练"

## 部署清单(一次性,有序)

### v3 VM 侧

```bash
# 0. 假设你已 ssh 到 v3 VM 当 root
cd /tmp && git clone git@github.com:<repo>/openclaude-v3.git || ...   # 或 scp 仓库目录
cd /opt/openclaude/openclaude-v3

# 1. 部署/更新 pg-backup-openclaude.sh(sudo → runuser 切换)
install -m 0755 -o root -g root \
  infra/pg-backup-pull/pg-backup-openclaude.sh \
  /usr/local/bin/pg-backup-openclaude.sh

# 2. 部署 backup-pull 用户 + wrapper + helper + sudoers + authorized_keys
#    需要先在 sg 生成 ed25519 keypair 并取得 pubkey 单行字符串
PULL_PUBKEY="ssh-ed25519 AAAA... sg-pull" \
PULL_FROM_IP="38.55.252.217" \
bash infra/pg-backup-pull/setup-v3-backup-pull.sh
# PULL_FROM_IP = sg (薄荷云 Cloudvalley, 16-core)。
# 历史 45.32 / 35.243.97.117 / GCE / Vultr 45.32.41.166 都已废弃,不要用。

# 3. 部署 backup-gen systemd 单元(M7/P1-10 dev half 补全 — 2026-05-23)
#    pg-backup-openclaude.sh 已在步骤 1 装到 /usr/local/bin/;此步把 systemd
#    timer 启起来,让 KL 每天 17:15 UTC 自动跑 pg_dump。
#    没有这步,sg 侧 pull 无 dump 可拉(P0.3 sg bootstrap prereq)。
#
#    预创建 backup 目录 —— 单元用 ProtectSystem=strict,只把
#    /var/backups/postgres 列在 ReadWritePaths;父目录 /var/backups 仍只读,
#    所以单元 first run 时脚本里的 install -d 会失败。这里手工预创建一次,
#    后续脚本 install -d 走幂等 chmod/chown 路径(在 RW 范围内)。
install -d -m 0700 -o postgres -g postgres /var/backups/postgres

install -m 0644 -o root -g root \
  infra/systemd/pg-backup-openclaude.service /etc/systemd/system/pg-backup-openclaude.service
install -m 0644 -o root -g root \
  infra/systemd/pg-backup-openclaude.timer /etc/systemd/system/pg-backup-openclaude.timer
systemctl daemon-reload
systemctl enable --now pg-backup-openclaude.timer
systemctl is-enabled pg-backup-openclaude.timer    # 期待: enabled
systemctl list-timers pg-backup-openclaude.timer   # 期待: NEXT = 今晚 17:15 UTC

# 4. 部署 restore-test 脚本
install -m 0755 -o root -g root \
  scripts/pg-restore-test.sh /usr/local/bin/pg-restore-test.sh

# 5. 部署 restore-test systemd 单元
install -m 0644 -o root -g root \
  infra/systemd/pg-restore-test.service /etc/systemd/system/pg-restore-test.service
install -m 0644 -o root -g root \
  infra/systemd/pg-restore-test.timer /etc/systemd/system/pg-restore-test.timer
systemctl daemon-reload
systemctl enable --now pg-restore-test.timer

# 6. 验证 timer 在排队
systemctl list-timers pg-restore-test.timer
```

### sg 侧

```bash
# 1. 生成专用 backup-pull keypair(无 passphrase,机器自动用)
ssh-keygen -t ed25519 -f /root/.ssh/v3-backup-pull -N "" -C "sg-v3-backup-pull"
chmod 600 /root/.ssh/v3-backup-pull
chmod 644 /root/.ssh/v3-backup-pull.pub

# 2. Pin v3 VM host key(防 MITM,**强制必做**)
#    人工确认指纹:ssh 到 v3 VM(走 trusted channel,比如已有的 kl-mirror SSH alias)
#    跑 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`,与下面 ssh-keyscan 输出对照。
#    不一致就停手:可能是 MITM / 错连其它机器 / 配置漂移,排查清楚再继续。
ssh-keyscan -t ed25519 154.193.246.236 > /root/.ssh/known_hosts.v3-pull
chmod 600 /root/.ssh/known_hosts.v3-pull
ssh-keygen -lf /root/.ssh/known_hosts.v3-pull   # 显示指纹,与 KL .236 上的应一致

# 3. 部署 pull 脚本
install -m 0755 -o root -g root \
  /opt/openclaude/openclaude-v3/infra/pg-backup-pull/pull-v3-backups.sh \
  /usr/local/bin/pull-v3-backups.sh

# 4. 部署 cron(注意是 system cron,不是 OpenClaude cron.yaml)
cat > /etc/cron.d/pull-v3-backups <<'CRON'
# M7/P1-10 — Daily SSH-pull v3 commercial PG backup to sg (cross-cloud cold copy).
# 18:00 UTC ≈ v3 backup window 17:15 UTC + 45min margin.
0 18 * * * root /usr/bin/flock -n /run/pull-v3-backups.lock /usr/local/bin/pull-v3-backups.sh
CRON
chmod 644 /etc/cron.d/pull-v3-backups

# 5. 检查 .env.keys 含 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)=' /root/.openclaude/.env.keys
chmod 600 /root/.openclaude/.env.keys
```

## 部署后烟雾测试(8 项)

按顺序跑,每一项 OK 才进下一项:

1. **Pubkey 指纹核对**
   ```bash
   ssh-keygen -lf /root/.ssh/v3-backup-pull.pub
   ```
   输出指纹与 v3 VM 上 `cat /home/backup-pull/.ssh/authorized_keys` 中的一致。

2. **Host key 指纹核对**
   ```bash
   ssh-keygen -lf /root/.ssh/known_hosts.v3-pull
   ```
   与从已有 trusted SSH(`kl-mirror` alias)看到的 host key 指纹一致。

3. **info 协议**
   ```bash
   ssh -i /root/.ssh/v3-backup-pull \
       -o StrictHostKeyChecking=yes \
       -o UserKnownHostsFile=/root/.ssh/known_hosts.v3-pull \
       -o BatchMode=yes \
       -o IdentitiesOnly=yes \
       backup-pull@154.193.246.236 info
   ```
   应返回三行 FILENAME/SIZE/SHA256。

4. **fetch 协议 + 本地 sha256 比对**
   ```bash
   BASE=$(... info ... | awk -F= '/^FILENAME=/{print $2}')
   ... fetch=$BASE > /tmp/test.dump
   sha256sum /tmp/test.dump
   # 与 #3 输出的 SHA256 对比,应一致
   ```

5. **denied 路径**
   尝试任意未白名单命令应被拒绝:
   ```bash
   ssh ... backup-pull@... 'cat /etc/passwd' ; echo "exit=$?"
   ```
   应返回 `ERR: denied`,exit ≠ 0。

6. **正常 cron 跑一次**
   ```bash
   /usr/local/bin/pull-v3-backups.sh
   tail -30 /var/log/pull-v3-backups.log
   ls -la /var/backups/v3-commercial/kl-master/
   ```
   日志应有 `OK(kl-master): pulled ...`。

7. **故意失败,验证 Telegram 告警**
   v3 VM 上临时改 backup-pull-cmd 让 info 返回 ERR:
   ```bash
   # On v3 VM
   sudo mv /usr/local/bin/backup-pull-cmd /usr/local/bin/backup-pull-cmd.bak
   sudo touch /usr/local/bin/backup-pull-cmd && sudo chmod 0755 /usr/local/bin/backup-pull-cmd
   echo '#!/bin/sh' | sudo tee /usr/local/bin/backup-pull-cmd
   echo 'echo "ERR: forced"; exit 99' | sudo tee -a /usr/local/bin/backup-pull-cmd
   ```
   sg 上跑 pull 脚本,应:
   - log 出现 `FAIL(kl-master)`
   - `/var/backups/v3-commercial/kl-master/.pull-failed` 出现
   - Telegram 收到 `[v3-backup-pull] FAIL kl-master: ...`

8. **恢复后 RECOVERED 告警**
   恢复 v3 VM 上的 backup-pull-cmd,再跑 pull 脚本:
   - `.pull-failed` marker 应被删除
   - Telegram 收到 `[v3-backup-pull] RECOVERED kl-master: pulled ...`

## 灾难恢复操作手册

### 场景 A: v3 VM 数据库损坏(VM 仍可登录)

```bash
# 1. 停 v3 服务,避免新写入污染
ssh root@<v3-vm> 'systemctl stop openclaude'

# 2. 选定恢复目标 dump(默认最新)
ssh root@<v3-vm> 'ls -lht /var/backups/postgres/openclaude_commercial-*.dump | head -5'
DUMP=/var/backups/postgres/openclaude_commercial-YYYYMMDD-HHMMSSZ.dump

# 3. 备份当前(可能损坏的) DB,以防需要回滚
ssh root@<v3-vm> "runuser -u postgres -- pg_dump -Fc -d openclaude_commercial -f /tmp/pre-restore-$(date +%s).dump"

# 4. drop + recreate + restore
ssh root@<v3-vm> "runuser -u postgres -- dropdb openclaude_commercial"
ssh root@<v3-vm> "runuser -u postgres -- createdb openclaude_commercial"
ssh root@<v3-vm> "runuser -u postgres -- pg_restore --no-owner --no-acl -d openclaude_commercial $DUMP"

# 5. 跑迁移确认 schema 完整(restore 已带,但保险)
ssh root@<v3-vm> 'cd /opt/openclaude/openclaude-v3 && bash scripts/run-migrations.sh'  # 或等价命令

# 6. 启服务并烟雾测试
ssh root@<v3-vm> 'systemctl start openclaude && sleep 5 && curl -fsS http://127.0.0.1:8080/healthz'
bash /opt/openclaude/openclaude-v3/scripts/smoke-v3.sh
```

### 场景 B: v3 VM 整机丢失,从 sg 副本恢复

```bash
# 1. 在新 VM 上准备 PG16 + openclaude_commercial DB(空库)
#    省略具体步骤(标准 v3 部署流程)

# 2. 从 sg 选最新可用 dump
NEW_VM=root@<new-v3-ip>
DUMP=/var/backups/v3-commercial/kl-master/openclaude_commercial-YYYYMMDD-HHMMSSZ.dump

# 3. scp 到新 VM(用 sg 上 root 默认 ssh key,或者具体环境对应的)
scp "$DUMP" "$NEW_VM:/tmp/restore.dump"

# 4. 在新 VM 上恢复
ssh "$NEW_VM" "runuser -u postgres -- pg_restore --no-owner --no-acl -d openclaude_commercial /tmp/restore.dump"

# 5. v3 部署 + smoke,然后再把新 VM 接入 LB / 改 DNS
```

## 每月手工 DR 演练(必做,1 月 1 次)

目的:验证 sg 上的副本真的可恢复,不只是文件存在。

```bash
# 在 sg 上,选最新副本
DUMP=$(ls -1 /var/backups/v3-commercial/kl-master/*.dump | LC_ALL=C sort | tail -1)
sha256sum "$DUMP"   # 记录

# 用 docker 拉一个一次性 PG16 容器恢复
docker run --rm --name pg-drill-$$ \
  -v "$DUMP:/tmp/d.dump:ro" \
  -e POSTGRES_PASSWORD=drill \
  -d postgres:16

# 等 PG 起来
sleep 10

# 在容器里建 DB 并 restore
docker exec pg-drill-$$ psql -U postgres -c "CREATE DATABASE openclaude_commercial"
docker exec pg-drill-$$ pg_restore --no-owner --no-acl -d openclaude_commercial -U postgres /tmp/d.dump

# 关键断言:claude_accounts 在
docker exec pg-drill-$$ psql -U postgres -d openclaude_commercial \
  -c "SELECT to_regclass('public.claude_accounts')"
# 期待输出 t(或 claude_accounts oid)

# 收尾
docker stop pg-drill-$$
```

每月把演练结果写到 ops 周报或 boss IM,出错立刻排查。

## 故障排查

### 症状: pull 脚本日志反复 `FAIL(kl-master): info call failed`

可能原因:
- v3 VM SSH 端口不可达(检查防火墙、GCP firewall rule)
- backup-pull authorized_keys 被改坏(`grep ssh-ed25519 /home/backup-pull/.ssh/authorized_keys`)
- sudoers 文件被改坏(`visudo -cf /etc/sudoers.d/backup-pull`)
- v3 VM 时钟漂移导致 SSH 握手失败(罕见)

诊断顺序:
1. sg 上手工跑步骤 #3(info),看具体错
2. 在 v3 VM 上 `journalctl -u sshd -n 100 | grep backup-pull`
3. v3 VM 上 `grep backup-pull /var/log/auth.log | tail -50`

### 症状: pg-restore-test 失败告警(systemd OnFailure)

```bash
# 看 timer 上次状态
ssh root@<v3-vm> 'systemctl status pg-restore-test.service'
ssh root@<v3-vm> 'journalctl -u pg-restore-test.service -n 100'
ssh root@<v3-vm> 'tail -50 /var/log/pg-restore-test.log'
```

最常见原因: dump 文件本身损坏。立即手工跑一次 backup,然后再跑一次 restore-test 验证。

---

## 后续待执行:P0.3 sg bootstrap (2026-05-23)

**背景**:本仓代码/文档已更新成 sg 拓扑,但 sg 与 KL .236 上的 **实际 SSH bootstrap 尚未执行**(写本段时)。当前状态 = `pull-v3-backups.sh` 已合入 origin/v3 但还没装到 sg,/var/backups/v3-commercial/ 为空。

**执行模式**:LLM 在 sg 本机执行 bootstrap 全流程,但每涉及 KL prod root 写入(setup-v3-backup-pull.sh 写 sudoers/authorized_keys)前必须把 fingerprint / PULL_FROM_IP / 待写 diff 汇报给 boss,boss 确认后继续。sg 本机操作(keypair 生成 / pin host key / 装 pull script + cron)无需逐步审批 — boss 看完整汇报即可。`kl-mirror` SSH alias 视为已建立的 trusted channel。

### Prerequisite check

```bash
# 1. KL master (.236) 上必须已有 pg-backup-openclaude.timer enabled。
#    如果没装,先按上方"部署清单 → v3 VM 侧"步骤 1+ 装齐(本节假设已就绪)。
ssh kl-mirror 'systemctl is-enabled pg-backup-openclaude.timer && \
                systemctl list-timers pg-backup-openclaude.timer'
# 期待: enabled + 下次触发时间是今晚 17:15 UTC

# 2. **必做**:在 sg 本机确认真实公网出口 IP 是 38.55.252.217。
#    sg 默认路由直出,无 NAT;如果走 iproyal proxy 出口会变成 175.29.202.24,
#    那是错的,authorized_keys `from=` 必须用直出 IP。
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    -u ALL_PROXY -u all_proxy \
    curl -4 -fsS https://ifconfig.me; echo
# 期待: 38.55.252.217。
# 另外双向确认:从 sg 连 KL,KL 看到的源 IP 也应该是 38.55.252.217
ssh kl-mirror 'echo $SSH_CLIENT'   # 期待第一字段 = 38.55.252.217
```

### Bootstrap 执行步骤

```bash
# === 在 sg 本机(38.55.252.217)上 ===

# (a) 生成 backup-pull 专用 keypair
ssh-keygen -t ed25519 -f /root/.ssh/v3-backup-pull -N "" -C "sg-v3-backup-pull"
chmod 600 /root/.ssh/v3-backup-pull
chmod 644 /root/.ssh/v3-backup-pull.pub
# **汇报 boss**: 把 `ssh-keygen -lf /root/.ssh/v3-backup-pull.pub` 输出贴出来

# (b) Pin KL .236 host key(走 trusted channel `kl-mirror` SSH alias 核对!)
ssh-keyscan -t ed25519 154.193.246.236 > /root/.ssh/known_hosts.v3-pull
chmod 600 /root/.ssh/known_hosts.v3-pull
KL_SCANNED=$(ssh-keygen -lf /root/.ssh/known_hosts.v3-pull)
KL_REAL=$(ssh kl-mirror 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')
echo "scanned: $KL_SCANNED"
echo "real   : $KL_REAL"
# 两条指纹**必须**逐字符相同。不一致 = MITM / 错主机 / drift,立即停手排查。
# **汇报 boss**: 把 scanned vs real 两行贴出来,boss 确认后继续 (c)

# === 在 KL master(.236)上,走 kl-mirror SSH alias ===
# **此处涉及 KL prod root 写 sudoers + authorized_keys**,必须 boss 确认上面
# 指纹 + 下面 PULL_PUBKEY 内容后再执行。

# (c) 把刚生成的 pubkey + sg 出口 IP 喂给 setup 脚本
PUBKEY=$(cat /root/.ssh/v3-backup-pull.pub)

# **汇报 boss** —— 完整列出 setup-v3-backup-pull.sh 即将在 KL 上写入的内容,
# boss 逐字核对后再 ENTER 跑下一条 ssh 命令。脚本里 authorized_keys 行用
# `printf 'from="%s",restrict,command="..."'`,所以 IP 是双引号包裹的;
# sudoers 行也要事先展示给 boss。
echo "=== Pending writes on KL ==="
echo
echo "[A] /home/backup-pull/.ssh/authorized_keys (覆盖,0600 backup-pull:backup-pull):"
printf '  from="%s",restrict,command="/usr/local/bin/backup-pull-wrapper" %s\n' \
    "38.55.252.217" "$PUBKEY"
echo
echo "[B] /etc/sudoers.d/backup-pull (覆盖,0440 root:root):"
echo "  # M7/P1-10 — backup-pull user can run **only** the helper as root, no password."
echo "  # Wrapper passes verb as argv (\$1 in helper); we do NOT keep SSH_ORIGINAL_COMMAND"
echo "  # in env. Helper re-anchors validation."
echo "  backup-pull ALL=(root) NOPASSWD: /usr/local/bin/backup-pull-cmd"
echo
echo "[C] /usr/local/bin/backup-pull-{cmd,wrapper} (覆盖,root:root 0755) — 内容见 infra/pg-backup-pull/backup-pull-{cmd,wrapper}.sh"
echo
echo "=== Wait for boss confirm before next command ==="

ssh kl-mirror "cd /opt/openclaude/openclaude-v3 && \
    PULL_PUBKEY='$PUBKEY' PULL_FROM_IP='38.55.252.217' \
    bash infra/pg-backup-pull/setup-v3-backup-pull.sh"

# === 回到 sg 本机 ===

# (d) 部署 pull 脚本到系统路径
install -m 0755 -o root -g root \
  /opt/openclaude/openclaude-v3/infra/pg-backup-pull/pull-v3-backups.sh \
  /usr/local/bin/pull-v3-backups.sh

# (e) 装系统 cron
cat > /etc/cron.d/pull-v3-backups <<'CRON'
# M7/P1-10 — Daily SSH-pull v3 commercial PG backup to sg.
0 18 * * * root /usr/bin/flock -n /run/pull-v3-backups.lock /usr/local/bin/pull-v3-backups.sh
CRON
chmod 644 /etc/cron.d/pull-v3-backups

# (f) 跑上方"部署后烟雾测试(8 项)"。每一项 OK 才进下一项。
# **汇报 boss**: 完成后贴全 8 项结果
```

### 失败回滚(任一烟测失败,或后续日常 pull 反复失败)

**不要回 Tokyo**(.239 是 fossil snapshot,不是可用 backup 源)。回滚 = 撤销本次 bootstrap、让系统回到 "无自动 backup pull" 的预期状态,等 boss 排查根因后重做。

```bash
# 在 KL master 上撤 authorized_keys
ssh kl-mirror 'rm -f /home/backup-pull/.ssh/authorized_keys'
# 或更彻底:userdel backup-pull(setup 脚本 idempotent,后续可重装)
# ssh kl-mirror 'userdel -r backup-pull && rm -f /etc/sudoers.d/backup-pull \
#                                          /usr/local/bin/backup-pull-cmd \
#                                          /usr/local/bin/backup-pull-wrapper'

# 在 sg 上停 cron + 销毁本地 key
rm -f /etc/cron.d/pull-v3-backups
rm -f /root/.ssh/v3-backup-pull /root/.ssh/v3-backup-pull.pub /root/.ssh/known_hosts.v3-pull
# 已拉到本地的 dump 可保留(/var/backups/v3-commercial/kl-master/),它们是合法 backup。
```

KL master 本机 `/var/backups/postgres/` 14d retention 保持运行,即使 sg pull 没装,DB 损坏场景的本机恢复路径仍然可用。

> 完成后请把本节标题改成 `## 历史:P0.3 sg bootstrap (YYYY-MM-DD 完成)` 或删掉,避免下次 onboarding 误读"还没做"。
