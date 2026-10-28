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
