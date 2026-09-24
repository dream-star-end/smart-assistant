# OCV5-289 · Box Claude CLI as an internal Messages model API

Status: design, **not production-ready**. Scope: V5 selfhost. Box runs only
`claude -p` plus a fixed virtual MCP bridge; OpenClaude user containers retain
the actual agent, memory/skills/prompt construction, tool execution and UI.

## Evidence already obtained

- Operator-only, account-20 official credential/egress path can obtain Box Exec
  without requiring the paused Sand installer. Real Box Claude Code 2.1.280
  passed fixed version/help, synthetic text inference, parallel Exec and a
  one-tool synthetic roundtrip. See `scripts/ocv5-289/boxExecProbe.ts`; this is
  not an API or live user traffic path.
- On the same CLI version and a fake Messages endpoint, stdin `assistant`
  `tool_use` followed by a `user` `tool_result` + text preserved roles and tool
  block types in one underlying request. Multiple `user` stdin lines caused
  multiple model requests, so arbitrary history replay through stdin is **not
  yet proven**.
- An offline text-only test copied **only** a Claude session JSONL to a new
  `CLAUDE_CONFIG_DIR` at the same relative project path. `--resume UUID` on the
  second home retained the session and prior user/assistant history. A later
  same-machine test also preserved a completed virtual-tool pair. Neither
  has been tested between distinct real Boxes.
- Further offline testing proved a minimal synthetic JSONL can restore
  **completed** text/tool history, but a snapshot ending in a pending
  `assistant.tool_use` did **not** accept a matching streamed `user.tool_result`:
  the CLI replaced the pending block with `No response requested.` and dropped
  the result from the downstream request. The adapter therefore cannot switch
  Bots mid-tool by simply staging a transcript and resuming a new CLI.
- A real Box (account 20, Claude Code 2.1.280) received an isolated synthetic
  JSONL containing a completed `tool_use → tool_result → assistant` history.
  With no nonce in the new prompt and no available tools, `claude -p --resume`
  returned the exact random text from the prior tool result (success, observed
  usage 2 input / 20 output). This proves text retrieval from completed tool
  history on one Box, **not** full role/order fidelity of its paid upstream or
  switching between two independent Bot accounts.

## Trust and ownership

1. Authenticated OpenClaude internal `/v1/messages` remains the sole ingress.
   Reuse its container identity, per-turn model authority, role/grant check,
   rate/concurrency limits, precheck, usage journal and finalizer. A new Box
   route must be inserted **after** those gates; an operator probe must never
   be exposed as a model entry or public endpoint.
2. For a **completed** turn, the authenticated OpenClaude Messages request is
   the history authority. Generate a fresh, bounded session JSONL from that
   request, stage it into an isolated per-run Box directory, and delete it
   after known terminal completion. This removes the need to copy a prior
   Box's session file or persist a second complete-history authority merely
   to switch Bot accounts. The mapper is version-pinned to Claude Code 2.1.280
   and rejects current `tool_result`, pending tool history, unsupported blocks
   and mismatched IDs instead of flattening them. Any real CCB field outside
   the tested subset remains a gate, not a silently ignored option.
3. OpenClaude owns a durable `(uid, session_id)` **in-flight** invocation
   record with revision, selected account, tool ID, deadline and unknown
   status. Every request pins uid/session/model, account authorization,
   credential fingerprint and egress basis. Session switch is allowed at a
   completed turn boundary; it is not an implicit mid-tool fallback.
4. Never copy Box auth/config, arbitrary files or plugins. Stage only pinned
   supervisor/virtual-MCP assets and server-generated, explicitly named
   system/stdin/catalog/session files after strict path, owner/mode, size,
   hash, framing and schema checks. The system/stdin/session files contain
   user/model content and are never logged. After known remote termination
   they are deleted; an unknown completion is retained only under a fenced,
   bounded recovery/GC policy, never deleted on the mere loss of a transport
   response. Unique per-run Box directories, restrictive
   permissions, no arbitrary built-in tools, empty settings sources, strict
   MCP config and fixed argv reduce cross-invocation exposure, but are **not**
   a same-UID security boundary; cross-user negative tests remain mandatory.
