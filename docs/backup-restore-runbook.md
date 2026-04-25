# PG Backup & Restore Runbook (M7 / P1-10)

最后更新: 2026-04-25

## 备份架构

```
[v3 commercial VM (GCE Tokyo)]            [45.32 (Vultr Tokyo, OpenClaude personal)]
  /usr/local/bin/pg-backup-openclaude.sh   /usr/local/bin/pull-v3-backups.sh
    daily 17:15 UTC via systemd timer        daily 18:00 UTC via /etc/cron.d/pull-v3-backups
    runuser -u postgres -- pg_dump -Fc       SSH backup-pull@v3 info → fetch=<basename>
    -> /var/backups/postgres/                sha256/size verify
       openclaude_commercial-YYYYMMDD-HHMMSSZ.dump
    14d retention                          -> /var/backups/v3-commercial/v3-staging/
                                              30d retention
  /usr/local/bin/pg-restore-test.sh
    Sun 03:00 UTC via systemd timer
    runuser -u postgres -- pg_restore --no-owner --no-acl
    into throwaway DB, asserts claude_accounts present
```

恢复点目标(RPO)≤ 24h(每日一次 dump + pull)。
恢复时间目标(RTO)≤ 30min(从 45.32 scp 回 + pg_restore + service restart)。

## 跨云 DR 矩阵

| 灾难场景 | 恢复路径 |
|---------|---------|
| v3 VM 数据库损坏(可登录) | 本机 `/var/backups/postgres/` 14d 之内任一 dump → `pg_restore` |
| v3 VM 整机丢失或不可达 | 从 45.32 `/var/backups/v3-commercial/v3-staging/` 30d 之内任一 dump → 新 VM `pg_restore` |
| 45.32 整机丢失 | v3 VM 本机 14d dump 仍在,推迟设置新集中点不影响日常 |
| **双机同时损坏** | **数据丢失,RPO 不可避**(本期不覆盖,见 Limitations) |

## Limitations(必读)

1. **45.32 是临时集中收集点,不是独立备份系统**
   - 45.32 同时承载 OpenClaude 个人版,运维平面与备份目的地耦合
   - 真正的独立 backup-only 设施需要专建一台只跑 sshd + cron 的 VPS,本期未做
   - 长期演进:加第二个 pull target(例如 AWS/Cloudflare R2 / 另一家 VPS),让 pull 脚本同时推送两份

2. **pull 失败多日恢复后只拉当日最新,不补中间缺口**
   - 若 pull 5 天连续失败,第 6 天恢复 → 只拿到第 6 天的 dump(45.32 侧)
   - 中间 5 天的恢复点仍在 v3 VM 本机的 14d 保留中(只要 VM 还活着)
   - 若 v3 VM 在这 5 天里丢了 → 数据丢 5 天

3. **restore-test 只在 v3 VM 本机跑,不验证 45.32 副本可恢复**
   - v3 VM 上的周日 03:00 UTC drill 只验证"本机 dump 可恢复"
   - **每月手工演练(必做)**: 从 45.32 上的副本拉一份 dump 到测试环境,跑 `pg_restore --list` 验证可读
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
#    需要先在 45.32 生成 ed25519 keypair 并取得 pubkey 单行字符串
PULL_PUBKEY="ssh-ed25519 AAAA... 45.32-pull" \
PULL_FROM_IP="45.32.41.166" \
bash infra/pg-backup-pull/setup-v3-backup-pull.sh

# 3. 部署 restore-test 脚本
install -m 0755 -o root -g root \
  scripts/pg-restore-test.sh /usr/local/bin/pg-restore-test.sh

# 4. 部署 systemd 单元
install -m 0644 -o root -g root \
  infra/systemd/pg-restore-test.service /etc/systemd/system/pg-restore-test.service
install -m 0644 -o root -g root \
  infra/systemd/pg-restore-test.timer /etc/systemd/system/pg-restore-test.timer
systemctl daemon-reload
systemctl enable --now pg-restore-test.timer

# 5. 验证 timer 在排队
systemctl list-timers pg-restore-test.timer
```

### 45.32 侧

```bash
# 1. 生成专用 backup-pull keypair(无 passphrase,机器自动用)
ssh-keygen -t ed25519 -f /root/.ssh/v3-backup-pull -N "" -C "45.32-v3-backup-pull"
chmod 600 /root/.ssh/v3-backup-pull
chmod 644 /root/.ssh/v3-backup-pull.pub

