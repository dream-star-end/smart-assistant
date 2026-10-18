# 20:54 task-completion review — Part B

> Final read-only review: **APPROVED** for `f6d6079a82805a1efa0957df411725b3cc7aaad7` at 2026-10-18T13:20:50.108798+00:00. Earlier pending findings below are historical and superseded by the final follow-up. Test/CI results remain separate.

Observed at 2026-10-18T13:19:53.987026+00:00. Reviewer: engine_analysis. Worktree: `/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-501-ttft-step2`. Git HEAD at observation: `dc8cf0d5e60052e0efcec0438bc9f45a597b48d2`; this review also examines the uncommitted 20:54 increment, whose file digests are recorded below. Read-only review only: no model request, test invocation, CI polling, routing/configuration/product mutation, credential read, or commercial connection. The only write is this requested evidence document (0600).

## Scope and acceptance meaning

The user requires successful task completion and no UX regression. A faster deterministic error is not a completed task. The narrow implementation under review must preserve base-67d recovery opportunities, rather than add account/model/provider/profile switching. Normal selection, model/effort, prompt bytes/order, native-owner fences, stop/cleanup/continuation and billing ownership must remain unchanged. An authorized external configuration repair followed by a successful same-context task is useful handoff evidence; it is not proof that code automatically provisions the missing route.

## Concrete counterexamples found before this increment

1. **A usable bound alternative was prematurely cut off.** In dc8cf0d5e, a missing UID proxy became a Text-lane 409 immediately. In a supported legacy/default-login pool with unbound account A and already-bound account B, the existing gateway retry may select B on a later attempt. Immediate 409 removes that existing chance. No new routing mutation is required to construct this counterexample.
2. **Unknown I/O was treated as missing configuration.** `readBoxUidProxy` previously wrapped every untyped read failure as `BOX_UID_PROXY_UNAVAILABLE`, including temporary EMFILE/ENFILE/EIO. If the first read fails temporarily and the next succeeds, base retries can finish the task; immediate 409 prevents completion. The name of this code alone is not a no-route proof.
3. **The real Tool lane differed from the artificial Text-error fixture.** dc8 core required `BoxTextFetchError`. Text wraps the resolver error, while real `BoxToolFetch -> runBoxToolFirstRound` rethrows the resolver error unchanged. The old direct `BoxTextFetchError` unit fixture therefore did not establish the real tools-enabled webpage's 409 behavior.

## Current increment: changes verified by reading source

- `readBoxUidProxy` now retains only safe missing/invalid reasons. ENOENT is missing; ENOTDIR and explicit file/URL safety violations are invalid. Other I/O is unmarked and retains the old recovery path. No raw error message, path contents, proxy URL or credentials are introduced into the proof.
- `BoxEgressNotConfiguredError` is a distinct internal proof type. The UID-file failure branch requires an explicitly authorized launch and excludes inspect-only paths. It does not select another account, widen login scope, read another account's credential, start a Box control probe or mutate affinity.
- Unknown metadata or any observed bound alternative conservatively retains the old transient path. Text only preserves the terminal UID code for the proof type; otherwise it wraps the error as the prior `BOX_TARGET_UNAVAILABLE`.
- Core recognizes the raw proof from the real Tool lane as well as its Text representation. An unproven raw UID failure remains 500/retryable; a confirmed no-route proof is 409 without a charge.
- The known-failure CI regression of dc8 was the shared `model_not_available` message contract: the newly inserted Box-specific first match changed `classifiedMessageForCode`. Current source restores the existing message `当前模型不可用，请切换模型后再试` and keeps the proxy's explicit machine code. The added classifier test binds the Box classification to the shared taxonomy; no taxonomy/default model change is introduced.

## Additional automatic-recovery counterexample and disposition

A bound account whose cooldown expires during the original retry window can become usable without operator configuration. Filtering the proof snapshot through `eligible` removes it before evaluating bindings. The first version of the increment could therefore emit 409 while base retry could later succeed. The root accepted this example and added a scoped raw snapshot plus a clock-advance fixture for an active row with a future `cooldown_until`.

**A production form still needs explicit coverage at this observation:** production resolver `deps.list` requests status active only. A real status=cooldown bound row is absent even from the raw scoped snapshot. Existing `health.halfOpen` and successful recovery probes automatically change cooldown to active; `index.ts` registers that pool recovery actor. Thus an active-only negative proof is not complete merely because it ignores the `cooldown_until` field. A deterministic fixture can make B absent from the first active list, advance its half-open state, then return it on the next old-style resolve.

