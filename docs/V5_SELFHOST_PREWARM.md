# Selfhost tip artifact prewarm (P1)

The lease worker's idle tick fetches `origin/feat/v5-selfhost` and starts a dedicated transient
`oc-v5-selfhost-prewarm-<lock-path-hash>.service`. It runs `--prewarm-artifacts --target-sha=<tip>`
with Nice=15, CPUWeight/IOWeight=1, a 20 minute limit and KillMode=control-group. No new timer or
installed unit is needed. `OC_V5_SELFHOST_PREWARM=0` on the worker disables speculative starts.
The current driver must match the tip's build recipes; an older canonical driver defers warming
until aligned. Each exact SHA gets at most three build attempts, with 30 then 60 minutes between
starts. A fully ready tip is not rebuilt; interruption consumes an attempt too. A new SHA resets
the allowance; invalid attempt state refuses speculation. No ride is
registered, no migration runs or train gate receipt is produced, and no live/env/platform pointer is changed.

Admission reads the lease DB with `sqlite3 -readonly`: any open selfhost train, registered/granted
lease, read failure, held deploy lock, unresolved release policy or busy host means no build.
The dedicated prewarm flock is held throughout. The official deploy lock is only probed briefly,
then released before construction. A worker planning a train, or an ordinary direct deployment,
first holds the official lock, stops the dedicated prewarm cgroup, and proves the prewarm flock
is released. Only then can a train become planned or start work. A service racing that handoff
cannot pass its official-lock probe. A stop failure defers/fails the train; it never permits overlap.

The private cache is `/var/lib/openclaude-v5-selfhost/artifact-cache`:

- Runtime: one `runtime/rel-<digest>` plus a receipt binding exact SHA, immutable image ID, Node/Bun,
  build recipes and full artifact digest. `depsCacheKey` and `ccbDistKey` are the existing builders'.
  Publication checks source, capabilities, full digest, sampled manifest and MCP leaves before
  issuing the receipt. A web retry retains an independently reverified private runtime artifact.
  Cold runtime dependencies are deliberately deferred to the train: cancelling a Docker client
  cannot prove its daemon-owned npm-install container stopped. The warm invocation refuses that
  installer even if a donor disappears during the build.
- Web: one `web-<web_key>` with dist, the existing reuse record and a full digest seal. The official
  npm build command is retained; both build recipes are in the shared content/environment key. This bucket has no master
  sources/dependencies/metadata and cannot pass E1 as a release.
- Scratch: one `.work`; stale private scratch and obsolete buckets are removed under the prewarm
  guard. No private cache cleanup traverses official releases, live pointers or Docker containers.
- Attempt: one atomic schema-2 `attempt.json` records SHA, count, retry deadline, phase, runtime/web
  outcomes and actual exit codes. Ordinary EXIT removes scratch and unverified runtime output,
  retaining verified partial success. Runtime failure followed by web success still exits nonzero
  and records `partial`. A hard kill leaves `running`, counted against the same budget; the next
  admitted invocation cleans its scratch. Old schema-1 attempt state upgrades once. Journal lines
  explain admission refusal, attempt start and outcome without recording environment values.

Prewarm requires 12 GiB and 500k free inodes at startup. A one-second watchdog kills only its own
verified systemd cgroup below 9 GiB / 300k inodes, or if measurement fails. This leaves cancellation
headroom above the ordinary train's 8 GiB disk gate; it is monitoring, not a filesystem quota.
Builds and scratch all stay on the cache filesystem. The next admitted invocation removes scratch
left by hard cancellation. No runtime artifact enters the official release root until train reuse.

Train reuse rechecks the runtime receipt, source/capabilities, full artifact digest, sampled
manifest and required CJS leaves. Adoption passes through an official staging name and atomic
rename; existing official targets are independently verified. Missing, changed or partial evidence
falls back to the ordinary builder. Web reuse rechecks its key, dist digest and complete seal, then
freezes the expected digest before rechecking the seal and copying, then checks the copied dist.
Every digest read must succeed; an error cannot be converted into an empty/equal digest. All C
gates, master sealing, E1 and smoke (including G1) still run.
`OC_V5_FORCE_WEB_BUILD=1` retains its normal meaning. Runtime image rebuild is not required.
Exhausting the prewarm allowance only loses the optional speedup: the train still builds normally.

