# P8 — selfhost merge-queue gate receipts (draft)

DO NOT MERGE — 待真 Grok OD / 管家

这是门证据来源变更（gate-policy change）。本任务仅产出个人版 draft PR，不合并、
不 register ride、不部署、不修改线上配置或 GitHub protection。合入及启用分别需要用户/管家批准。

## Baseline and scope

- Isolated branch `feat/v5-selfhost-train-p8-gate-receipts`, base `35326165f`.
- Authority: `deploy/v5/selfhost-release-gates.json` and `check-release-gate-parity.ts` remain
  byte-for-byte unchanged; all 18 gates retain their existing local commands and assertions.
- New policy is only a subset selecting reusable evidence, never a replacement gate inventory.
- No Aurora, commercial release queue, kl-mirror, canonical checkout, dependency or runtime image changes.

## Evidence contract

1. A dedicated selfhost workflow runs on `merge_group: checks_requested`, checks base_ref is
   `refs/heads/feat/v5-selfhost`, and checks out `merge_group.head_sha` exactly. Normal PR CI
   validates this feature's small unit/contract tests, without issuing receipts.
2. Host-independent subset: delegate-billing-requestid, callback-payload-hash, cron-submit-boundary,
   prompt-privacy-lifecycle, system-approval-fencing, system-executor-fencing,
   session-unavailable-rootfix, watch-gate. Run the same gate commands with failures propagated.
3. Conservatively keep Box (private DB/load isolation), CCB MCP, cursor root-filesystem checks,
   host-log-policy, architecture (local report), web/MCP artifact builds, fix-trailers and all
   admission, digest, migration, cutover, smoke and runtime waits on the host. No receipt can
   satisfy them. Builds must still produce the actual local artifacts.
4. Receipt JSON binds schema, repository, event/base/ref, exact 40-character source SHA,
   workflow path, run ID/attempt, full gate-manifest SHA256, subset-policy SHA256, and an exact
   ordered list of successful eligible gate IDs. No same-tree, PR-head or ancestor substitutions.
5. Gates run on a GitHub-hosted runner without OIDC permission. A separate job, which runs only
   after success and never executes candidate code, downloads the small JSON and signs its digest
   using `actions/attest-build-provenance`. No long-lived private key is introduced.
6. Verification uses GitHub's authenticated API plus `gh attestation verify`: exact repository,
   signer workflow, source digest and source ref, deny self-hosted runners. Also require the
   referenced run/attempt to be completed/successful, event=merge_group, exact SHA/path and queue
   branch for selfhost. Never trust payload metadata or artifact name alone. Bound subprocess
   time/output and artifact download; don't print credentials or upstream failure bodies.

## Train integration and fallback

- Default OFF; opt-in `OC_SELFHOST_GATE_RECEIPTS=1` and an explicit trusted
  `OC_SELFHOST_GATE_RECEIPT_REPO=owner/repo` are activation controls, not provided by a receipt.
  This task does not set them on the host.
- After creating the private gate TMPDIR, try one bounded fetch/verification for the pinned SHA.
  Output a complete verified subset only after every check succeeds. Reset invocation state on
  source and on every build. No durable boolean cache, inherited success flag or partial acceptance.
- Each eligible gate retains its original literal command in `build_master_release`; a verified
  receipt satisfies that gate, otherwise the unchanged command runs and failure still aborts.
  All host gates run regardless. Record `gateEvidence.<id>` and receipt run identity in summary.
- Missing receipt/run, wrong SHA/list/digest/repository/ref, expired artifact, cancelled/failed run,
  bad signature, old/missing gh, API errors or timeout => local rerun. Receipt lookup failure is
  never gate success. Same SHA on a different merge strategy falls back safely.

## Validation

- First review this design with the required Codex wrapper, gpt-6-astra/xhigh, before code.
- Focused unit tests cover valid evidence, tampering, SHA/repository/workflow/event/attempt/list/
  digest mismatch, failed/skipped/cancelled runs, missing files, verifier failure/timeout, and shell
  fallback propagating a real failing local command. Contract tests preserve all host commands,
  ensure producer subset equals train subset and manifest membership, and exercise gate parity.