5. Account/session pinning is durable; stale revision, wrong uid or concurrent
   turn returns a conflict before Box invocation. On Bot failure, a new Bot may
   receive only a freshly compiled snapshot from an authenticated request's
   **completed** history. An ambiguous in-flight paid call is never
   automatically replayed; reconcile/explicit retry is required.

## Request and response state machine

`ACCEPTED → RESERVED → BOX_STARTING → STREAMING → {TOOL_EXPORTED | FINAL}`

- Parse the full Anthropic request with existing strict body budgets. Do not
  flatten `system`, prior messages, thinking, images or tool results into a
  prompt as a compatibility shortcut. Phase gate: prove exact downstream
  request-shape mapping for real CCB traffic or explicitly reject unsupported
  shapes before any charge.
- The same-version CLI still prepends its own billing/agent system blocks to
  `--system-prompt`; OpenClaude's system text appears after those blocks. Do
  not claim byte-for-byte Anthropic API equivalence until the full CCB request
  matrix and resulting behavior pass; preserve and test user-visible system
  text order within the supported subset.
- Start supervised Box `claude -p` with fixed model/flags, empty setting
  sources, only bounded virtual MCP tools compiled from the OpenClaude-side
  Claude Code request. The internal API may progressively emit Anthropic SSE
  `message_start` and content blocks, but before `message_delta(tool_use)` /
  `message_stop` it must validate the whole model message and persist that
  round's observed usage/pricing and resumable tool set. Settlement follows
  from that durable evidence; it is never inferred from terminal SSE alone.
- A subsequent same-session Messages call must carry an exactly matching
  `tool_result` ID and complete the **held** MCP rendezvous in the same
  supervised CLI process. The snapshot-and-new-CLI alternative was rejected
  by the pending-tool replay test above. MCP JSON-RPC request ID and model
  tool_use ID are distinct. Offline real Claude Code 2.1.280 exposed the
  exact model tool ID in `tools/call.params._meta["claudecode/toolUseId"]`
  (synthetic one-tool replay green). A real account-20 Box `claude -p` one-tool
  probe also verified that metadata against the streamed model tool ID and
  returned the local synthetic result exactly. This is the correlation key
  for parallel same-name/same-argument calls, not positional matching. Actual
  multi-tool concurrency and cross-HTTP handoff still need red/green proof
  before use. No local OpenClaude tool command executes in Box.
  The new catalog-driven `box_virtual_mcp.py` has an offline two-identical-call
  reverse-result test and a real account-20 Box **one-tool** probe: model ID
  matched the pending MCP call, the locally chosen result was returned exactly,
  and the supervised invocation exited successfully. This is protocol evidence,
  **not** a claim that multi-tool or cross-HTTP production handoff is complete.
  An offline real CC 2.1.280 two-tool stream showed `assistant` snapshots
  interleaved with `content_block_delta`/`content_block_stop`, then one
  `message_delta(tool_use)` and `message_stop` **before** the two MCP results
  appeared. The first HTTP response may expose progressive blocks, but must
  withhold terminal SSE until the complete model tool-ID set is journaled,
  at least one currently dispatched owner-scoped sidecar pending record is
  verified, and the durable handoff/usage revision is committed. Remaining
  pending records are verified by ID as Claude Code dispatches them later;
  waiting for all of them here would deadlock this observed serial schedule. The CLI
  then produced a second `message_start` in the same process after both local
  results. In this observed run CC dispatched the two MCP calls sequentially;
  the sidecar's reverse-order parallel unit test is a capability test, not an
  assertion about that run's scheduling.
- The held CLI is owned by a **cross-HTTP Box invocation lease**, not by the
  first request's abort signal or finalizer. Normal `message_stop`/`res.end`
  after exporting tool_use must leave the supervised CLI and account-capacity
  lease live for the matching next request. Premature client disconnect before
  a complete handoff, explicit cancel, lease deadline, or account revocation
  must terminate the process group and mark the invocation terminal/unknown as
  appropriate. A bounded per-account and per-user semaphore remains held
  across the two HTTP requests even though the first request settles/releases
  its **request** billing reservation. The second request cannot create a new
  Box invocation if this lease is pending; it must consume the matching one.
  Egress/master restart loses the live handle: durable state must fence the
  lease and report unknown, never auto-replay a paid call or local tool.
