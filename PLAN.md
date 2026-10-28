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
  No existing assertion was changed or removed; full application suites remain CI-owned.
- Live GitHub signature acceptance and an actual merge-group drill remain activation prerequisites;
  local mocks prove rejection/fallback and command policy, not cryptographic signing by GitHub.
