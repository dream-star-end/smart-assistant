# OCV5-614: S1 smoke must use the model-switch confirmation protocol

The first release passed C1/C2/C3/G1 but failed S1 with
MODEL_SWITCH_CONFIRMATION_REQUIRED on its follow-up turn. Both S1 frames use
Luna/main; there was no actual switch to a more expensive model. A pre-start
Stop has no positive executed usage, so the actual-source reader correctly
cannot establish an executed model. The follow-up uses raw WS and omitted the
new quote/confirm protocol. Do not infer actual execution from UI metadata or a
zero-usage failed target.

The user ruled at 13:45 CST: keep rel-e1b49ebea live with healthy kept-failed
state; fix the smoke, preserve real-user confirmation, review and pass CI,
then register a new formal release. Do not race building train
tr-20261024T053902Z-01d93ad8bec3 (#1081).

## Change

Only adapt S1 plainTurn and a small script-only protocol helper. Before opening
the follow-up socket, quote its exact session/request/model/agent/text/mediaCount.
Validate response identity, target, mode and booleans. Refuse canConfirm=false.
When confirmation is required, use the server quoteToken with the same input;
require requiresConfirmation=false and nonempty bounded consent. Attach only
that returned consent to the original follow-up frame. If exempt/low-cost,
send without manufacturing consent. Do not retry, refresh, swallow errors,
forge signatures or exempt MODEL_SWITCH_* rejections. Never log credentials
or authorization contents. Assert login uid765 before either real turn.

Keep the existing model, agent, peer/cmid relationship, all timeouts and all
Stop assertions: immediate Stop after admission, interrupted commit, user-stop
notice, no permission/waiting request, and a completed follow-up with a new cmid.
No product reader/service, pricing, routing, threshold or user-confirmation change.

## Validation and release

Pure Node helper tests cover risk quote/confirm with identical bound inputs,
no-confirmation quotes, insufficient balance, malformed/mismatched responses,
missing consent, a confirmation that still requires action, and API errors
without retries. Existing S1 assertions remain; syntax-check the entry script.
No local commercial tests or real requests while #1081 is building.

Default plan review and default code review are each round 1/max 1 for this
small follow-up PR. Require the final hosted CI all SUCCESS. Then wait for FREE,
load<6, at least8GiB available memory and no in-flight turns; register one new
deploy:selfhost ride. Reconcile the formal S1 result and then run the pending
uid765 large-context estimate/cancel/confirm, unknown-count B, five-minute chat,
billing and desktop/mobile evidence. Keep all worktrees and evidence.
