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
  second home retained the session and prior user/assistant history. This has
  not been tested between distinct real Boxes or with tool history.

## Trust and ownership

1. Authenticated OpenClaude internal `/v1/messages` remains the sole ingress.
   Reuse its container identity, per-turn model authority, role/grant check,
   rate/concurrency limits, precheck, usage journal and finalizer. A new Box
   route must be inserted **after** those gates; an operator probe must never
   be exposed as a model entry or public endpoint.
2. OpenClaude owns a `(uid, session_id)` session record with revision, selected
   account, current turn state and encrypted Claude session snapshot. A Box
   keeps only a bounded transient copy. Every request pins uid/session/model,
   account authorization, credential fingerprint and egress basis. Session
   switch is a revision-checked transfer, not an implicit Box fallback.
3. Never copy Box auth/config, arbitrary files or plugins. The only movable
   asset is the explicitly named session JSONL after strict path, owner/mode,
   size, line framing and schema checks. It contains user/model content and
   must be encrypted at rest, keyed and authorized per uid; it is never logged.
   Unique per-run Box directories, restrictive permissions, no arbitrary
   built-in tools, empty settings sources, strict MCP config and fixed argv
   keep one user's data from another user's model invocation.
4. Account/session pinning is durable; stale revision, wrong uid or concurrent
   turn returns a conflict before Box invocation. On Bot failure, a new Bot may
   receive the last committed snapshot only. An ambiguous in-flight paid call
   is never automatically replayed; reconcile/explicit retry is required.

## Request and response state machine

`ACCEPTED → RESERVED → BOX_STARTING → STREAMING → {TOOL_EXPORTED | FINAL}`

- Parse the full Anthropic request with existing strict body budgets. Do not
  flatten `system`, prior messages, thinking, images or tool results into a
  prompt as a compatibility shortcut. Phase gate: prove exact downstream
  request-shape mapping for real CCB traffic or explicitly reject unsupported
  shapes before any charge.
- Start supervised Box `claude -p` with fixed model/flags, empty setting
  sources, only fixed virtual MCP tools. The first complete `tool_use` event is
  exported before remote CLI waits for MCP. The internal API emits Anthropic
  SSE `message_start`, block start/delta/stop, `message_delta(tool_use)` and
  `message_stop`, then settles *observed* usage and persists resumable state.
- A subsequent same-session Messages call must carry an exactly matching
  `tool_result` ID. It either completes the held MCP rendezvous or launches a
  new CLI with a verified portable session snapshot; this choice remains an
  experiment gate. MCP JSON-RPC request ID and model tool_use ID are distinct.
  No local OpenClaude tool command executes in the Box.
- Final text/structured blocks must be emitted as real SSE with exact model,
  stop reason and usage. Client disconnect triggers bounded cancellation;
  unresolved remote completion is recorded as **unknown**, with no retry or
  duplicate billing. Supervisor kills the process group at hard deadline.

## Integration and accounting

- Extend the current internal proxy upstream selection with an injectable Box
  route rather than creating a second public auth stack. The route's transport
  should implement a bounded fetch/SSE-compatible contract consumed by the
  existing `runUpstreamRoundTrip`/finalizer; reuse model pricing and the
  per-request reservation/settlement path. Route only a newly catalogued Box
  variant under an off-by-default flag and only after account eligibility.
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

1. Offline CCB → internal API → Box-adapter → fake model red/green matrix for
   all captured real request fields, role order, tool IDs, multiple tool calls,
   history, image handling or explicit rejection, SSE order, usage and cancel.
2. Real Box with no user data: two distinct Box identities; portable session
   snapshot with tool history; forced Bot switch; per-user cross-read negative;
   disconnect/429/503/timeouts and non-retry proof. The Sand installer remains
   paused and is not a dependency of this route.
3. Code review to PASS; full T2 test/train; shared-branch fast-forward merge
   and push; one selfhost lease ride; post-deploy read-only health and a real
   local OpenClaude agent session that uses the API without moving execution,
   memory, skills or tools into Box. Only then lift the feature flag.

If any gate demonstrates that CC CLI cannot preserve required Messages
semantics, do not silently downgrade to a flattened-prompt proxy. Escalate
the specific incompatibility before changing the user's requested boundary.
