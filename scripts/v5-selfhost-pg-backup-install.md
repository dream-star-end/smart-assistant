# v5 selfhost PostgreSQL backup: host install (OCV5-443)

The release train does not install these units. Run the steps below once on
v5-dev after the commit carrying `scripts/v5-selfhost-pg-backup.sh` is live
(the service runs the copy under `/opt/openclaude/openclaude-v5-selfhost-live`).

## What it backs up

| tier | content | where | when |
|---|---|---|---|
| core | schema of every table + data of every table except `client_session_turn_tape_records`, `client_session_live_frames`, `client_session_turn_tape_model_records` | `/var/backups/openclaude-v5-selfhost/core-<UTC>.dump` (+ `.sha256`), newest 7 kept; with `V5SB_OFFSITE` also encrypted to R2 `pg/core/`, newest 7 kept | daily 03:40 Asia/Taipei (`openclaude-v5-selfhost-pg-backup.timer`) |
| full | whole database | streamed to the off-host sink: `V5SB_OFFSITE` (R2, below) or `V5SB_FULL_SINK` (an executable you provide, gets the file name as `$1` and the dump on stdin); nothing is written locally | weekly, Sunday 21:10 Asia/Taipei (`openclaude-v5-selfhost-pg-backup-full.timer`, OCV5-600) |

Both units hold a shared lock on the selfhost deploy lock for the whole run, so
a release train waits for a running backup (deploy waits up to 40 min) instead
of queueing its migration DDL behind the dump's table locks.

Without a sink the core tier still protects identity, billing, usage, catalog,
settings and audit data. Chat content (the tape tables) is only protected once
a full sink is configured. On 2026-10-16 a full zstd dump was estimated at
about 7.5 GB, which does not fit on the local disk next to the 8 GiB release gate.

Status: `scripts/v5-selfhost-pg-backup.sh status` (JSON, also at
`/var/lib/openclaude-v5-selfhost/pg-backup-status.json`). Non-zero exits go
through `openclaude-v5-selfhost-watch-alert@`.

## Install

```bash
L=/opt/openclaude/openclaude-v5-selfhost-live
test -x "$L/scripts/v5-selfhost-pg-backup.sh"
install -m 644 "$L/deploy/v5-selfhost/openclaude-v5-selfhost-pg-backup.service" /etc/systemd/system/
install -m 644 "$L/deploy/v5-selfhost/openclaude-v5-selfhost-pg-backup.timer" /etc/systemd/system/
install -m 644 "$L/deploy/v5-selfhost/openclaude-v5-selfhost-pg-backup-full.service" /etc/systemd/system/
install -m 644 "$L/deploy/v5-selfhost/openclaude-v5-selfhost-pg-backup-full.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now openclaude-v5-selfhost-pg-backup.timer
# only once the off-host sink below is configured; without it the full tier reports "unconfigured"
systemctl enable --now openclaude-v5-selfhost-pg-backup-full.timer
# first run now instead of waiting for the night (core only takes about a minute)
systemctl start openclaude-v5-selfhost-pg-backup.service
"$L/scripts/v5-selfhost-pg-backup.sh" status
```

## Off-host copies on Cloudflare R2 (OCV5-600)

`scripts/v5-selfhost-pg-backup-r2.sh` encrypts each copy to a gpg public key and
streams it with rclone into bucket `ocv5-personal-backup` (its own R2 account,
free tier 10 GB). Every write keeps the bucket under `V5SB_R2_CAP_BYTES`
(9.5e9): the old full copy is deleted **before** the new one is uploaded (two
would not fit; there is a short window without an off-host full), a precheck
skips the dump when the estimate (last upload scaled by database growth) does
not fit, and the upload is killed before it completes once the stream passes
the cap. A bucket above `V5SB_R2_WARN_BYTES` (9e9) after a write exits 5 and
alerts: raise `V5SB_FULL_COMPRESS` first (e.g. `zstd:9`); if that is not
enough, escalate (moving the full copy elsewhere needs the user).

