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

Draft rollout only: **DO NOT MERGE — 待真 Grok OD / 管家**. Wait for the current tip train to be live;
the steward schedules integration **P2 → P5 → P1**. The expected ~10 minute saving is a hypothesis;
measure cache hits and train summaries after an approved rollout. This PR does not deploy it.