- Run only these targeted tests, changed-script typecheck/lint, shell syntax, existing parity tests
  and `check-v5-fix-trailers.sh`; full suites run in CI. Run `$H/wait-for-trains.sh --self train-p8`
  before acquiring any shared test lock. No heavy build or extra node_modules tree.
- Code review with `$H/codex-review.sh -C "$WT"`, max 3 rounds, same model/effort; push and create
  draft PR with the required first line, record exact head/checks and remaining prerequisites.

## Integration conflicts and activation prerequisites

- P1: artifacts still use existing digest-verified donors; receipts do not authorize artifact reuse.
- P2/P3: both edit `build_master_release`; preserve their ordering/lane failure propagation and Box
  isolation when merging. Resolve against the final reviewed pinned-source pipeline.
- P5: receipt miss still acquires the original locks; no new bypass of test-mutex/train priority.
- P6: sealed candidate retry semantics remain unchanged; no reuse of receipt results across SHA.
- P7: private TMPDIR/cache lifetime must outlive verification and all local fallback gates.
- Before activation: user/steward gate-policy approval, merge queue configured for selfhost with
  the existing required CI still enforced, verify actual merge strategy preserves receipt SHA,
  current gh supporting all verifier flags, repository plan supporting artifact attestations,
  least-privilege Actions/attestations read access, and a real queue-run signed-receipt drill.
  Missing capabilities mean local rerun, not lowering required checks.
