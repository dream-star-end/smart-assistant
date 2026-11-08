# Codex remote master contract (OCV5-746 segment 2)

Status: code-only. No production migration, node install, enabled profile or container adapter is
implied. Segment 3 must implement the container runner/tool host and provide deployment acceptance
before any `execution_ready=true` manifest is issued. Segment 4 changes the CC controller digest
(guard must be reinstalled); its native CLI digest and protocol remain unchanged.

## Signed identities

- `RemoteExecutionBackend` is a closed union. CC retains its byte-compatible 3 fields.
- Codex: `kind=codex-app-server-v1, version=1, sessionKey, operationId, generation, profileId, authEpoch`.
  It is valid only with engine=codex and a canonical `*-remote` model. Not CCB/cc5.
- Master binding v3 adds uid/containerDbId/full dockerId/runId/manifestSha256/capability/expiresAt.
  The read-only container view keeps `binding.json` and `relay.sock`. Node authority is not delegated
  to the user container; SSH target/key/argv come only from the master placement.
- Placement commits the original recovery spec **before** exposing a lane; generation is CAS-fenced.
  Chat advisory lock + ordered profile row locks serialize account occupancy; no shared node row
  or node+engine capacity gate. `remote_agent_profiles.max_concurrent_lanes` defaults to 5 per
  (node,engine,profile); every non-released binding, including unknown, occupies only that pool.
  Different engines do not contend on placement profile locks. Candidate profiles of the same
  engine can briefly wait on each other's row locks; there is no claim of entirely wait-free placement.
  Legacy node `max_active_slots/shared_active_cap` and profile `max_active_slots` are unchanged
  for rollout compatibility but are not read by new placement. The new field is SQL-configurable
  (1..64); the legacy admin UI is not a capacity editor for this new gate.
  Codex begins with durable `remote_start_attempted=false`. Before any provision, a generation CAS
  requires `state=running` and marks it true. Recovery can CAS-release a still-false generation even
  if the master crashed before creating a socket/root; the old relay can no longer pass its start CAS.
  Failed creation closes the unexposed view; the runtime never publishes an owner before running commits.

## Master relay HTTP (POST, Unix socket, bounded JSON)

Every request supplies binding uid/containerDbId/dockerId/sessionKey/operationId/generation/capability.
No generic SSH command or native config is accepted.

- `/admit`: authority, lease, turnKey (64 hex), catalog `{tools:[{name,inputSchema,...}]}`.
  Verify fresh signed admission + DB dispatch + pricing + reservation before provision/start.
  Stable tool catalog per lane. Later effect RPCs accept expired admission **with a fresh matching
  lease**, because the 120s authority TTL only gates admission.
  Reply carries `seq`, this admission's output baseline: a container kernel that restarts after a
  cancel must not read frames published for the turn it abandoned. One lane may hold several
  admissions (a chat keeps its resident node across kernel restarts), so JSON-RPC kernel ids are
  scoped per admission and the relay gives the node a lane-unique id, mapping the answer back.
  An answer to an abandoned admission is recognized by its epoch and dropped, never delivered to
  the restarted kernel whose ids restarted at the same numbers.
- `/rpc`: `frame` from the closed initialize/model/list/account/read/mcpServerStatus/list,
  thread/start/resume/read and turn/start/interrupt grammar. Master fixes the model and the node
  independently pins sandbox/policy/catalog. Text-only, supported efforts only; no Fast/image claims.
  Native thread response is bound to the original persisted baseline before a turn is dispatched.
  One admission claims that thread boundary exactly once: a resident node reused by the next turn
  binds before its kernel answers, and a kernel that restarts inside the admitted turn re-attaches
  to the same thread, so the later attach proves the same thread and reuses the recorded baseline
  instead of claiming the boundary again (the finance turn owns a one-shot claim).
- `/poll`: `afterSeq`. Retained frames are acknowledged by the next sequence cursor; bounded output.
- `/baseline`: returns the current output `seq`. A container that restarts its kernel **inside** an
  admitted turn (route change) continues after the frames already published; it never re-renders
  the part of the turn it rendered before the restart.
- `/tool/next`: at most one delivery per call; returns original request, binding, authority, lease,
  turnKey. The container executes tools; the master and node never run model tools.
- `/tool/result`: callId + bounded CCB result. `/tool/ack`: callId after receipt delivery.
  A terminal is delivered only after native tool completion, all tool ACKs, durable v3 receipt and
  independently proven finance result. Exact duplicate terminal is idempotent; conflicting duplicate fences.
