# Commercial PostgreSQL backup to R2 — host installation (OCV5-600)

User 2026-10-23 15:12 approved plan A: v5-dev schedules the job; the existing official
production mutation lease covers the complete foreground job on kl-mirror. No application
or subscription egress service is restarted. Account 1 credentials stay only on kl-mirror;
the private gpg key never leaves Box/user custody.

## Runtime

- v5-dev: `openclaude-v5-pg-r2-backup.timer`, daily 04:30 Asia/Taipei. Its service calls
  `scripts/v5-commercial-pg-backup-controller.sh` from the pinned installed bundle. Failure
  uses the already installed `openclaude-v5-selfhost-watch-alert@` on this host.
- The controller uses the unchanged `with-production-mutation-lease.sh`, then foreground
  `ssh -tt kl-mirror`. It constructs the invocation nonce only inside the wrapped child;
  neither it nor credentials are logged. The lease covers dump, local rotation and uploads.
  The SSH payload applies nice 15 and idle I/O on kl-mirror itself, so the remote worker
  and its children retain the intended low priority after scheduling moves to v5-dev.
- kl-mirror: only the pinned scripts and R2/public-key configuration. No new timer/service.
  `v5-commercial-pg-backup-lease.ts` imports the existing `verifyLocalLease` authority;
  it checks nonce, actual flock/holder/expiry and PG identity, then compares the dump's
  Unix-socket cluster/database/epoch. Role credentials reach psql only through PG environment.
- Remote execution has an independent guardian and a gated body process group. Every
  qualification is killed after five seconds. Lost proof, a dead supervisor or an unexpected
  guardian exit kills the owned body group. A Python waiter retains an exited body leader
  with WNOWAIT until it kills remaining descendants, then reaps it; killing only the body
  shell therefore cannot release the lease while an orphan dump continues. This prevents a half-open command SSH leaving a
  long-running dump. It reuses the official lease's failure contract; it does not add a new
  lease protocol or promise zero scheduling latency after an externally killed holder.
- Recovery markers are checked under `/opt/openclaude/openclaude-v5-releases`.
  `/run/openclaude/pg-r2-backup.running` remains informational for operators.

The whole `openclaude_commercial` dump is local under `/var/backups/openclaude-v5-pg`, newest
2 kept; encrypted R2 `pg/full/` keeps 1, deleting the previous full first. The newest
file-level backup is tarred/encrypted to `files/core/`, newest 2 kept. The shared R2 helper
retains its 9.5 GB cap, multipart cleanup and warning above 9 GB. Before first installation,
check measured full size + file-copy rotation peak + all other account-1 buckets. Forecast
above 10 GB requires reporting and stopping; do not rely only on a per-bucket check.

## Prepare the exact merged bundle on v5-dev

After default Codex review and required CI pass, merge the approved PR and take its precise
merge SHA. Archive these files into `/root/ocv5-600-pg-r2-<sha>`:

- `scripts/v5-commercial-pg-backup{,-controller}.sh`
- `scripts/v5-commercial-pg-backup-lease.ts`
- `scripts/v5-selfhost-pg-backup-r2.sh`
- `scripts/lib/v5-commercial-backup-supervisor.sh` and `v5-commercial-backup-waiter.py`
- unchanged `scripts/with-production-mutation-lease.sh`, `scripts/lib/v5-mutation-admission.sh`
- unchanged `ops/ocv5-308/model-release-operator.ts`
- `deploy/v5-dev/openclaude-v5-pg-r2-backup.{service,timer}`

Keep this directory layout (the validator imports the existing operator). Both hosts install
under `/opt/openclaude/pg-r2-backup/<sha>`, with `current` pointing to that immutable bundle.
Confirm `/root/.bun/bin/bun`, `timeout`, `runuser`, `psql`, gpg and rclone are available on
kl-mirror; no npm dependency installation is needed for the validator's type-only pg import.

## Apply (production changes require the approved “发”)

All writes/copies to kl-mirror run inside the canonical tree's existing
`scripts/with-production-mutation-lease.sh`. Check stable/candidate empty, actual recovery
markers absent, backup not running, and record service PID/NRestarts before and after.
First stage the bundle and an installation script on the remote host. Then call that script
by its remote pathname under the lease. The wrapper consumes stdin: never combine
`bash -s < install-step.sh` with this wrapper or append `</dev/null` over that input.

On kl-mirror:

1. Account-1 rclone configuration and public key must already be installed according to
   KLMIRROR-R2-COMMANDS; confirm the keyring has no secret keys.
2. Install the reviewed bundle in `/opt/openclaude/pg-r2-backup/<sha>`; atomically replace
   `current` via a temporary symlink. Install no PG-R2 systemd units on this host.
3. Write `/etc/openclaude/pg-r2-backup.env` root-owned 0600: `V5SB_R2_GPG_RECIPIENT`,
   `V5SB_R2_GPG_HOME=/etc/openclaude/backup-gpg`,
   `V5SB_R2_RCLONE_CONF=/etc/openclaude/r2-rclone.conf`.
   `/etc/openclaude/commercial-v5.env` is only read by the trusted qualification subprocess;
   do not copy or print it.

On v5-dev:

1. Install the exact pinned bundle; the controller resolves the unchanged official wrapper
   and admission helper from this bundle. It uses the existing kl-mirror SSH alias.
2. Install the two units from `deploy/v5-dev/`, `systemctl daemon-reload`, and enable the timer
   without starting a backup. The local alert template must be loaded.
3. After the 21:00 size measurement/capacity check, run the new service once from v5-dev;
   inspect its Result/ExecMainStatus, remote backup status and account-1 R2 usage. Start the
   timer after this succeeds. Do not start manual work in the 00:00–06:00 quiet window.

The failure alert is intentionally sent from v5-dev because that is where this systemd job
runs. Its journal is also there; remote backup status remains on kl-mirror.

## Rollback / restore

Disable/stop only `openclaude-v5-pg-r2-backup.timer` on v5-dev. If a run is active, stop its
controller service and verify its remote body is gone before removing any installation.
Do not restart application/egress units. Remove installed files only with the user's approval.

Local/R2 restore drills remain deferred by the user. Decrypt off-server with the private key,
then use `pg_restore` into a new isolated database only after a separate restore approval.
