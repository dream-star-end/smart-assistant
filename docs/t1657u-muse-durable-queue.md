# t1654u / t1657u — Muse retries and durable conversation delivery (DRAFT)

Draft PR #1381. No release, live migration, production action or user notification is authorized
by this development task. Release requires user approval.

## Behavior

The prior a80bef4ec implementation (previously green CI) keeps retry state only in memory.
This revision preserves the initial attempt plus **three additional attempts, 40 seconds apart**.
Image and Studio call contracts remain synchronous. Commercial `oc-muse video` reads the current
webchat session key from its engine environment, and the server validates the originating session
against the authenticated container user. Missing/invalid origins fail explicitly.

Conversation video jobs persist the full validated request and origin before the initial attempt.
After the synchronous retry budget is exhausted, the **same job and price quote** switch to durable
background mode. The CLI returns a successful queue acknowledgment and the conversation turn may
end. The caller must not submit a second Muse/H3 job. There is **no H3 fallback after these retries**.
The existing H3 scheduler has a different worker protocol and only emits job status updates; Muse
reuses its lease/outbox pattern and the existing conversation append/media resolver implementations,
without contacting or investigating H3.

Background jobs wait for an online Muse bridge; offline waiting consumes no execution attempts.
An offline server slot relinquishes queued background work so an online slot can claim it.
Background execution allows an attempt plus three additional retries at the same interval.
Invalid input, rejected content, region restrictions, invalid output and explicit cancellation do
not retry (the existing protocol transient-error allowlist remains authoritative).
Background waiting expires after seven days and produces a failure message without charging.
**Open policy question for the owner:** should expired background jobs ever offer H3? This draft
chooses failure notification only; no automatic H3 invocation, including on expiry.

Both synchronous video completion and background completion use the server's durable callback.
The CLI acknowledges server-owned delivery rather than downloading and asking the assistant to
emit the same result again. After a durable POST acknowledgment, transient polling failures also
return an acceptance acknowledgment so a master restart cannot trigger H3 or resubmission. Images and explicit `oc-muse fetch` keep their download behavior.

## Persistence and fencing

Migration `0336_commercial_muse_durable` adds nullable journal/payload, lease and outbox columns to
`muse_media_jobs`; no second job or billing record. Immutable request/source bytes are in a separate
JSON column so checkpoints do not rewrite large source images. Admission counts released durable
work toward queue/account caps under a transaction lock. Quotes remain included in open credits;
only success is charged, using the existing atomic Muse settlement and two-bucket spending.

Lease owner UUID, current attempt nonce and database lease expiry fence execution updates and
settlement. Checkpoints are serialized per job; bridge dispatch waits for the nonce to persist,
and ACK waits for the running state to persist. A/B recovery uses `FOR UPDATE SKIP LOCKED`.
A restart recovers synchronous backoff even while no worker is online and preserves retry due times; an interrupted in-flight attempt consumes a failure
and gets a new nonce. Losing owners stop serving callbacks. Verified files stay under the winning
attempt's nonce, so stale writers cannot overwrite a newer success. A committed billing outcome
is reconciled before publishing success; an unknown settlement is left for recovery, not fabricated.

Terminal rows are the delivery outbox. Execution is not repeated for callback failures. The
existing `appendServerAuthoredMessage` gives stable-id (`muse-result:<job-id>`) dedupe, including
archived history. User media paths come from the existing tenant-checked resolver; writes use
anchored directory/file descriptors and atomic rename, with content hash verification. A deleted
origin is never redirected. Remote-host containers use the existing authenticated node-agent upload
closure, with verified content and retryable publication before the conversation append. A browser hint reloads authoritative conversation history without
ending the current turn. Leaving/reconnecting, or losing the append ACK, creates no second message.
File copying runs independently of execution lease renewal. Pending delivery retries every 40s;
the existing Muse audit retention is 180 days, and durable result files remain protected while
their audit row exists (startup cleanup reclaims them after row retention).

## Rollout boundaries (not executed)

- Master code + platform bundle CLI/prompts + gateway/protocol runtime source + frontend dist.
  No Dockerfile/toolchain changes; **no runtime image rebuild** is required.
- CCB baseline prompt changes require the normal controlled baseline remount workflow.
- Apply migration manually before activating code; update required migration metadata is included.
  The claimed intervening `0335_codex_remote_native` belongs to the personal selfhost branch, not
  this commercial chain. Re-run the migration claim check before any future release; do not assume
  a later cross-edition sync can apply a lower migration out of order.
- Additive columns are ignored by old binaries; the migration protects durable rows from old A/B
  orphan sweeps. Old binaries do not execute/deliver durable jobs. Keep the shared Muse state root
  and retain the durable-capable release while jobs/outbox entries are outstanding.
- No environment override, release queue, deployment, restart, actual billing, or production
  callback is performed by this PR-only task.

## Addendum 3 — multiple Muse accounts (t1658u)

The credential table and `scripts/muse-bridge-token.sh` already support separate tokens. The old
hub had one session: every hello displaced every other bridge. Commercial assembly now enables
one current session **per credential**, using the same verified commercial-flavor gate as durable
delivery. A replacement using the same token fences only that credential's attempts and polls.
Different accounts must use different tokens; sharing one token intentionally retains replacement
semantics. The personal/default hub contract remains single-session.

For a future approved setup, issue one token per worker/account using `muse-bridge-token.sh issue
--label <unique-name>`, explicitly setting `MUSE_ENV_FILE` to the commercial environment file
(the script's default is selfhost). It writes a root-only token file; do not put token contents in
logs or commands. No tokens were issued or revoked during this task.

`OC_MUSE_CONCURRENCY` remains the existing total cap per master hub (default 1; hard maximum 32).
`OC_MUSE_BRIDGE_CONCURRENCY` optionally caps each bridge, defaults to that site cap, and cannot
raise it. `/hello.max_concurrency` advertises the per-bridge cap; each bridge's existing
`--max-concurrency` can lower its own worker count. For example, site cap 4 and bridge cap 2 allow
two accounts to execute two jobs each. User running/inflight, queue, daily and credit limits are
unchanged. These are the existing per-process execution limits, not a new cluster-wide capacity
reservation system. No environment files were changed.

A polling bridge takes compatible work only while it and the site have spare capacity. Full or
legacy bridge polls do not block a peer's free slot; source transport uses the assigned bridge's
version. Any live session means online. Silent job heartbeat loss uses the existing detection
window (120s), then the fixed 40s retry delay; explicit worker-loss reports and same-token hello
start that delay immediately. The other bridge can take the next attempt. Addendum 2's initial
attempt + three retries and durable background phase remain unchanged; no H3 request is added.

Each dispatch pins bridge session, credential and protocol version to its attempt nonce. HTTP
checks token→session and session→attempt for heartbeat, sources, chunks and results. A stale poll
response cannot requeue a newer attempt. Durable lease/nonce fencing and immutable result paths
remain authoritative across server restarts; bridge bindings are local dispatch metadata and are
recreated on recovery, so no additional migration is needed. Existing atomic settlement and
conversation outbox dedupe provide one charge and one origin message across reassignment.

R3 deployment surface is master commercial source/config only, plus tests/documentation. No
runtime image rebuild, new schema migration, egress change or frontend rebuild is introduced by
R3; the broader R2 rollout requirements above still apply to the combined draft PR.
