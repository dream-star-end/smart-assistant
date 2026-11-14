# Model release operator — implementation contract, not execution approval

Frozen scope: manifest model-release-manifest.json, 17 public additions plus standard Grok 4.7 at personal four price dimensions/multiplier. Preserve old 33 pricing, availability, aliases/group/user permissions; disabled Astra1M stays disabled. No new DDL, migration rewrite, or admin endpoint changes.

Approved base: fence root2188af24d8e451abb0a36259700b769ddc8f3719. Full design/evidence: workspace/ocv5-308/ACTIVATION-PLAN.md G27 refinement. This document is not a runnable activation and not production authorization.

## Authority and lock order
Write transaction order: common PG advisory lock -> run-id advisory lock -> deploy_state singleton -> SHARE ROW EXCLUSIVE table locks in fixed order model_catalog,model_pricing,model_aliases,account_groups,account_group_models,model_visibility_grants. Lock actual affected rows deterministically. Before first DML, validate fresh local holder proof/common nonce, exact live PID/starttime/fd9 inode/actual flock/expiry, strict actual PG primary identity and full locked snapshot. Hold locks through COMMIT; finite timeouts, no write-after-failure retries. Verify trigger epoch/alias lock effects with real concurrent admin cases.

Production CLI only on commercial host root. Root-only regular nonsymlink proof/nonce and trusted immutable release metadata are read directly; env boolean/nonce alone is insufficient. No SSH/network probe inside transaction. Deploy authority is stable + active_release/generation/lock_version, not a nonexistent sourceCommit column. Verify release metadata sourceCommit/hash separately.

## Exact CAS and receipt
Observe is read-only, freezes exact manifest/prepare ledger/entry and lock versions/pricing/aliases/groups/user grants/old33/Astra and release authority. Apply uses actual fn_model_activate_entry and 9-parameter fn_model_switch_version with non-NULL integer expected versions; never direct enable pricing or mutate immutable active descriptors. Grok pricing allowlist only display_name + four dimensions + multiplier; preserve other commercial columns. Receipt admin audit and complete poststate are durable in same transaction.

## Unknown commit and compensation
Unknown COMMIT never triggers automatic apply. A fresh connection takes same-order session common/run-id locks, then begins read-only RR and consistently reads receipt+state. Never fix RR snapshot before waiting for prior transaction; absent/unavailable receipt remains unknown. Reject mismatched operation/run-id/manifest/release.
Compensation is a new run-id/new live lease bound to activation receipt and exact full current poststate. Restore Grok through a NEW catalog version; hide additions via non-NULL versioned disable, never resurrect retired entries or change billing history. Any later legitimate price/group/grant drift blocks compensation.

## Required actual evidence before activation
Real migrated PG plus actual CLI: prepare/observe/all17+Grok atomic activation; stale versions/snapshot/release/hash rejection; concurrent run/admin/alias/group/grant INSERT and DELETE; injected rollback; late old invocation after replacement nonce; qualified old transaction blocks successor effects until real COMMIT; real proof wrong type/owner/PID reuse/expiry/wrong-primary rejection; server COMMIT followed by lost ACK and receipt/state reconciliation; exact compensation and subsequent drift refusal. Full epoch/audit/aliases/groups/grants/old33/Astra pre/post equality where rejected. No skips, no test-only nonce checker substituted for operator.

Production credentials, upstream/tool/billing validation, official queue/joint runtime+egress release, CAS activation, old-runtime compatibility and official rollback ordering remain separate required gates. Scoped fixture PASS is not commercial rollout PASS.

## Explicit execution-role prerequisite
Only an explicitly authorized existing OC_V5_MODEL_RELEASE_DATABASE_URL is accepted. No app/deploy fallback, secret discovery, SET ROLE, owner fallback or GRANT. Read-only privilege preflight validates table/function/sequence privileges without LOCK or mutating calls. The real transaction rolls back fully on insufficient privileges. Production credential authorization/confirmation and upstream/runtime/rollback proof are independent open gates.
CLI outputs are root-only exclusive files; UNKNOWN COMMIT exits75 and provides reconciliation identity, never automatic apply.

Historical SQL evidence: schema_migrations records only version/applied_at, NOT a historical applied checksum. prepareSqlSha256 binds the current root-trusted release SQL and explicitly authorized readiness evidence; preparation is checked by version ledger plus exact current catalog/pricing/binding state. No claim of a PG historical checksum is made.

## Disposition (2026-10-05) — the operator was never run in production
`OC_V5_MODEL_RELEASE_DATABASE_URL` was never provisioned on either host, and the prohibitions above (no app/deploy fallback, secret discovery, SET ROLE, owner fallback or GRANT) rule out every existing role, so no operator observe/apply/compensate has touched production. The manifest stays as the frozen input of migration 0293 and of the operator's tests; it is no longer an all-17 activation set, and an operator observe against production would now refuse on drift.

The rows below went live through the product's catalog authority instead (`admin/modelCatalogOps` `activateEntry` / `switchVersion` over `MODEL_CATALOG_ADMIN_DATABASE_URL`, `admin/pricing` `patchPricing`): the calls behind the admin model-catalog and pricing endpoints, which `scripts/v5-change-route.sh` names as the route for catalog changes. Each run was made from the live release under the production mutation lease, one model at a time, checked every catalog and pricing field against this manifest first, and left `admin_audit` rows.

| Rows | State on commercial | admin_audit |
|---|---|---|
| box-claude-haiku-4-5, box-claude-opus-5-5, box-claude-sonnet-5 | active | 3201–3203 |
| gpt-6.1-sol, gpt-6.1-sol-1m, gpt-6-luna, gpt-6-luna-1m, grok-build-fast | active | 3204–3207, 3210 |
| grok-build (standard) | grok-4.7, "Grok 4.7", multiplier 2; kept columns unchanged per the allowlist | 3208 switch, 3209 pricing |
| claude-opus-5-5 | disabled: activated, its canary turn failed (the only Claude subscription account had an expired login and the product disabled it on first use), disabled again | 3211, 3212 |
| cursor-grok-4.7-* (8 rows) | staged: commercial has no working Cursor inference transport for cursor-* models | — |

Scripts, review records and canary evidence: task workspace `ocv5-308`, prefixes `g46-` and `g47-`.
