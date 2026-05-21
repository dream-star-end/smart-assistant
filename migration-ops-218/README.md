# 218 hot standby — KL primary (154.193.246.236) → 218 (154.193.246.218)

This directory ships the playbook + sync infrastructure for the 218 KL hot
standby. The standby is **VM-level DR only** — same datacenter, same ASN
(AS154376 Cloudvalley Sdn. Bhd.), same /24 — so it protects against single-VM
failure, kernel panic, accidental rm, postgres corruption, but **not**
datacenter / AS / vendor-account loss.

## Layout

| File | Where it runs | Purpose |
|---|---|---|
| `../scripts/sync-218-standby.sh` | KL primary (236) | Push runtime state to 218 |
| `sync-218-fast.{service,timer}` | KL primary | systemd timer: 1-min sessions+config push |
| `sync-218-full.{service,timer}` | KL primary | systemd timer: 5-min volumes+uploads push |
| `verify-standby-218.sh` | 218 | Health probe — pg lag, ufw, openclaude inactive, sessions freshness |
| `verify-standby-218.{service,timer}` | 218 | systemd timer: 5-min probe → `/var/log/standby-health.log` |
| `switchover-to-218.sh` | 218 | Promote 218 to v3 master |

## Install (one-shot, after Phase 0-4 are done)

### On KL primary (154.193.246.236)

```bash
# 1) ensure scripts arrive via deploy-v3.sh's regular rsync of /opt/openclaude/openclaude/
# 2) install systemd timers
install -m 0644 /opt/openclaude/openclaude/migration-ops-218/sync-218-fast.service /etc/systemd/system/
install -m 0644 /opt/openclaude/openclaude/migration-ops-218/sync-218-fast.timer   /etc/systemd/system/
install -m 0644 /opt/openclaude/openclaude/migration-ops-218/sync-218-full.service /etc/systemd/system/
install -m 0644 /opt/openclaude/openclaude/migration-ops-218/sync-218-full.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sync-218-fast.timer sync-218-full.timer
```

### On 218 (154.193.246.218)

```bash
# 1) playbook + probe scripts to /opt/openclaude/migration-ops/
install -m 0755 /opt/openclaude/openclaude/migration-ops-218/verify-standby-218.sh   /opt/openclaude/migration-ops/
install -m 0755 /opt/openclaude/openclaude/migration-ops-218/switchover-to-218.sh    /opt/openclaude/migration-ops/

# 2) probe timer
install -m 0644 /opt/openclaude/openclaude/migration-ops-218/verify-standby-218.service /etc/systemd/system/
install -m 0644 /opt/openclaude/openclaude/migration-ops-218/verify-standby-218.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now verify-standby-218.timer
```

## Sentinel protocol (mutex sync ⇄ failover)

Both sync and switchover take `/var/lock/v3-218-sync.lock` on 218 inside an
atomic flock block. They write opposite sentinels:

- `/opt/openclaude/migration-ops/STANDBY_SYNCING`   — sync claims this; switchover refuses
- `/opt/openclaude/migration-ops/STANDBY_PROMOTING` — switchover claims this; sync refuses

The flock + atomic check-and-set is what closes the TOCTOU window a plain
sentinel file check would leave open.

## Failover playbook (boss-driven)

```bash
# On 218:
ssh kl-standby   # 45.32 → 218 alias

# Dry run first (no --yes-really-switch):
/opt/openclaude/migration-ops/switchover-to-218.sh

# Real:
/opt/openclaude/migration-ops/switchover-to-218.sh --yes-really-switch

# If KL primary is truly dead (DC fire / network gone):
/opt/openclaude/migration-ops/switchover-to-218.sh --force --yes-really-switch
```

Then in CF dashboard for zone `claudeai.chat`: change A record to
`154.193.246.218`. CF edge propagation takes 30-60s; expect users to see the
old primary's 503 page during that window.

## ufw bridge rule (must be set BEFORE failover)

After `docker network create openclaude-v3-net` runs on 218 (i.e. once at
container provisioning), grab the bridge interface and add it to ufw:

```bash
BRIDGE_IF=$(docker network inspect openclaude-v3-net --format 'br-{{.Id}}' | cut -c1-15)
sed -i "/^-A ufw-before-input -i lo -j ACCEPT/a \
# OpenClaude v3: allow docker bridge -> host (container -> 172.30.0.1:18791 anthropic relay)\n\
-A ufw-before-input -i $BRIDGE_IF -j ACCEPT" /etc/ufw/before.rules
ufw reload
```

Without this rule, host `INPUT DROP` will silently drop container → relay
traffic and the UI will show "未收到回复" after every turn. This was the
exact bug we hit during the Tokyo→KL switchover (see
`v3_kl_ufw_bridge_input.md` memory).

`verify-standby-218.sh` checks this rule on every probe tick.

## Reverting (218 → KL after a failover)

After a switchover-to-218, KL becomes the stale ex-master with no streaming
replication. To revert you need to rebuild KL as a fresh standby (pg
basebackup from 218, all volume rsync etc) — symmetric to how we built 218
in the first place. There is no "switchover-back-to-236.sh" because the
post-failover KL state is too divergent for a quick reverse promote.
