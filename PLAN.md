# P4 — selfhost prepare / flip lane (draft)

Base: `35326165f0fca6d3941c8a81d60e51b12ee7a40d`, branch
`feat/v5-selfhost-train-p4-prepare-flip`. Personal only; no merge, ride or deploy.

## Design

The existing train takes deploy.lock before A–D/P. Split its execution, not its
release gates. Keep the existing joint cutover saga and release-policy owner
fencing. Expected locked E1–G duration is about 6–8 minutes; this is an estimate,
not a measured result of this draft.

1. Add `--prepare --target-sha=<full SHA>`: archive that exact committed selfhost
   source, run the unchanged build_master_release gate list (including isolated
   test DB gates), runtime build, platform build and seal. No live env, unit,
   model-authority, migration, survivor, pointer or lease/train mutations here.
   Prepare never holds deploy.lock. It may run ahead of the next train, including
   while a previous train owns the flip lane. Keep host admission and Box/build
   isolation. No gate receipt from CI and no new gate skip.
2. `--deploy --platform-from-head` uses the same prepare function, then acquires
   deploy.lock and rechecks the candidate. Worker releases its short planning/ff
   lock before spawning in both systemd and non-systemd paths. Existing train
   identity remains building during prepare and cutover during mutation; no
   change to the train status schema or one-open-train index. Standalone prepare
   provides the look-ahead entrypoint; automatic prewarm scheduling is P1's
   integration point, not a second scheduler in this PR.
3. Preserve legacy worktree-platform deploy, bootstrap, build-master-only,
   rollback and standalone cutover behavior under the deploy lock. Resume of a
   release-policy operation also remains locked. The new split path requires all
   three source surfaces from the pinned commit.
4. Persist a root-owned, atomic JSON receipt keyed by full SHA under a dedicated
   selfhost prepared-state directory. Bind schema, exact SHA/tree, preparation
   options, image tag + immutable ID, master path + .complete hash, runtime path
   + MANIFEST hash and platform path + MANIFEST hash. Receipt is written only
   after every preparation gate succeeds. Never source/eval receipt contents.
   Validate trusted paths/ownership, marker hashes, source identity and runtime/
   platform manifests when consuming. E1 still recomputes the master artifact
   digest and runs tsx selfcheck on the very release that will flip.
5. Tip validity: fetch/verify remote selfhost tip at preparation entry, completion
   and again under deploy.lock before any live mutation. A different tip rejects
   the prepared candidate, even if the old SHA remains an ancestor. Check local
   HEAD too before flip (worker owns canonical ff). No implicit re-pin; a stale
   train terminates without production writes and a later train prepares new tip.
   Once a flip has passed this boundary, finish that pinned operation rather than
   interrupting a partially mutated saga because a later merge arrives.
6. Concurrency: a separate selfhost artifact mutex serializes preparation and
   legacy build writers, with unique staging. Prepared receipts remain independent
   of the deploy lease. Release this mutex before waiting for deploy.lock; take it
   briefly again under deploy.lock for receipt validation/consumption. The lock
   order never permits a prepare process to wait for deploy.lock while holding
   the artifact mutex. Prepare may not inherit deploy fd/HELD state. Background
   build children retain artifact protection until reaped.
7. GC: selfhost cutover GC takes the artifact mutex nonblocking; if a prepare is
   running or an unconsumed prepared receipt exists, defer artifact GC (log why).
   Avoid modifying shared/commercial GC implementation. Consumed receipts are
   removed under the artifact mutex; the deploy lock protects their artifacts
   until the existing saga commits/compensates. Invalid/stale receipts are removed
   under that same mutex; artifacts are left to normal GC, never eagerly deleted.
8. Move mutable setup (`ensure_selfhost_env_keys`, auxiliary units/proxy,
   model-authority, asset pool seeding) to the locked path. Re-run live-dependent
   preflight, L0, trailer and P0 overlay checks at flip. Preparation checks the
   trailer gate and build admission before expensive work. Use the pinned staging
   validator for platform seeds. Do not modify gate lists or parity coverage.
9. Failure: before receipt publication, no reusable candidate; before live mutation,
   failure records a failed train only (standalone prepare has no train). After
   mutation, existing survivor, compensation, stay/rollback policy and terminal
   acceptance remain the sole authority. Failed flip can reuse a sealed candidate
   only while SHA/options/image/markers remain valid, with all E1–G checks repeated.

## Validation (local, isolated, bounded)

- Behavioral shell tests with temporary git origin, JSON receipts and fake small
  artifacts: prepare runs while deploy lock is held; flip waits and owns it;
  prepare/flip order; changed remote/local tip; missing/corrupt/tampered receipt;
  mismatched SHA/tree/image/options/marker; failed gate cannot publish; concurrent
  prepare serializes; GC defers during prepare and while ready; pre-mutation
  failures cannot invoke live mutations; post-mutation failure keeps saga handling.
- Run `scripts/v5-lease-center-selftest.sh` and affected selfhost train/pinned-source/
  release-preflight/recovery tests. Adapt assertions only for intentionally changed
  lock ownership/order, documenting the reason in the implementation commit.
- Run `bash -n`, focused shellcheck, gate-parity check, `npm run typecheck`, and
  `scripts/check-v5-fix-trailers.sh`. Before shared test locks use the requested
  `$H/wait-for-trains.sh --self train-p4`; no full test suite or large build locally.
- Plan review before code, then `$H/codex-review.sh -C "$WT"` with gpt-6-astra/xhigh,
  at most three code review rounds. Push and open draft PR against feat/v5-selfhost.
  First body line: `DO NOT MERGE — 待真 Grok OD / 管家`.

## Integration conflicts / limits

- P1: call `--prepare` from the prewarm scheduler; coordinate receipt/cache roots.
- P2: preserve current admission-before-runtime and Box join ordering.
- P3: build_master_release body/gate scheduling must compose with the wrapper.
- P5: a preparing train still appears building; distinguish build admission from
  deploy lock ownership without bypassing test-resource contention checks.
- P6: candidate reuse and invalidation must be shared, not duplicated; no retry/GC
  policy expansion here beyond protecting prepared artifacts from current GC.
- P7: sealing/marker hashes stay authoritative if seal/cache optimizations change.
- Full CI and real-host soak/performance measurement remain pending steward review;
  this session must not run a production prepare, flip or large build.