- A Bot switch may compile and stage fresh history only at a **completed turn
  boundary**. An in-flight tool call cannot be transparently migrated;
  on loss, record an unknown outcome and require explicit recovery/retry from
  the last committed state rather than claiming seamless mid-call failover.
- Final text/structured blocks must be emitted as real SSE with exact model,
  stop reason and usage. Client disconnect triggers bounded cancellation;
  unresolved remote completion is recorded as **unknown**, with no retry or
  duplicate billing. Supervisor kills the process group at hard deadline.

## Integration and accounting

### Durable invocation journal (design freeze; no migration applied yet)

Use new selfhost-only PG invocation **and per-model-message round** records.
Do not overload `request_finalize_journal` (one billing HTTP request) or
`turn_dispatches` (one user-container agent turn): a held CLI can span an
arbitrary positive number of tool cycles and Messages HTTP requests. The
invocation row carries `invocation_id`, uid, OpenClaude session ID, stable
**logical model-call ID**, immutable request hash, selected account, Box run
nonce, catalog/model IDs, owner ID/lease epoch/deadline, state/revision and
terminal/unknown evidence. A round row keyed by `(invocation_id, round_no)`
carries that HTTP request's stable billing ID, tool ID/name/input hashes,
observed usage, immutable pricing basis/hash, and settlement evidence. No
credential, prompt, tool arguments/results or Box session snapshot in PG.

- The OpenClaude-side model-call boundary mints a stable logical ID **once**.
  Its transport retries reuse that ID; a deliberate new call (even with
  identical body) gets a new ID. Reserve by `(uid, logical_call_id)` before
  potentially paid work. The request hash only proves immutable content for
  that ID, never defines identity by itself. A duplicate cannot start another
  CLI; a completed duplicate returns cached verified output or a loud
  already-executed result, not a fresh paid call. This needs a real
  container→master ID transport; gateway-generated per-HTTP request IDs are
  not a substitute. An offline real official CC 2.1.280 two-model-call probe
  found the same `x-claude-code-session-id` and `oc_turn_key` on both requests,
  **no per-model-call ID header**, while request bodies differed after tool
  results. Thus `turn_key + body_hash` is useful as a retransmission hint but
  cannot be the full logical identity: an intentional identical request in
  the same turn is indistinguishable. The Box route needs an OpenClaude-side
  model-transport boundary (e.g. an authenticated user-container loopback
  forwarding shim) that mints and persists one ID per actual API call, reuses
  it for that call's network retries, and sends it to the existing master
  proxy without moving prompt construction, memory or tools to Box. Until
  that exact behavior is proven, keep the catalog route disabled.
  Reuse the **existing user-container GatewayServer** for this private
  loopback-only shim; do not create another user-facing API or an agent process.
  For a Box-authorized CCB turn, `SubprocessRunner` points only that turn's
  `ANTHROPIC_BASE_URL` at the local shim; it forwards to the same authenticated
  master `/v1/messages` endpoint with original container credentials and
  signed model-authority headers intact. The shim buffers only the already
  bounded request body, assigns a random per-call ID before forwarding,
  and adds `x-oc-box-call-id`. It keeps `(turn_key, request_hash) → call ID`
  while a response is in flight/unknown, reusing the ID on a transport retry.
  A fully delivered terminal response retires that mapping; a subsequent
  independent call gets a fresh ID even for identical content. On ambiguous
  delivery the mapping stays fenced, and master rejects or serves verified
  cached output for the same ID—never starts a second paid CLI. Master still
  binds that ID to authenticated uid/session/turn/model/body hash in PG;
  neither a forged header nor a new ID can bypass its open-invocation conflict
  gate. Transparent SSE forwarding, cancel/backpressure, bounded buffering,
  redirect prohibition and no credential logging need same-entry tests before
  replacing any live `ANTHROPIC_BASE_URL`.
- Use monotonic revision/lease epoch on every state change. State path:
  `reserved → starting → streaming → handoff → resuming → streaming → ...`
  then `terminal`; each new model message increments `round_no`. Any
  ambiguous transport, owner loss or mismatched proof goes to `unknown` (or
  explicit `manual_reconcile`), never back to `reserved`. Per-uid/session and
  per-account capacity remains held across all rounds and HTTP boundaries.