- GitHub docs: [merge_group](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group),
  [attestation verification](https://cli.github.com/manual/gh_attestation_verify),
  [provenance action](https://github.com/actions/attest-build-provenance/tree/v2).
  Current host gh 2.45 has no attestation command; live cryptographic acceptance cannot be proven
  locally until that activation prerequisite is met. Mocked unit tests must not be called a live drill.

## Draft implementation evidence (2026-10-28)

- Design review: `train-p8-plan-review-xhigh-r1.txt` = APPROVED; recorded model gpt-6-astra/xhigh.
- Producer and signer are separate GitHub-hosted jobs. Download/upload/attestation actions are
  pinned to full commits. Verifier also pins signer digest to the exact candidate SHA.
- Acceptance is all-or-nothing; at most one latest merge-group run is considered, and its current
  attempt is checked again after signature verification. Each gh call is capped at 15 seconds,
  total lookup at 100 seconds. This is additional latency on an enabled but unavailable service;
  the default disabled path performs no lookup. Artifacts are bounded (128 KiB ZIP / 32 KiB JSON).
- Local focused run: 46 tests passed, 0 failed/skipped (receipt, parity, TMPDIR/cache, source-pin).
  Scoped strict TypeScript, changed-file Biome, shell syntax and unchanged 18-gate parity passed.
  Full application suites remain CI-owned. Code review R1 identified the existing summary test's
  old call-shape scanner as obsolete after d024e44e0: it counted 7 local forms against 15 marks.
  The scanner now also recognizes the exact receipt-guard + local-command form; its original
  gate-count/phase-count equality assertion is preserved (15/15), not relaxed.
- Live GitHub signature acceptance and an actual merge-group drill remain activation prerequisites;
  local mocks prove rejection/fallback and command policy, not cryptographic signing by GitHub.


## P8 deepen — 2026-10-28, implementation baseline 02907d209

DO NOT MERGE. The prior code audit is APPROVED and its head has 22 successful checks
(2 merge-group-only jobs skipped on PR). This follow-up strengthens the same draft;
no activation, queue registration, merge, deployment, dependencies or runtime changes.

Planned changes, to be reviewed before implementation:

1. Require `gh attestation verify --format json` and inspect only its verified certificate
   extensions. In addition to all existing verifier flags, require the certificate's
   `runInvocationURI` to equal the authenticated run/attempt URL and `buildTrigger` to be
   `merge_group`. Do not treat the payload or user-controlled provenance predicate as
   run identity. Empty, malformed, missing or mismatched verified output is a miss.
2. Check artifact `workflow_run` id/head SHA/head branch against the selected run before
   download. Check repository numeric identity if supplied by the corresponding API run
   (with explicit schema validation); prefer requiring the documented run/artifact IDs
   rather than accepting incomplete metadata. Preserve latest-only selection and final
   run/attempt recheck, bounded calls and scratch cleanup.
3. Tighten input syntax to reject repository dot segments and invalid/empty queue refs.
   ZIP parsing must accept one ordinary receipt entry only, rejecting duplicate entries,
   symlink/device entries, encrypted/invalid archives and oversized decompressed data.
4. Add focused behavioral regressions for verified certificate run/attempt/event mismatches,
   malformed API/artifact/ZIP outputs, cleanup on every failure, exact independent verifier
   argument expectations, CLI issuance event/checkout/outcome failures, and shell prepare
   hit-to-miss/reset/failure propagation. Use isolated temp fixtures and fake gh executables;
   no network credentials, shared DB, gate workloads or live deployment from these tests.
   Retain every existing assertion and gate command; update mocks for stricter metadata.

Scope: receipt TS library/CLI only if needed, receipt test files, receipt CI test/typecheck
wiring only if a new test file needs inclusion, this plan. Keep authoritative manifest,
subset policy, parity checker, existing gate commands and train integration unchanged.
Validation: regression red/green on the receipt suite, targeted parity/source-pin/TMPDIR/
summary tests, scoped strict tsc and Biome, shell syntax, fix-trailers. Full application
suites remain CI-owned. Before any shared test lock, run H/wait-for-trains.sh --self train-p8;
BUSY means wait. No new worktree or node_modules. Commit+push, H/codex-review.sh using only
gpt-6-astra/xhigh, update PR evidence and CONTINUE, then stop with the requested DONE line.

Possible regression: an older gh or incomplete certificate/API response causes extra local
execution. This is intentional fail-closed behavior, remains default OFF, and must never
permit a failed local gate. Real GitHub cryptographic acceptance and actual merge_group drill
remain separate activation prerequisites, not claimed by mock tests.

Contract references: [gh verified JSON](https://cli.github.com/manual/gh_attestation_verify),
[Fulcio certificate extensions](https://github.com/sigstore/sigstore-go/blob/main/pkg/fulcio/certificate/extensions.go),
[Actions artifact API](https://docs.github.com/en/rest/actions/artifacts#list-workflow-run-artifacts).


### Deepen implementation and validation

- Plan review `train-p8-deepen-plan-review-r1.txt`: APPROVED, gpt-6-astra/xhigh.
- Certificate checks use the flat `verificationResult.signature.certificate` fields from
  verified gh JSON. Every returned verification must bind the exact run/attempt and
  merge_group trigger; payload/predicate lookalikes do not count.
- Run repository IDs are required positive safe integers; artifact run ID, head SHA/ref
  and both repository IDs must match. Final run recheck also preserves repository ID.
- Archive boundaries include exactly 32 KiB accepted, one byte over rejected, and rejection
  of encrypted, duplicate, directory, symlink and device entries. No paths are extracted.
- New CLI tests execute the actual issue/fetch entrypoint with a tiny temporary git fixture
  and a local fake gh process. They cover exact checkout/event, failed or masked gates,
  create-once output, redaction, real subprocess timeout, signature failure and old attempt.
  Shell tests cover a successful preparation followed by disabled/malformed/failed lookup,
  empty state, host-gate nonacceptance, summary evidence and original local failure propagation.
- Red/green evidence: the new repository/ref, artifact-run and special-file tests fail on
  the previous implementation. Final focused suite: **55 passed, 0 failed, 0 skipped**.
  Full summary suite, strict scoped tsc, changed-file Biome, shell syntax and parity all PASS.
  Manifest/parity remain unchanged from 35326165f; policy/train shell unchanged from 02907d209.
- During validation, explicit assertion messages fixed expensive Node 20/tsx default assertion
  source inspection on invalid metadata; conditions remain identical. A test-only fake-gh
  newline escaping bug and a test fixture union type were fixed, not retried or waived.
- Logs are task-owned `H/train-p8-deepen-{tests-final,summary,typecheck,lint,parity,syntax}.log`.
  No shared test lock, heavy suite, dependency installation or production mutation occurred.
- Supported real gh/attestation acceptance, actual merge_group drill and gate-policy approval
  remain required before any activation. This change does not claim those prerequisites passed.


## CI follow-up: idle seam failure obscured by teardown (2026-10-28)

The deepen head 51d1007af passed 21 CI checks, but selfhost-gateway idle 3/3
(job 122694083684, run 40652018481) reached the existing 20 minute timeout.
Its last test output at 07:52:56 UTC is adapterShutdown called from the fixture's
finally block; cancellation occurred at 08:06:00 UTC. The fixture records the
first failure only in an in-memory report and writes the report after unbounded
HTTP/PG cleanup. The available log therefore cannot distinguish the original
failure from a cleanup hang. No retry has been requested.

Plan, before any diagnostic code change:

1. Add narrow failure-only diagnostics in the idle integration fixture. Log the
   mode, error type and stack frame locations (never the error message, request
   bodies, environment values, credentials or connection strings) before cleanup.
   Name cleanup stages before awaiting them only when the test already failed.
   Keep the original error and every assertion, deadline and cleanup operation.
2. Commit/push and audit this diagnostic-only diff with gpt-6-astra/xhigh. Let the
   existing full CI run unchanged; do not run the integration fixture locally,
   increase its timeout, skip assertions, add retries or change runtime code.
3. Use that evidence to identify the actual failure and cleanup blocker. Make a
   separately explained minimal fix only after its cause is established; retain
   all semantic coverage and obtain code review and green CI before integration.
4. Train waiting continues independently. No ready, merge or ride before the
   normal wait-for-trains FREE result and all applicable current-head CI green.

Scope: personal task branch, PLAN.md and gateway test fixture diagnostics only.
No commercial runtime/queue, new worktree, dependency install or shared tests.


---

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
   HEAD too before flip (worker owns canonical ff). Prepare may be ahead of HEAD;
   its target commit must be available locally and its controller/guard files must
   match the running checkout, otherwise refresh canonical before preparing. No implicit re-pin; a stale
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
   Avoid modifying shared/commercial GC implementation. Successfully flipped receipts are
   removed under the artifact mutex (matching the exact master path); the deploy lock protects their artifacts
   until the existing saga commits/compensates. Invalid/stale receipts are removed
   under that same mutex; artifacts are left to normal GC, never eagerly deleted.
8. Move mutable setup (`ensure_selfhost_env_keys`, auxiliary units/proxy,
   model-authority, asset pool seeding) to the locked path. Re-run live-dependent
   preflight, trailer and P0 overlay checks at flip. L0 runs on a cache miss before building; a reusable receipt has already passed
   it. Its build-space admission is not repeated after consuming that space.
   Prepared L0 pins the immutable git object rather than requiring current HEAD;
   remote-tip/controller equivalence is verified immediately before it. E2 still
   rechecks the live migration gap under the lock. Preparation checks the
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

Plan review: APPROVED (independent Codex plan reviewer, 2026-10-28).

R1 code review fixes: update both legacy/split env-drift wiring and the balanced
idle-test snippet without changing their assertions; the parity mutation fixture
now removes both real trailer calls. Ahead-of-HEAD preparation is admitted only
for an available exact remote tip with byte-identical controller/guard definitions.
Cold L0 admission runs after the receipt lookup, so cached flip needs no second
8 GiB reservation. Add behavioral cases for all three R1 P1 reproductions.

## P4 deepen — 2026-10-28

Incremental base: `f10e912d70d44e1c176ef003215ad7900cb67e60` (21/21 CI green).
Keep the existing design and draft PR; no integration or production actions.

- Verify the requested remote tip before pruning receipts. A delayed prepare for
  an obsolete SHA must not delete a ready receipt belonging to the current tip.
  Keep that check inside the artifact mutex, including after waiting for it.
- Treat a dangling prepared-root symlink as unreadable state and defer GC,
  preserving the same fail-closed behavior as other untrusted prepared paths.
- Add isolated behavioral failure tests for master/runtime/platform preparation,
  interrupted publishers and inherited artifact locks, same-SHA reuse/recovery,
  rejected identities, partial receipts and conservative GC. All git origins,
  locks, artifacts and process signaling belong to the test fixture.
- Exercise actual cutover/compensation functions with private filesystem and
  host-I/O fakes: E1/E2 refusal, idle refusal, post-mutation rollback failure,
  recovery evidence, stay policy and successful receipt consumption. Assert
  exact pointer/backup/receipt outcomes rather than source-text presence.
- Preserve the release gates and assertions. Run only affected unit tests plus
  typecheck/lint/trailers locally; use wait-for-trains before any shared test lock.
  Full suites remain CI's responsibility. Commit/push, then run the required
  H/codex-review.sh with gpt-6-astra/xhigh and record results in CONTINUE.

Incremental plan review: APPROVED (independent gpt-6-astra/xhigh reviewer).

Incremental local evidence: prepare 28/28, prepared cutover 11/11, recovery 16/16,
stay 31/31 and rollback 34/34. The two new production regressions fail against
the unchanged f10e912d7 library and pass against the current library. Cutover
tests execute the real digest, migration/idle decisions, joint tuple saga,
compensation and stay functions; host/DB/service/survivor APIs remain private
fixture adapters. They are not a production soak. Existing concurrency tests
now use bounded ready/release events instead of fixed sleeps, preserving their
lock and ordering assertions. The complete cutover fixture has a separate 45s
bound for real digest/history/fsync IO; it adds no retry.

## CI follow-up — pending find-navigation fixture window

Exact-head CI on cc1174f36 exposed browser failures in the existing OCV5-188
pending-find cancellation cases. The captured pending m250 row was already
visible and wheelFence was false; session-switch and unmount cases also lost
the pending window across browser RPCs. No web product code changed in P4.
Investigate the fixture's manual holdFence versus the production 200ms quiet
release, then make the pending setup deterministic with an explicit bounded
hold/release lifecycle. Retain real trusted gestures, all visibility/pin and
post-release no-rejump assertions, and the unchanged production controller.
No skip, relaxed assertion, longer product timeout or retry may hide this red.
Run relevant local unit/typecheck/lint only; browser/full validation stays CI.
Review this follow-up plan before code and the new delta after commit/push.

CI follow-up plan review: APPROVED (independent gpt-6-astra/xhigh reviewer).
Use separate manual/native fence ownership; release the manual hold as soon as
the real cancellation event arrives or the requested fixture state commits,
never after waiting for pin expiry. Capture pending pin/visibility at that action.
Remove the existing four-attempt preparation loops, preserve native quiet timing
and the product's 1200ms alignment budget, and keep collector results consistent
with the no-rejump assertions. Add focused adapter lifecycle unit coverage.

CI follow-up R3 plan review: APPROVED. On 7b47f9f06 all original pending,
session/unmount and real gesture cancellation failures pass. Only mobile toolbar
warm-up waits fail before Enter (enters=0, touchmoves=0); the new delivery filter
assumed DOM delta equals raw CDP -120. Synchronize the single trusted upward
warm-up after clearing its queue and record its actual delta. Exact -240 and all
trusted/toolbar/pin/visibility cancellation assertions remain unchanged. Mobile
delta conversion is currently an inference, to be checked in the next CI log.


## Rebase integration — 2026-10-28

Rebased onto selfhost 32687c3a7 (#1189/#1193). Preserve P8 plans and all gate
receipt policy, P1 speculative caches, and P4 exact-source prepare/flip semantics.
Independent gpt-6-astra/xhigh plan review APPROVED before this integration.

- P5 admits a building train callback only with executor ancestry, unchanged PID
  identity and exclusive artifact fd9 while holding shared deploy admission.
  Another deploy owner, grants, wrong inode, missing/shared flock and external
  callers still refuse; the test-family mutex and watchdog remain mandatory.
- P1 speculation takes the same artifact mutex nonblocking on fd10 before any
  cache mutation. P4 preparation retains that mutex through all background work.
  Legacy deploy quiesces speculation before waiting on artifacts; split flip
  quiesces after acquiring deploy.lock and before its nonblocking artifact check.
- The extracted runtime builder uses the pinned archive exclusion list. Preserve
  all release gates, receipt validation, source/image binding, E1/E2 and fencing.

The assigned worktree was concurrently rebased/pushed by another process while
plan review ran (ec51e4fbb, then2500bb1b1). This follow-up is developed in isolated
train-p4-rebase-integration-20261028 to avoid overwriting that work. No merge, ride
or production mutation is authorized. Validation uses private fixtures.