The root's proposed correction is a failure-only metadata dependency for recovery members. Missing dependency, query failure or a truncated result must preserve the old retry. It must not change the ordinary active-account list or its 500-row limit, retrieve tokens/egress descriptors, probe Box, select an alternate, or modify configuration. A simple conservative rule is to retain the old retry whenever a same-pin cooldown member exists. The normal selection remains `eligible`; only certainty to terminate becomes narrower.

Active-row `cursor_sand_access_state` can also be refreshed by the existing Cursor usage sweeper (`cursorUsageSweeper.ts`, UPDATE of the access-state field). To avoid more dynamic-eligibility special cases, the proof should conservatively inspect binding metadata of the already-read raw active scoped rows, rather than apply `eligible` again to the proof set. Any binding or incomplete metadata means uncertainty and preserves the old attempt budget. This is not permission for another account to run.

No existing server-side Cursor **session** refresh was found: `accountPoolAdapter.ts`'s cursor probe explicitly returns session_expired when expiry is insufficient; `cursorAccountSelection.ts` and `cursorMaterializer.ts` skip expired sessions. `updateCursorTokenSnapshotInTx` has no production call site in this source tree. Disabled/banned are manual-only states in the pool policy; there is no separate inactive/unhealthy automatic state to include. These findings do not authorize re-enabling disabled accounts or reading login material.

## Fixtures inspected, not executed by this reviewer

- Resolver confirmed missing/invalid; authorized launch vs inspect-only modes; bound/unknown alternative metadata without probing another account; required-account pin; explicit unbound alternatives; unknown read followed by successful unchanged resolve; active-row cooldown clock advance.
- Text unproven error remains transient; after simulated authorized repair, a new request with identical canonical body completes with exactly one launch and journal completion.
- Real ToolFetch -> FirstRound preserves the proof before admission; FirstRound after authorized repair completes with unchanged canonical body.
- Core direct proof is 409/failClient/no commit, while raw unproven UID error is 500/fail/no commit.
- Classifier preserves the shared model-unavailable message contract.

The existing `D/step2/check-user2054.sh` includes resolver, Text, real Tool, continuation, core, classifier, gateway retry tests, typecheck and lint. It was started by the root; this reviewer has not run tests or claimed their outcome. Network-none mocks prove local handoff semantics only; no new paid/real-provider evidence was collected.

## Review disposition at this observation

**REQUEST_CHANGES / pending the accepted production-cooldown metadata correction.** The temporary-I/O, bound-candidate and Tool-typing examples are addressed in the source inspected. The active-only production snapshot can still terminate an automatically recoverable pool state. After the narrow correction and its fixture are inspected, this document should append the exact new file/head binding and final verdict. This review does not request generic automatic routing, account/profile migration, or new real-model tests.

## Reviewed file SHA256 bindings

- `packages/commercial/src/http/proxy/boxAccountResolver.ts`: `80dc7615b9f46b8647a01a8c77faa97de00b28365861275d57eb9d013b588500`
- `packages/commercial/src/http/proxy/boxTextFetch.ts`: `1d5839cca0b08a9dfdfa5074321237260c10019a27f0430e56a24a5ad6134755`
- `packages/commercial/src/http/proxy/core.ts`: `1b47a5040acfa24ac8c62dcfd66abc91fadf5f37c107c23203022fe024e1ae31`
- `packages/gateway/src/errorClassify.ts`: `fa25de190cb43cab6559e9d5b2cec9f5e9ebd8adbb27540c4f6b10424eba8e8b`
- `packages/commercial/src/http/proxy/boxAccountResolver.test.ts`: `e9807e828bce46d28ae7aba4543a125a11d70d982dd2a39d9b5a03194f3eb6af`
- `packages/commercial/src/http/proxy/boxTextFetch.test.ts`: `53b2aba313a796b10b9fffa1f8c90209c41bc453fbc2ccf7165c0b6ff2ddcd85`
- `packages/commercial/src/http/proxy/boxToolFetch.test.ts`: `96424077759d7ab06dd925f695c8057c180b439a0b2f4484e93cd465558b8fa1`
- `packages/commercial/src/http/proxy/boxToolFirstRound.test.ts`: `f6d32cec30566a0c9bcc8a1bf1f97cb403988872c331bcd59d7a74ec0cc64562`
- `packages/commercial/src/__tests__/proxyCore.unit.test.ts`: `3e9da825ab58242b4ab77302a4256d13d228ace17dadd345e51264061b95d5d1`
- `packages/gateway/src/__tests__/errorClassify.test.ts`: `2cd584a6cff3810654a0fdeca3b06fa870c00f2f1ce32b38a359081cc13e8ce4`