One-time setup (root). Credential values never go to argv, logs or stdout:

```bash
# rclone, a pinned release checked against its SHA256SUMS
# account-2 credentials, copied from the operator box over stdin into /etc/openclaude/r2/ (0700, files 0600):
#   account-id, access-key-id, secret-access-key
install -m 600 /dev/null /etc/openclaude/r2-rclone.conf
python3 -I - /etc/openclaude/r2 /etc/openclaude/r2-rclone.conf <<'EOF_PY'
import sys, pathlib
d, out = pathlib.Path(sys.argv[1]), sys.argv[2]
r = lambda n: (d / n).read_text().strip()
open(out, "w").write(
  "[r2]\ntype = s3\nprovider = Cloudflare\n"
  f"access_key_id = {r('access-key-id')}\nsecret_access_key = {r('secret-access-key')}\n"
  f"endpoint = https://{r('account-id')}.r2.cloudflarestorage.com\nno_check_bucket = true\n")
EOF_PY
# public key only (the private key is kept off this host)
install -d -m 700 /etc/openclaude/backup-gpg
GNUPGHOME=/etc/openclaude/backup-gpg gpg --batch --import ocv5-backup-pubkey.asc
# /etc/openclaude/selfhost-pg-backup.env (0600):
#   V5SB_OFFSITE=/opt/openclaude/openclaude-v5-selfhost-live/scripts/v5-selfhost-pg-backup-r2.sh
#   V5SB_R2_GPG_RECIPIENT=<fingerprint>
"$L/scripts/v5-selfhost-pg-backup-r2.sh" usage   # read-only: bucket inventory
```

Status: `coreOffsite` and `full` in the status JSON; the last full upload's size
is in `/var/lib/openclaude-v5-selfhost/pg-backup-r2.json`.

Restore from R2 needs the private key (off this host):
`rclone copyto r2:ocv5-personal-backup/pg/full/<name>.gpg <file>.gpg`, then
`gpg --decrypt <file>.gpg > <file>` on a machine holding the key, then the steps
in "Restore for real".

## Restore drill

Restores the newest core dump into a scratch database
(`openclaude_v5_selfhost_restore_drill`), compares row counts of a few key
tables with the live database, and drops the scratch database. It refuses to
run if the scratch database already exists. Needs roughly the core size again
in free space while it runs.

```bash
/opt/openclaude/openclaude-v5-selfhost-live/scripts/v5-selfhost-pg-backup.sh drill
```

## Restore for real (core)

Only with the user's approval, with master stopped and no train running:

```bash
pg_restore --list /var/backups/openclaude-v5-selfhost/core-<UTC>.dump | head   # check first
# restore into a new database, check it, then switch DATABASE_URL; never restore over the live DB in place
```

## Optional env (`/etc/openclaude/selfhost-pg-backup.env`, root 0600)

`V5SB_FULL_SINK`, `V5SB_KEEP` (7), `V5SB_MIN_FREE_GIB` (10), `V5SB_ABORT_FREE_GIB` (9),
`V5SB_DIR`, `V5SB_COMPRESS` (`zstd:3`), `V5SB_DEPLOY_WAIT_SEC` (3600).
Off-host (OCV5-600): `V5SB_OFFSITE`, `V5SB_FULL_COMPRESS` (= `V5SB_COMPRESS`),
`V5SB_R2_GPG_RECIPIENT` (required), `V5SB_R2_REMOTE` (`r2:ocv5-personal-backup`),
`V5SB_R2_PREFIX` (`pg`), `V5SB_R2_RCLONE_CONF` (`/etc/openclaude/r2-rclone.conf`),
`V5SB_R2_GPG_HOME` (`/etc/openclaude/backup-gpg`), `V5SB_R2_CAP_BYTES` (9500000000),
`V5SB_R2_WARN_BYTES` (9000000000), `V5SB_R2_CORE_KEEP` (7), `V5SB_R2_FULL_EST_BYTES`
(0 = unknown until the first upload).