## Hit and fallback evidence

`scripts/__tests__/v5SelfhostPrewarm.node-test.mjs` exercises the ordinary runtime builder and the
frontend block extracted from `build_master_release`, using real receipt/seal/digest checks and
private Git archives. Only external build work (Docker inspection, flavor authorization, runtime
finalization and npm compilation) uses fixtures. No deploy entrypoint or production service runs.

| Input/state | Expected consumer result |
| --- | --- |
| Exact runtime receipt and verified artifact | Adopt private runtime; cold finalizer is never called |
| Missing runtime receipt, changed image/source/capabilities, corrupt bytes, failed adoption | Ordinary archive/prune/finalizer runs exactly once with pinned committed source |
| Cold runtime finalizer fails after a miss | Fail the build; no retry or false hit; live pointer unchanged |
| Verified private web donor | Copy verified bytes; record `reused` and the private donor; no npm build |
| Backend-only commit with identical web inputs | Web reuse still hits despite the new commit SHA |
| Missing/malformed web record, corrupt dist/full seal, changed build environment, force build | Official frontend command runs exactly once; record `built` and empty donor |
| Corruption while copying an accepted web donor | Remove staging and fail; no cold retry; live pointer unchanged |

These are deterministic branch-coverage results, **not a production hit-rate sample**. Runtime
keys bind the exact SHA and image/toolchain/recipe; web keys bind content, recipes and build
environment. A runtime miss and web hit on the same train can therefore be correct. A ready
`attempt.json` proves preparation, not subsequent consumption; it is overwritten for later
attempts and is not a historical counter. Admission refusal consumes no build attempt.

For an approved rollout, the steward can collect evidence read-only from existing train logs,
`<trainId>.summary.json` and each retained master release's `.web-dist-reuse.json`. Fix a time
window and retain one row per train: train ID, target SHA, final/exit status, runtime result, web
result and donor, and phase durations. Include failed trains; never rerun a train to improve a rate.

- Runtime: `runtime prewarm hit (full digest reverified)` confirms a consumed prewarm artifact.
  An observed ordinary finalizer/build result after lookup is a miss, even when the cold build
  fails. A failure before lookup is `not-reached`; missing/truncated background logs are `unknown`.
  `cache.runtimeRelease` in the summary describes ordinary finalized-release reuse, so it must
  not be counted as a prewarm hit.
- Web: `mode=reused` is a prewarm hit only when the recorded donor is the private
  `artifact-cache/web-<key>` bucket (or the configured cache root). A `rel-*` donor is ordinary
  release reuse. `mode=built` is a cold result. Preserve explicit force-build rows separately.
  A selected donor followed by a copy failure is `failed-copy`, not a successful hit; preserve
  the log when staging cleanup leaves no reuse record. Unreached or unverifiable cases stay
  `not-reached` or `unknown`.
- Report runtime hits / resolved runtime lookups and private-web hits / resolved eligible web
  selections, with the numerator, denominator and unknown/not-reached/forced counts beside each
  rate. Resolved cold failures and failed copies remain in their denominators. Report ordinary
  web reuse separately. A zero denominator is `N/A`, never 0% or 100%.
- Pair those rows with prewarm journal outcomes (`ready`, `partial`, `failed`, admission refusal)
  and train phase durations. Attempt success rate, artifact consumption rate and total elapsed
  time answer different questions; none alone proves the expected ~10 minute saving.

No production sample was collected by this follow-up: hit rate and elapsed-time benefit remain
unmeasured. PR #1190 was already merged by another session at 2026-10-28 07:21:12 UTC when this
follow-up inspected GitHub. Its original head had 21/21 successful checks and no outstanding
review threads. This follow-up changes tests/docs only; its PR stays draft, **DO NOT MERGE**.
Further integration, rides and rollout remain with the steward after the required acceptance.
