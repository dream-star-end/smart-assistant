# OCV5-308: code sync and commercial model release

Latest user scope supersedes the initial NO-DEPLOY/code-only plan: sync common code, release the frozen public 17 new models at personal four-dimensional price + multiplier; standard Grok upgrades to 4.7 at personal multiplier 2. Keep other 33 active-enabled commercial rows unchanged. Do not restore Astra 1M, expose internal canaries, copy credentials/group IDs, or execute personal retirement SQL in commercial.

## Sequence (not yet deployed)
1. Commercial 0283 normal-runner history + 0293 staged/disabled preparation. Personal execution set excludes both.
2. Grok frozen authority upstream paired with the same pricing generation; compatible CLI/runtime + correct Cursor Box CC route; review and protected CI.
3. Official commercial queue/mutation lease release. Prove old active models still usable and new upstream/tool/cost probes pass.
4. Independent official double-lock CAS activation, standard Grok version+price in one transaction. Old 33 prices/permissions/bindings remain byte-for-byte; new min_plan_code=NULL preserves commercial ungated policy rather than copying personal Box lite gates.
5. Failure: disable new entries and CAS restore Grok, then official code rollback; no blind retry.

Manifest: ops/ocv5-308/model-release-manifest.json. Public target count 17; internal-only additions are not automatically exposed. Frozen pricing/capabilities were read from real databases in this task. Recheck exact live state before mutations.

B5 dedicated PG proof passed 3/3; source CI/incident debt remains a release blocker. Stage0 PASS does not mean code/release PASS. No production mutation has occurred.


## B7 execution/price generation binding (2026-10-02)

- Signed browser Grok authority projects the public upstream version inside the
  existing extensible capability profile; billingRequestId remains signed and
  bound to the server request ID. No endpoints or subscription secrets descend.
- Authenticated local delegate admission validates the opaque route hash against
  live owner/container/canonical-model/expiry, then returns and persists the public
  version together with the same catalog's execution revision and frozen pricing.
- V5 adapters reject missing descriptors; only the existing explicit non-container
  legacy mode uses static mapping. Child argv, prompt model and budget attribution
  use the frozen turn model; native resume retry uses that same upstream version.
- Targeted regression: 118 executed, 118 pass, zero fail/cancel/skip
  (`workspace/ocv5-308/b7-regression4.log`). Real child argv proves old 4.6 resume
  retry remains 4.6 despite mutable adapter/source changes; subsequent turn uses
  admitted 4.7. Signed Ed25519 consumption and local client reject bad bindings.
- Full CI and production relay-version evidence are separate gates and remain
  required before activation. This is preparation, not an activation/live claim.


## CI fixture/discovery/package-boundary correction, batch 1

B7 was independently reviewed PASS at `1b6e6c003`. Its settle regression uses
an injected finalizer and proves journal freeze, not a real debit; real billing
and relay validation remain activation gates.

CI TAP identified internal PG port 5432 vs external mapped 55432, Bun's runner
HOME traversal after uid drop, missing host redis-server, duplicate integ discovery,
and five cross-package src imports. Corrections retain real business oracles:

- External test DSN is fenced before connection; actual current_database is
  checked before writes. Existing TEMP and exclusive-schema assertions remain.
  No server listen port is compared against a NAT mapping.
- Bun 1.3.14 is copied to a dedicated traversable /tmp tool directory in CI,
  executed by uid 1000 and passed explicitly. Real CCB launch keeps uid drop.
- Isolated Unix-socket Redis binary is installed in CI; absence in required
  execution now fails instead of skipping the long-TTL proof.
- Gateway's discovered 336 targets are partitioned into 332 unit + 4 mandatory
  integ targets with a machine guard checking actual PR shard execution.
- Commercial content-review imports use gateway's explicit public exports.

Evidence: `ci-pg-identity.log` 31/31 pass, `ci-discovery2.log` 5/5 including
negative controls, `ci-runtime-fixture2.log` 2/2 with real CCB four HTTP calls
and Redis 14700s TTL, zero skip/cancel; `ci-boundary-types2.exit` 0. These do
not close the independent continuation, Stop/capacity, UI or incident blockers.


## CI storage guard / continued negative-control wiring, batch 2

- Batch 1 at `d7a22cd26` reviewed PASS. Discovery/DSN negative tests are now
  explicitly included in the normal `test:v5:ops` target set, not only manual runs.
- The existing operator probe's finance SQL uses a pinned client, creates TEMP
  shadows and proves every finance relation resolves to pg_temp before admission.
  The architecture checker now accepts only that exact file's two complete TEMP
  DDL lines. It does not whitelist the whole file or relax global SQL detection.
  Persistent DML, near-matching DDL and the same statements in any other file
  still fail the negative controls.
- `ci-temp-guard.log`: 8/8 pass, no fail/cancel/skip. Full storage suite
  `ci-storage2.log`: 515/515 pass, no fail/cancel/skip, exit0.
- Incident short-hash identity normalization is a separate open change. The
  full incident proof debt, browser/continuation/Stop blocks and rollout remain
  open. These two fixture batches are not production availability evidence.