- `/renew`: a fresh matching lease, no new authority required for the admitted turn. The container
  owns the rolling renewal (renew at 30 min of the 50 min window, `TURN_LEASE_RENEW_AFTER_MS`) for
  the whole current turn and stops it at the terminal or the lane stop; the lease the turn was
  admitted with is never the last one it uses. The master re-arms its expiry fence on every accepted
  renewal, so a long turn must never be fenced at the window it admitted with. The renewed lease is
  live on the master before the container consumes the ACK, so a `/tool/next` delivery may carry it
  first; the container accepts any lease signed for the exact admitted turn (signature plus the full
  authority binding), never an arbitrary old credential, and a renewal ACK that lands after its turn
  ended never rewrites the next turn's admission.
- `/abandon`: turnKey. Closes an admission that never reached `turn/start` (the kernel cancelled
  the turn locally before dispatch). Accepted only while the lane is active, not dispatching, and
  the turnKey is the admitted one; a dispatched turn can only end through its native terminal.
  No receipt is written and no usage is fabricated: the closure is a durable, identity-exact proof
  that nothing reached the model — the journal row is aborted with zero credits only while its
  stored `input` and `receipt` are still null, and a bound thread's `pending_request_id` is released
  only when it is still this request and its ledger total is still the baseline recorded at bind.
  A closure that cannot be proven keeps the lane closed instead of guessing zero effect, and the
  reply is only sent after the proof. The lane then stays usable: the next admission continues
  after the frames the master already published, and the freed reservation follows the normal
  soft-reservation release.
- `/stop`: first revoke effects, drain any in-flight finance admission, then independent node
  stop/prove plus local tool host proof. A delayed admission cannot start after revocation. A newly
  admitted reservation without any current-turn provision/input is aborted, including a completed start marker
  when the trusted relay still proves no host effect; started/unknown effects never become zero usage.
  Resident app lifetime does not count as the next turn's host/input effect. Current-turn flags reset
  before asynchronous admission; a stop during that admission cannot inherit the previous turn's flags.
- `/tool/stopped`: only after revocation; current authorityTurnId + turnKey required. A previous turn
  cannot provide proof for the current host. Late valid proof can finish a previously unknown stop;
  it never replays a model, input or tool. The container must tear down tools before sending it.

Native `item/started(mcpToolCall)` on app-server stdout is the master authorization source, **not**
MCP metadata. Match callId + nativeThreadId/nativeTurnId/server/tool/canonical arguments SHA256.
MCP-first delivery waits for stdout without blocking stdout processing. Replay/forgery/unknown item,
non-ocbridge server or any server→client request revokes effects and fences. Original fixed error
code stays in the journal. Raw arbitrary stderr is not exposed.

## Probe and publication

Schema2 source=`codex-app-server:model/list`, runner_mode=`app-server`. Failed probes also persist.
The read-only snapshot supplies actual modelList, corresponding raw modelCatalog, CLI/native/controller
SHA256 (native binary is hashed in bounded chunks; no auth content is exported). Probe never sets ready.
Readiness requires a matching master manifest: version1/backendKind/authEpoch/snapshotSha256/
controllerSha256/gatewayRevision=`codex-remote-adapter-v1`/e2eReceiptSha256/installed=true/text=true.
There is deliberately no fabricated acceptance producer in this segment.

Offers use `<upstream>-remote`; missing explicit same-upstream prices reject rather than use Claude
fallback. Effort/default are observed. Observed vision/service tiers survive DB→catalog→public
projection; effective vision/Fast remain false because the currently proven node path is text-only.
Changed snapshot/auth removes readiness; last eligible Codex profile becoming unready disables its
active catalog entry. A probe cannot automatically reactivate it. Publication must be re-accepted.

## Receipt v3 and recovery

Five native dimensions: input/cachedInput/cacheWriteInput/output/reasoningOutputTokens.
`nativeUsage = final total - last persisted thread total`; NEVER bill `last`. Cache-read is subtracted
from billable input, reasoning is not added to output again. Nonzero cache-write currently rejects
as unproven. Failed/interrupted/no-output policy matches CC: zero debit, but completed observed usage
boundaries still advance. Missing terminal/total is unknown, not zero.