- The first model message may request A and B while Claude Code dispatches
  their MCP calls **serially** (observed in real CLI2.1.280): B's pending file
  can appear only after A's result. Therefore do **not** wait for every Box
  `pending.<tool_id>.json` before closing the first HTTP response. Instead,
  validate the complete streamed model message and final assistant snapshot,
  persist the **full** model tool ID/name/input-hash set plus per-round usage
  and pricing evidence in one transaction, and require any *currently
  dispatched* pending files to match. A nonempty owner-scoped pending subset
  proves the CLI entered tool dispatch; remaining IDs are checked only when
  their pending files appear. The transaction returns a durable revision;
  only then emit first-response `message_delta(tool_use)`/`message_stop`.
- The next authenticated Messages request must match uid, session, model,
  prior round number and the **full model tool-ID set**, with exactly one
  `tool_result` per ID (including error flags/content hashes). Claim
  `handoff → resuming` under CAS. Publish A's result once, wait for B's
  owner-scoped pending record, validate its ID/name/input, then publish B
  once; never publish by order or before its pending record exists. If another
  model response requests C, persist a new round and hand off again. A
  timeout or crash after any publish is `unknown`, not a reason to republish
  any result or restart `claude -p`.
- Before **each** round's terminal SSE (tool-use or final text), persist exact
  observed usage and the frozen pricing basis bound to its stable billing ID.
  The existing per-HTTP `request_finalize_journal` must carry a Box durable
  recovery marker: its legacy timeout-abort/GC path must exclude these rows.
  A Box-specific reconciler settles from round evidence idempotently against
  `usage_records`/ledger and emits the cost frame when recoverable. Without
  durable usage/pricing evidence, neither terminal SSE nor a claim of
  billable success may be emitted; mere transport closure is not evidence.
- A restart may lose the live Connect response. The reconciler must never
  infer remote termination from elapsed time or a vanished local handle;
  it needs a Box-side run-nonce/epoch-bound terminal/watchdog marker read
  through the pinned account and egress. A kill request alone is not proof.
  Without proof, keep `unknown`, capacity fenced and alert for manual
  resolution. With proof, close resources and settle only from durable round
  usage evidence. No automatic paid-call or local-tool replay on takeover.

This schema/state design is not approval to apply a data migration. The next
free migration number and shared-branch tip must be rechecked at merge, and
the user must approve migration execution before release.

- Extend the current internal proxy upstream selection with an injectable Box
  route rather than creating a second public auth stack. The route's transport
  should reuse existing identity, authority, pricing and **per-request**
  reservation/settlement. The current `runUpstreamRoundTrip` may be reused
  only if the Box transport explicitly detaches a completed tool handoff from
  its `req/res close` abort and from its account-capacity release; otherwise
  use a narrow Box-specific round-trip after the shared gates, with an
  independent durable Box invocation lease. Do not add a second public auth
  stack. Route only a newly catalogued Box variant under an off-by-default
  flag and only after account eligibility.
- **Do not inherit the existing provider-bound-history retry** in
  `proxy/core.ts`: on selected upstream 400 it currently strips signed
  assistant/thinking blocks and calls `fetchFn` again. Box requests must
  preserve all history or reject it once, before a charge when possible.
  Implement a narrowly scoped `noHistoryRewriteRetry` route policy; in Box
  mode every unsupported-history/400/ambiguous outcome is terminal, never a
  second Box invocation. Lock this with same-entry red tests: simulated
  `invalid signature` must leave serialized history unchanged and invoke the
  Box transport exactly once. Do not globally remove legacy retry behavior.
- Egress process currently owns internal `/v1/messages`; Box Exec account
  resolution must run there or through an authenticated, bounded master RPC.
  Which option is chosen is an integration decision, not proven by the
  operator-only script. Never move decrypted account tokens into user
  containers or log Exec tickets.
- Unit/contract tests must prove one and only one settlement for success,
  failure, tool handoff, cancellation and unknown outcome. Usage source must
  be the CLI/underlying model event with explicit accounting semantics; the
  synthetic probe's token numbers are observation, not a price contract.