## Final follow-up: accepted correction inspected

Observed at 2026-10-18T13:20:50.108798+00:00. Exact reviewed commit: `f6d6079a82805a1efa0957df411725b3cc7aaad7`. Worktree was clean at this read. This follow-up **supersedes the earlier pending / REQUEST_CHANGES disposition** while preserving its concrete examples and history.

**APPROVED — no remaining actionable P0/P1 counterexample found in this narrow increment.** This approval concerns preservation of existing recovery opportunities and the proven no-route classification; it does not claim universal automatic configuration repair or live candidate-backend deployment.

The final code now has a failure-only `recoveryScope` metadata dependency. Production ordinary selection still calls the original active-only list with the same 500-row limit. Only after a confirmed missing/invalid UID proxy failure and after the existing raw scoped metadata shows no bound/unknown alternative does it request the recovery metadata. Its production implementation reads Cursor metadata without a status filter and considers the result complete only below 500 rows. No dependency, a thrown query, or complete=false leaves the original error and retry path intact.

Both snapshots retain `requiredAccountId`. The proof set uses raw active scoped rows, without eligibility filtering that would hide a temporary access-state/cooldown issue. The complete recovery snapshot is then scoped to the same pin and Cursor active/cooldown members. Any cooldown member prevents proof; any active binding or incomplete binding metadata also prevents proof. Disabled/banned are not re-enabled or selected. The implementation never selects another account, changes a profile or native owner, probes another account, reads another account's credential, or writes routing/configuration/affinity as part of this check. Successful requests do not perform this new metadata query.

The production-shape fixture now models the real active-only selector: B is initially status=cooldown and appears only in the recovery metadata; after clock+1001ms and simulated existing halfOpen, B becomes active and the unchanged normal resolve succeeds. Separate fixtures retain the original error for a missing dependency, failed metadata read and incomplete snapshot. Earlier bound/unknown, transient-read and same-context authorized-repair fixtures remain present. These source assertions address the specific cooldown counterexample without adding a new routing action.

Test status boundary: at this follow-up read, tests-user2054.exit, types-user2054.exit and lint-user2054.exit did not yet exist. The root's test job is running/waiting separately. This reviewer neither invoked those tests nor calls them passed. The independent Codex increment review and exact-head CI are separate gates, not substituted by this read-only review.

### Final source SHA256 bindings

- `packages/commercial/src/http/proxy/boxAccountResolver.ts`: `79a2df09650590791e065b03ef3d12b39ce6ca5e545300b7da8b00e544c794d5`
- `packages/commercial/src/http/proxy/boxTextFetch.ts`: `1d5839cca0b08a9dfdfa5074321237260c10019a27f0430e56a24a5ad6134755`
- `packages/commercial/src/http/proxy/core.ts`: `1b47a5040acfa24ac8c62dcfd66abc91fadf5f37c107c23203022fe024e1ae31`
- `packages/gateway/src/errorClassify.ts`: `fa25de190cb43cab6559e9d5b2cec9f5e9ebd8adbb27540c4f6b10424eba8e8b`
- `packages/commercial/src/http/proxy/boxAccountResolver.test.ts`: `e9807e828bce46d28ae7aba4543a125a11d70d982dd2a39d9b5a03194f3eb6af`
- `packages/commercial/src/http/proxy/boxTextFetch.test.ts`: `53b2aba313a796b10b9fffa1f8c90209c41bc453fbc2ccf7165c0b6ff2ddcd85`
- `packages/commercial/src/http/proxy/boxToolFetch.test.ts`: `96424077759d7ab06dd925f695c8057c180b439a0b2f4484e93cd465558b8fa1`
- `packages/commercial/src/http/proxy/boxToolFirstRound.test.ts`: `f6d32cec30566a0c9bcc8a1bf1f97cb403988872c331bcd59d7a74ec0cc64562`
- `packages/commercial/src/__tests__/proxyCore.unit.test.ts`: `3e9da825ab58242b4ab77302a4256d13d228ace17dadd345e51264061b95d5d1`
- `packages/gateway/src/__tests__/errorClassify.test.ts`: `2cd584a6cff3810654a0fdeca3b06fa870c00f2f1ce32b38a359081cc13e8ce4`
