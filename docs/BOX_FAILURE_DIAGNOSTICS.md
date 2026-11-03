# Box failure diagnostics (selfhost)

## Scope and limits

This is observability, not a fix for every upstream failure. It preserves a sanitized
failure snapshot before destructive privacy cleanup, so a late transport exception
does not hide already-known worker failure. It cannot reconstruct incidents cleaned
before this version was installed, and unknown evidence remains explicitly unknown.

- Supervisor emits a strict v1 metadata-only snapshot in its existing private proof
  directory. The terminal proof schema and its execution/billing authority do not change.
- Only fixed categories, numeric status/exit codes, counters, flags, and validated
  identifiers are persisted. No raw stderr, prompt, user text, tokens, URL, or stack.
- Nonstream same-call fallback explains settled failures as `BOX_REPLAY_FAILED`,
  `BOX_REPLAY_STOPPED`, or `BOX_REPLAY_RESULT_REJECTED`. Existing identity, user,
  authority, chain, and ambiguity checks remain in force. It never launches a model,
  reserves credit, or writes billing/usage to manufacture a diagnostic.
- `worker_failed` is terminal evidence, not a complete root cause. Remote
  `upstreamCode`/HTTP status are classified observations, not guaranteed explanations.
  E.g. `unknown` plus exit 1 must not be reported as proven authentication failure.

## Collection and cleanup

The master cleanup worker, egress tool cleanup, and detached text cleanup all use the
same pre-cleanup hook. Successful runs do not collect failure records. Collection is
bounded by 6 seconds; the remote read has its own 2.5-second timeout. Failure to
collect/persist never blocks privacy cleanup. When unavailable, the log includes the
request and a fixed status; a diagnostic ID in a log alone is not proof the file exists.

Raw run contents are still deleted. Only this component's exact remote diagnostic
filenames are additionally deleted; terminal proof, stop proof and replay-fence
tombstones keep their existing behavior.

Central data lives in `box-failure-diagnostics`, a sibling of the configured replay
directory (resolved by `boxReplayDirectory`, including `OC_BOX_REPLAY_DIR`).
It is private to the service OS user (directory 0700, records 0600).
No new feature flag or database migration is required.

Retention is a bounded cache, **not guaranteed seven-day archival**:
records are at most 8 KiB, with 2048 hashed slots. Slot collisions can evict earlier.
Records expire after seven days; readers reject expired data immediately. Existing
idle cleanup ticks physically reclaim expired slots incrementally (64 per sweep),
even without another failure. One shared temporary file is at most 8 KiB and the permanent kernel-lock file is empty;
total managed payload is at most 16 MiB + 8 KiB (filesystem metadata excluded).
Writes and physical GC use the same kernel lock, with 250 ms bounded lock wait and
a 2-second subprocess deadline; a crash cannot strand a held kernel lock.
If cleanup scheduling is disabled, physical deletion waits until it resumes; reads
still enforce expiry. Snapshot/storage failures or eviction must remain
`not_found`, not be interpreted as success.

## Read-only inspection

Run on the actual selfhost host as the service OS user. Do not inspect the container
source snapshot or another instance. Use the current release/worktree source and an
explicit absolute diagnostic directory:

```bash
./node_modules/.bin/tsx scripts/ocv5-289/box_failure_inspect.ts \
  --directory /ABSOLUTE/STATE/box-failure-diagnostics \
  --uid 3 --request-id REQUEST_ID

./node_modules/.bin/tsx scripts/ocv5-289/box_failure_inspect.ts \
  --directory /ABSOLUTE/STATE/box-failure-diagnostics \
  --id bdiag_0123456789abcdef01234567
```

This administrative CLI does not contact Box/DB, start a run, create the directory,
or mutate the store. ID lookup reads a single fixed slot; uid+request lookup scans
only the 2048 known slots, validating identity, schema, ownership, mode and expiry.
It is an OS-private admin entry, not a user-facing authorization API.

Exit 0 = matching evidence, 3 = absent/expired/evicted/unreadable, 2 = invalid arguments
or inspection failure. No match is not proof of successful execution.
Transport observations remain in egress logs, not in the snapshot. Query those logs
by the same request ID and timestamp; the inspector alone does not contain a network
root cause.
Correlate the original request/nonce with the terminal record first, then this
snapshot, then later transport observations. Never substitute the latter for the former.

## Validation and rollout

Targeted tests cover strict poison rejection, real subprocess failure -> snapshot ->
actual privacy cleanup -> fresh-reader recovery, HTTP fallback without launch/billing,
timeouts/store errors, idle TTL, and cross-process cache safety. New `*.test.ts`
files enter existing commercial unit discovery; run commercial tests through
`scripts/test-mutex.sh commercial`.

Deployment affects both master and egress, plus shipped supervisor/keeper assets.
No runtime-image rebuild is intended by these source-only changes; the local store
uses the existing Linux Python 3 runtime. Follow the selfhost release workflow.
Implementation/targeted test success is not a deployed status: full gates, protected
integration, official release and post-release smoke are separate steps.
