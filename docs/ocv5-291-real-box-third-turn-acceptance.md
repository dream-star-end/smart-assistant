# OCV5-291 · real Box native-resume acceptance (selfhost operator lane)

The existing signed `boxSignedToolLiveProbe.ts` has already passed one real
account-20 synthetic tool roundtrip with `OC_BOX_NATIVE_RESUME=1`: one local
tool execution, two authenticated HTTP requests, two usage/ledger rows,
terminal proof, cleanup done, no unknown. A read-only check of the final
request journal confirms a native UUID + transcript SHA pointer and positive
cache-read usage. This **does not yet prove a new completed user turn resumes**.

## One extra, explicitly acknowledged turn

Add an opt-in `OCV5_291_THIRD_TURN_ACK=1` to that same operator-only signed
probe, not a new public route or standalone paid Box Exec. The existing
account/user/container checks, operator mutex + durable unknown evidence,
pricing gate, signed container identity, journal admission, one-call replay
fence, Box target pin, terminal proof, cleanup and ledger checks remain.

After the second tool-result HTTP request has a proven final message and
`boxRemoteCleanup=done`, read its journal native pointer. Require same account,
session, valid UUID/SHA and owner run cwd. Construct a **third** authenticated
Messages request in the *same OpenClaude session* but a new 64-hex turn key:
copy the **second canonical body** (model, max_tokens, stream, system, tools,
`tool_choice:auto`), then set messages to exactly `second.messages`, followed
by the complete `assistantContent(secondEvents)` block array (including any
thinking/signature), followed by one new text user message. Do **not** concatenate
`first.messages` again, move instructions into system, change tool choice, or
include the synthetic secret in the new user text. Put "do not call the tool
again" only in that text. Before paid dispatch, verify the assistant blocks
hash to the second pointer's `assistantContentHash`; mismatch aborts this
operator acceptance rather than falling back to synthetic and claiming PASS.

The adapter must select native warm resume via its normal pointer lookup,
remote SHA preflight and atomic predecessor claim; it must dispatch exactly
one paid `claude -p --resume <same UUID>` (no synthetic history file upload).
Accept only a final answer equal to the unpredictable local-only result,
zero additional local tool executions, no `tool_use` in the third response,
**and** durable evidence that it was a native hit rather than an answer from
the synthetic snapshot: second row `boxNativeClaimRequestId=thirdId`; third
row `boxNativeOwnerRequestId=secondId`, `boxNativeSessionId` and
`boxNativeCliCwd` exactly equal to the second pointer, uid=3, account=20 and
the same OpenClaude session. The third row must have terminal proof, positive
observed usage/cache-read tokens, exactly one usage record, and matching debit
ledger (allow the existing 1–4 negative ledger splits per usage record),
plus remote cleanup `done`. Native transcript SHA may grow; it need not equal
the second SHA. Answer equality or cache-read tokens alone are **not** native
proof, because a synthetic snapshot could also contain the local token.
Measure signed-entry-to-first-visible-delta and
total time for cold first round, tool continuation and warm third turn.

Before the third call, mint `thirdId`, extend the operator evidence lock by
atomic write/fsync/rename (retain firstId/secondId and their identity), and
permit exactly one third `admit` in the wrapper without overwriting the first
paid-call evidence. Normal synthetic operator mode currently uses the request
header rather than `assignedRequestIds`; for the new third-turn mode, explicitly
assign `[firstId,secondId,thirdId]` and reject a fourth slot to bind order.
On any unknown or failed assertion after a paid dispatch, retain the lock and
journal evidence; **do not automatically retry** the third call or clear its
run. Stop and reconcile by existing official proof path. A request that ends
in another tool handoff is a failed acceptance, not permission to publish a
fabricated local result. No commercial production, account gate bypass,
database migration, user prompt or credential copy. Do not enable the model
flag until this probe, the existing offline/PG negative controls (wrong
user/account/session/assistant, duplicate claim) remain green, full T2 audit
and release gates pass. Do not pay for a cross-user or second-account negative
probe. The direct-Bot latency parity comparison is still deferred until a
legitimate direct Claude account is available; do not claim it passed.
