# t1654u — commercial Muse retry policy (DRAFT)

Historical phase-1 design. For commercial conversation VIDEO, the durable queue/callback and
restart semantics in [t1657u-muse-durable-queue.md](t1657u-muse-durable-queue.md) supersede the
in-memory restart and H3 fallback limitations below. Image and Studio behavior remains synchronous.

User request (2026-11-08): 服务端失败自动重试 3 次，每次间隔 40 秒.
This branch targets `feat/v5-aurora-rewrite` only. Release requires user approval.

The hub makes the initial attempt and at most three additional attempts on the same job.
`MUSE_RETRY_MAX = 3` and `MUSE_RETRY_INTERVAL_MS = 40000` are the policy defaults;
`MuseBridgeHubOptions.retryMax/retryIntervalMs` can override them. No environment changes
are needed. A failure starts the delay; reconnecting early does not shorten it. Offline checks
consume this same budget (initial offline, then checks at 40s, 80s, 120s). Busy but online
bridges continue to use the existing queue, concurrency, account, rate and balance limits.

Retryable failures: no bridge at dispatch, replacement hello/session loss, missing ack,
heartbeat loss, upstream error, upload/source-fetch failure and timeout. Explicit invalid
input, bad arguments, content rejection, region restriction, missing CLI, invalid/oversized
output and cancellation are terminal, regardless of a bridge's retryable flag. Unknown
bridge codes retain normalization to MUSE_BAD_OUTPUT. Exhaustion returns the existing
failure status/code; the existing fallback is not changed. The full Chinese H3 fallback
sentence from the task was not found in this checkout; the relevant caller is oc-muse's
preflight offline rejection, followed by the existing prompt-directed fallback.

One admission creates one audit/billing row and one price quote. Retry delays remain queued
and count against the same caps. Queue wait is cumulative time actually queued (including
retry delays), rather than time spent executing earlier attempts. Each dispatch retains its
existing execution deadline. Every retry fences old callbacks with a new nonce and separate
upload directory. Success verification and billing share the existing settlement guard;
only one result can commit, and a stale generation cannot overwrite the winning files.
Billing SQL and H3 code are unchanged.

The status endpoint advertises the retry policy. The CLI submits offline work only when the
server advertises that support, keeps one job ID, and resets its per-attempt timeout when
retry_count advances. Its overall wait and explicit cancellation remain bounded. Old servers
retain the CLI's original offline behavior. Both master code and platform bundle must be
updated together for offline CLI dispatch to benefit from retries.

Pending jobs/retry timers are in memory. A graceful stop cancels timers and records
MUSE_MASTER_RESTARTED; after a crash the existing orphan sweep eventually closes uncharged
rows. Retries are not resumed after a master restart. A/B orphan grace is floored at the
configured maximum retry lifetime plus 60 seconds, so another updated slot cannot close a
live retry. Before a future rollout, ensure any still-running older slot's configured orphan
grace also covers this bound; old slot code does not calculate the new floor.

Release surfaces: master process (`packages/commercial/src/muse`) and platform bundle
(`agent-sandbox/platform-runtime/bin/oc-muse.py`). No runtime image/toolchain rebuild, schema
migration, egress change or frontend change. This task does not deploy or publish either surface.

Tests cover fixed delay boundaries, offline image/video success, reconnect/heartbeat/ack and
bridge failure, initial + three failures, stale/duplicate results, concurrent upload/result
races, one charge/row, queue/account limits, permanent errors, stop/cancel and CLI fallback.
Old five-dispatch/immediate-requeue assertions are updated because t1654u deliberately replaces
that policy. Local validation is targeted tests and typecheck; full suites run on hosted CI.