# 2. Pin v3 VM host key(防 MITM,必做)
#    人工确认指纹:ssh 到 v3 VM 当 root 跑 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
#    与下面 ssh-keyscan 输出对照
ssh-keyscan -t ed25519 34.146.172.239 > /root/.ssh/known_hosts.v3-pull
chmod 600 /root/.ssh/known_hosts.v3-pull
ssh-keygen -lf /root/.ssh/known_hosts.v3-pull   # 显示指纹,与 v3 VM 上的应一致

# 3. 部署 pull 脚本
install -m 0755 -o root -g root \
  /opt/openclaude/openclaude-v3/infra/pg-backup-pull/pull-v3-backups.sh \
  /usr/local/bin/pull-v3-backups.sh

# 4. 部署 cron(注意是 system cron,不是 OpenClaude cron.yaml)
cat > /etc/cron.d/pull-v3-backups <<'CRON'
# M7/P1-10 — Daily SSH-pull v3 commercial PG backup to 45.32 (cross-cloud cold copy).
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
   与从 GCE serial console / 单独 ssh 看到的一致。

3. **info 协议**
   ```bash
   ssh -i /root/.ssh/v3-backup-pull \
       -o StrictHostKeyChecking=yes \
       -o UserKnownHostsFile=/root/.ssh/known_hosts.v3-pull \
       -o BatchMode=yes \
       -o IdentitiesOnly=yes \
       backup-pull@34.146.172.239 info
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
   ls -la /var/backups/v3-commercial/v3-staging/
   ```
   日志应有 `OK(v3-staging): pulled ...`。

7. **故意失败,验证 Telegram 告警**
   v3 VM 上临时改 backup-pull-cmd 让 info 返回 ERR:
   ```bash
   # On v3 VM
   sudo mv /usr/local/bin/backup-pull-cmd /usr/local/bin/backup-pull-cmd.bak
   sudo touch /usr/local/bin/backup-pull-cmd && sudo chmod 0755 /usr/local/bin/backup-pull-cmd
   echo '#!/bin/sh' | sudo tee /usr/local/bin/backup-pull-cmd
   echo 'echo "ERR: forced"; exit 99' | sudo tee -a /usr/local/bin/backup-pull-cmd
   ```
   45.32 上跑 pull 脚本,应:
   - log 出现 `FAIL(v3-staging)`
   - `/var/backups/v3-commercial/v3-staging/.pull-failed` 出现
   - Telegram 收到 `[v3-backup-pull] FAIL v3-staging: ...`

8. **恢复后 RECOVERED 告警**
   恢复 v3 VM 上的 backup-pull-cmd,再跑 pull 脚本:
   - `.pull-failed` marker 应被删除
   - Telegram 收到 `[v3-backup-pull] RECOVERED v3-staging: pulled ...`

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

### 场景 B: v3 VM 整机丢失,从 45.32 副本恢复

```bash
# 1. 在新 VM 上准备 PG16 + openclaude_commercial DB(空库)
#    省略具体步骤(标准 v3 部署流程)

# 2. 从 45.32 选最新可用 dump
NEW_VM=root@<new-v3-ip>
DUMP=/var/backups/v3-commercial/v3-staging/openclaude_commercial-YYYYMMDD-HHMMSSZ.dump

# 3. scp 到新 VM
scp -i /root/.ssh/google_compute_engine "$DUMP" "$NEW_VM:/tmp/restore.dump"

# 4. 在新 VM 上恢复
ssh "$NEW_VM" "runuser -u postgres -- pg_restore --no-owner --no-acl -d openclaude_commercial /tmp/restore.dump"

# 5. v3 部署 + smoke,然后再把新 VM 接入 LB / 改 DNS
```

## 每月手工 DR 演练(必做,1 月 1 次)

目的:验证 45.32 上的副本真的可恢复,不只是文件存在。

```bash
# 在 45.32 上,选最新副本
DUMP=$(ls -1 /var/backups/v3-commercial/v3-staging/*.dump | LC_ALL=C sort | tail -1)
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

### 症状: pull 脚本日志反复 `FAIL(v3-staging): info call failed`

可能原因:
- v3 VM SSH 端口不可达(检查防火墙、GCP firewall rule)
- backup-pull authorized_keys 被改坏(`grep ssh-ed25519 /home/backup-pull/.ssh/authorized_keys`)
- sudoers 文件被改坏(`visudo -cf /etc/sudoers.d/backup-pull`)
- v3 VM 时钟漂移导致 SSH 握手失败(罕见)

诊断顺序:
1. 45.32 上手工跑步骤 #3(info),看具体错
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