PG `remote_native_threads(uid,operation_id,native_thread_id)` owns total and pending request;
`remote_native_turns(uid,operation_id,native_thread_id,native_turn_id)` owns a unique original request.
Receipt + baseline advancement + journal terminal persist atomically. No new thread generation can
step past an unresolved prior admission. Committed journal with unfreed boundary is recovered too.
Model switches keep the same thread baseline under the row lock; profile/auth must match and pending
must be empty. `upstream_model` records the newly bound model while each receipt and pricing snapshot
remain immutable for their original turn. Recovery may abort only an unchanged prehost journal when
its exact generation has been independently released and that current journal has no native/input
boundary. Codex cannot dispatch a turn without both markers, so an older resident app's scopes do not
make the new admission unknown. Node `fence-stop`/proof additionally records `no_host_effect_proven`
when scopes are empty, covering the start-marker-before-provision window. The next generation resets
both proof state and attempt state; no prior proof can release it.

Master durable spool: `/var/lib/openclaude/remote-native/<operation>/<generation>/journal/`.
`native-terminal` is fsync'ed before billing. Existing finalize reconciler imports only the original
admission's receipt if DB persistence failed; no re-admission/model/tool replay. Generic/local Codex
cleanup cannot consume a remote-native marker. Recovery without full settlement proof stays pending.

Independent capacity recovery is wired into master placement after an orphaned binding miss, and
available explicitly (root, deployed master environment):

```
tsx scripts/reconcile-remote-native-lane.ts <operation-uuid> <generation>
```

This command does NOT stop a user container. Normal container lifecycle must first stop/remove the
old full Docker ID. Responsive Docker daemon + exact-ID process absence and old-generation independent
node proof are both mandatory for any remotely attempted generation. Only then CAS-release capacity;
financial pending remains untouched except the exact prehost/no-input abort described above.
Master sends the immutable manifest to node `fence-stop` before `prove-stopped`: a root that never
existed is durably fenced against delayed provision, not guessed stopped from a missing file.
Pre-migration CC bindings use the 0333 deterministic root scheme and immutable node/profile IDs to
persist a recovery spec, then require the same independent proofs. Missing identities quarantine;
there is no Codex legacy format or TTL clearing.

## Migration/verification boundary

The selfhost migration chain now includes the **original SQL** of commercial migrations
`0334_users_registration_ip` (ab7e0489e) and `0336_commercial_muse_durable` (f5a768db6), not their
feature code. Only per-statement compatibility comments were added to satisfy the selfhost CI gate;
removing those new comments restores the source bytes exactly. Existing claims remain `0335_codex_remote_native → 0334_users_registration_ip` and
`0337_remote_engine_concurrency → 0336_commercial_muse_durable`; no renumbering or dummy migration.
The imported `none` comments describe those original commercial release lines, not permission to
skip dependencies in this integrated tree. Order: selfhost 0333 → 0334 → 0335 → 0336 → 0337.
All four are registered as required. Tests replay the mainline schema through 0333 and use the
**production migration runner** for all four, including exact applied-version order and old users/Muse
writes. Readiness stays off by default; old writers leave new nullable fields null. No production
migration is authorized by this change. Native financial tables remain permanent anti-replay ledgers.

R1 lifecycle contract: preparation failures keep a generation-specific stop owner until proof;
unknown stops keep their slot. Missing Codex profiles (including an entirely absent engine) revoke
readiness and withdraw only models with no remaining eligible offer. A resident relay owns the
single native initialize handshake; reattached container kernels receive only its proven response.
Container tool hosts share the CC context builder (MCP/settings/session/agent/delegate context,
model credentials removed). That configuration stays in the container. Read-only/consult turns
are rejected before tool-host/admission because this remote adapter does not yet support them.
Retired local hosts and the lane control connection survive kernel recycle until both local and
remote stop proofs pass; unavailable proof is an error, never successful shutdown.

Node resource rejection distinguishes `REMOTE_NODE_MEMORY_EXHAUSTED` (memory) from
`REMOTE_NODE_TASKS_EXHAUSTED` (process/thread budget), each with bounded `activeSessions`. Memory maps to
“远端节点内存不足，当前底座已有 N 个会话在跑（本次未计费）”. Only the trusted startup boundary,
independent remoteStopped proof and absence of input/native effect can close the journal at zero:
`aborted`, `final_credits=0`, no usage, existing `failure_code=INTERNAL_ERROR`, exact resource label in
`error_msg` (memory or tasks). Tasks exhaustion says “进程/线程额度不足”, never “内存不足”. Arbitrary stderr is never forwarded. Unknown stopping
keeps the reservation fenced/pending instead of fabricating a zero-use terminal.

Tests: protocol union signing; two real child transports + real Unix HTTP + actual marker write;
real PG independent five-slot account pools/readiness/publication/four-turn totals/repeated terminals/commit-gap
and spool-gap recovery; real WebSocket signed Codex dispatch excluding local account acquisition;
existing CC Python/TS and root runtime suites. This is not segment-3 real CCB full-tool E2E.
