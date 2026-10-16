# v5 selfhost PostgreSQL backup: host install (OCV5-443)

The release train does not install these units. Run the steps below once on
v5-dev after the commit carrying `scripts/v5-selfhost-pg-backup.sh` is live
(the service runs the copy under `/opt/openclaude/openclaude-v5-selfhost-live`).

## What it backs up

| tier | content | where | when |
|---|---|---|---|
| core | schema of every table + data of every table except `client_session_turn_tape_records`, `client_session_live_frames`, `client_session_turn_tape_model_records` | `/var/backups/openclaude-v5-selfhost/core-<UTC>.dump` (+ `.sha256`), newest 7 kept | daily 03:40 Asia/Taipei |
| full | whole database | piped to `V5SB_FULL_SINK` (an executable you provide, gets the file name as `$1` and the dump on stdin); nothing is written locally | same run, only when the sink is set |

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
systemctl daemon-reload
systemctl enable --now openclaude-v5-selfhost-pg-backup.timer
# first run now instead of waiting for the night (core only takes about a minute)
systemctl start openclaude-v5-selfhost-pg-backup.service
"$L/scripts/v5-selfhost-pg-backup.sh" status
```

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
