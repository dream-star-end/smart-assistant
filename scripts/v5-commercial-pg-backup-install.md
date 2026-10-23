# v5 commercial PostgreSQL backup to R2: host install (OCV5-600)

Production change on kl-mirror: every step runs under the production mutation lease
(`scripts/with-production-mutation-lease.sh`, see ocv5-release-verify), after the user said
"发". It does not touch openclaude-claude-egress, openclaude-literature-egress or the
subscription proxy and restarts no service.

## What it backs up

| what | where | when |
|---|---|---|
| whole `openclaude_commercial` (`pg_dump -Fc -Z zstd:3`) | `/var/backups/openclaude-v5-pg/full-<UTC>.dump` (+ `.sha256`), newest 2 kept | daily 04:30 Asia/Taipei |
| same dump, gpg-encrypted | R2 account 1, `ocv5-commercial-backup/pg/full/`, 1 kept (old copy deleted first) | same run |
| newest file-level backup (`/var/backups/openclaude-v5/v5-*`), tar + gpg | `ocv5-commercial-backup/files/core/core-<UTC>.dump.gpg`, 2 kept | same run |

The bucket stays under 9.5 GB (precheck, streaming abort); above 9 GB a run exits 5 and
alerts. The run skips (exit 3, alert) while a release or manual production change may be
running, and writes `/run/openclaude/pg-r2-backup.running` while it works: **releases check
that file first** (ocv5-release-verify, "发布前只读核对").

## Install (from the merged commit, without a commercial release)

The scripts run from `/opt/openclaude/pg-r2-backup/current` (a symlink to a directory named
after the merge SHA), so installing them does not depend on the next commercial release.

```bash
# v5-dev, canonical aurora tree; SHA = the merge commit
A=/opt/openclaude/openclaude-v5-aurora; SHA=<merge sha>
git -C "$A" fetch origin && git -C "$A" merge-base --is-ancestor "$SHA" origin/feat/v5-aurora-rewrite
STAGE=/root/ocv5-600-pg-r2-$SHA; install -d -m 700 "$STAGE"
git -C "$A" archive "$SHA" scripts/v5-commercial-pg-backup.sh scripts/v5-selfhost-pg-backup-r2.sh \
  deploy/v5/openclaude-v5-pg-r2-backup.service deploy/v5/openclaude-v5-pg-r2-backup.timer | tar -C "$STAGE" -x
scp -r "$STAGE" kl-mirror:/root/                          # staging copy only
# under the lease (the wrapper swallows stdin: the remote script reads the staged files)
scripts/with-production-mutation-lease.sh ssh kl-mirror "bash -s $SHA" < install-step.sh </dev/null
```

`install-step.sh` (asserts first, then acts):

```bash
SHA=$1; S=/root/ocv5-600-pg-r2-$SHA; D=/opt/openclaude/pg-r2-backup/$SHA
test -x /usr/local/bin/rclone && test -s /etc/openclaude/r2-rclone.conf
GNUPGHOME=/etc/openclaude/backup-gpg gpg --batch --list-keys >/dev/null
test "$(GNUPGHOME=/etc/openclaude/backup-gpg gpg --batch --list-secret-keys | wc -l)" = 0
install -d -m 755 "$D"
install -m 755 "$S/scripts/v5-commercial-pg-backup.sh" "$S/scripts/v5-selfhost-pg-backup-r2.sh" "$D/"
ln -sfn "$D" /opt/openclaude/pg-r2-backup/current.new && mv -T /opt/openclaude/pg-r2-backup/current.new /opt/openclaude/pg-r2-backup/current
install -m 644 "$S/deploy/v5/openclaude-v5-pg-r2-backup.service" "$S/deploy/v5/openclaude-v5-pg-r2-backup.timer" /etc/systemd/system/
# /etc/openclaude/pg-r2-backup.env (0600):
#   V5SB_R2_GPG_RECIPIENT=<fingerprint>
#   V5SB_R2_GPG_HOME=/etc/openclaude/backup-gpg
#   V5SB_R2_RCLONE_CONF=/etc/openclaude/r2-rclone.conf
systemctl daemon-reload
systemctl enable openclaude-v5-pg-r2-backup.timer   # first run by hand below, then the timer takes over
```

First run by hand (under the lease is not needed for the dump itself, but the run must not
overlap a release; it checks that itself), then check R2 usage:

```bash
systemctl start openclaude-v5-pg-r2-backup.service; systemctl show -p Result,ExecMainStatus openclaude-v5-pg-r2-backup.service
/opt/openclaude/pg-r2-backup/current/v5-commercial-pg-backup.sh status
V5SB_R2_REMOTE=r2:ocv5-commercial-backup /opt/openclaude/pg-r2-backup/current/v5-selfhost-pg-backup-r2.sh usage
systemctl start openclaude-v5-pg-r2-backup.timer
```

## Roll back

`systemctl disable --now openclaude-v5-pg-r2-backup.timer`; remove the two units,
`/opt/openclaude/pg-r2-backup`, `/etc/openclaude/pg-r2-backup.env`. Nothing else depends on
them; no service is affected.

## Restore

Local: `pg_restore --list /var/backups/openclaude-v5-pg/full-<UTC>.dump | head`, then restore
into a new database and switch only with the user's approval. From R2: download
`pg/full/<name>.gpg`, decrypt with the private key (kept off the servers), then the same.
