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