## Mandatory gates before enabling any catalog model

**Direct-CC experience parity is a release gate, not a post-launch goal.**
Use the same OpenClaude user container, Claude Code version, synthetic prompt,
platform memory/Skill fixtures and local tool fixture for paired runs: current
direct CCB route versus CCB through the internal Box model API. Assert the
business outcome and event chronology, not just a mock invocation:

- The OpenClaude-side agent still receives memory and Skills; Box receives
  only the model request. A random local-only tool value is executed once in
  the user container and appears in the final answer; no Box-native tool may
  execute it.
- Text and tool events stream progressively. First visible delta must arrive
  before the Box CLI reaches terminal status; ordinary deltas, tool_use and
  terminal SSE must remain ordered. The current **buffered text-only prototype
  fails this gate** until a bounded live stream/journal replaces it.
- A tool_use response ends normally, the next request's matching tool_result
  resumes the same held CLI, and two user turns preserve conversation context.
  Switch to another eligible Bot only at a completed-turn boundary, without
  replaying a side-effecting local tool or charging the same model call twice.
- Stop, client disconnect, upstream 429/503, tool error and restart/unknown
  paths show the same understandable UI lifecycle and never silently retry a
  paid or side-effecting operation. Compare usage/credits with real ledger
  rows, not only the synthetic UsageObserver.
- Compare image, thinking/effort, context-window and max-output behavior that
  direct CCB exposes. Unsupported shapes must remain disabled; do not call a
  text-only pass "experience parity" or silently flatten/strip content.
- The returned model ID must match the advertised version. A Box response
  labelled `claude-opus-5` cannot be sold or displayed as Opus 5.5.

Record direct-route and Box-route first-delta latency, inter-delta gaps,
tool-roundtrip latency and failure rate under the same synthetic workload.
Any material regression is a release blocker to investigate, not something
to hide by buffering and sending a completed response all at once.
Freeze the following quantitative bar **before paired tests** (one exploratory
Box-only nonce run was already observed; it is not a paired result): at least
10 alternating direct-CC/Box pairs on the same user container, CLI 2.1.280,
Opus 5.5, prompt/tool fixture and effort, with warm and cold cases recorded
separately. End-to-end first-visible-delta overhead must be ≤3s at p50 and
≤6s at p95; p95 inter-delta gap ≤max(2s, 2× direct); p95 local-tool roundtrip
overhead ≤6s. For a long-output fixture whose direct-CC first-to-last visible
delta span is ≥2s, Box must produce ≥3 distinct visible delivery times and a
span ≥50% of direct, not a terminal burst. Any failed business result,
duplicate local tool, missing cost frame/ledger row, wrong model ID, or
unsupported direct-CC request shape is a hard fail regardless of latency.
Do not loosen these thresholds after seeing paired results without an explicit
user decision and a documented UX tradeoff.

1. Offline CCB → internal API → Box-adapter → fake model red/green matrix for
   all captured real request fields, role order, tool IDs, multiple tool calls,
   history, image handling or explicit rejection, SSE order, usage and cancel.
   One same-entry test must end the first HTTP response normally after
   tool_use, then deliver a matching second HTTP request to the **same live**
   supervised CLI and prove exactly one local tool execution and no duplicate
   Box model invocation. Separate tests cover premature disconnect, explicit
   cancel, lease expiry and restart/unknown outcome.
2. Real Box with no user data: two distinct eligible Box identities; generated
   completed history with tool pair; forced Bot switch; per-user cross-read negative;
   disconnect/429/503/timeouts and non-retry proof. The Sand installer remains
   paused and is not a dependency of this route.
3. Code review to PASS; full T2 test/train; shared-branch fast-forward merge
   and push; one selfhost lease ride; post-deploy read-only health and a real
   local OpenClaude agent session that uses the API without moving execution,
   memory, skills or tools into Box. Only then lift the feature flag.

If any gate demonstrates that CC CLI cannot preserve required Messages
semantics, do not silently downgrade to a flattened-prompt proxy. Escalate
the specific incompatibility before changing the user's requested boundary.
