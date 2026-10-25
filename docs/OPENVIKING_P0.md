# OpenViking P0 contracts (OCV5-618)

Only design concepts are borrowed; no OpenViking code, package, service or license-bearing artifact is vendored. This is a personal-edition contract adapter, with no production caller, environment switch, sidecar database, worker, search change or UI. Do not merge or deploy this batch until the separately scheduled Grok Build review and normal review have completed. Commercial synchronization is outside this batch.

## Activation and authority

Both readers and eligibility require the internal option `enabled === true`; omitted/false returns `disabled` before source access. No symbols are added to the storage barrel, so existing imports and default prompt/tool paths do not load the new modules. Enabling an existing runtime remains a separate integration task.

`GatewayContextAuthority` is an **internal composition contract**, not an authentication format. The gateway must supply its already-authorized domain, effective execution identity, session/turn, final project binding, frozen context version, authority generation, selected root/mode, existing memory decision and session-scoped privacy fingerprint. A caller may not deserialize request data into this type or construct source handles from environment variables. The Core reader must already be bound to exactly that trusted authority. The adapter does not authenticate these in-process inputs, invent project permissions or fetch consent. Future integration must use `projectContextRuntime`'s resolved binding and `promptPrivacyPolicy`'s fingerprint/lifecycle.

All CLI calls, managed and unmanaged, return `cli_lease_blocked`, even with claimed valid, expired, replayed or forged lease objects. A 0600 file, environment variables, the existing memory policy schema and `authorityStateReader` do not prove the complete CLI lease. No CLI decoder or gateway issuance path is implemented. The old independent CLI continues unchanged. **Complete CLI lease integration remains BLOCKED.**

## Read whitelist

| Source | Accepted operation | Boundary |
| --- | --- | --- |
| Core index projection | A composition-supplied `Pick<MemoryDir, 'renderForInjectionReadonly'>` | Preserves existing readonly index filtering; no list/migrate/reconcile/write API. Descriptor identifies the rendered index, not full Core bodies. |
| Identity compatibility | `assertIdentityCompatExecution` on previously resolved `IdentityCompatAssets` | Existing registration/configuration checks belong to `resolveIdentityCompatAssets`; no alias discovery or realpath-derived authorization. |
| Formal official project memory | `createAuthorityPaths`, `openProjectFormalReadonly`, `loadFrozenProjectContext({formal})`, readonly ledger `snapshot`, `close` | Explicit root only; project/contextVersion must match. Official ledger membership, deprecation, content hash and both ledger/frontmatter expiry apply. Ghost/candidate files are not sources. Formal open/schema failures propagate; no legacy fallback. |
| Legacy project, skills, profile, assets, sessions, archival | Not admitted | Legacy `loadFrozenProjectContext` reaches a write lock through `loadProjectContext`. Other enumerators have not been admitted for this contract. |

The existing formal frozen loader also verifies project metadata and skill trees, but this adapter emits only official-memory descriptors. These are existing readonly operations; no source directory, lock, conflict copy, migration or schema is created. Missing formal roots stay missing. No sidecar path is registered in MEMORY.md, project ledgers or skill lists.

`SourceDescriptor` is immutable and contains a logical locator, scope-bound ID, content SHA256, source text and applicable expiries. Scope includes domain/root/mode, effective identity, session/turn, project/version, epoch and policy fingerprint. A hash is a version key, not authentication. `contextEligibility` requires a **fresh authorized source descriptor**; an old manifest cannot prove current source state. It checks source identity/version/content, scope, existing TTL semantics and the existing scanner. It does not validate a generated summary or provide P1's 5 ms/20-member/128 KiB read budget. No summary is generated or returned.

## Evidence and limits

Implementation starts at `d854b8f788bf0b7b290e332908114587bf8bfec4`, a descendant of Entry Gate seal `55da54cfbc2d116bdb4b484e3ec014a7935f3a50`. Storage and mcp-memory are unchanged between those commits. Entry Gate before/E01/admission remain sealed and are referenced rather than rerun wholesale.

Evidence root: `/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-308/openviking-p0-20261025/`; prior evidence: sibling `openviking-entry-gate-20261025/`. `after/` records new tests, the exact original storage/mcp-memory subsets, package typecheck/lint and trailers. `e01-after/` records the original 30-case runner in isolated HOME/network namespace with both semantic flags off. `DIFF-FOCUS.md` and the task CONTINUE record final review/CI status.

New tests cover the P0 portions of V01/V04/V06/V09/V15/V16/V17/V18. V15's existing privacy/scanner/telemetry before remains in Entry Gate; no gateway policy algorithm is replaced. This is not evidence of four-engine authenticated leases, sidecar writer integrity, UI/HTTP behavior or P1 performance. The sealed E01 JSON contains ranks/scores, not complete tool payload bytes: rank/quality comparison cannot be advertised as a measured byte-for-byte payload comparison. Default behavior preservation additionally follows from leaving all existing production files and callers unchanged.
