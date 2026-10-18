# OCV5-496: personal-edition timing observations

PR only. Do not merge/deploy without the user's next approval. Base: 0b6809f01.
No routing, provider, pricing, default-context, registration, or commercial production changes.

## Relay and correlation

codex_upstream_timing records allowlisted numeric milestones for POST responses
and GET models. POST response inspection no longer depends on a supplier Content-Type.
The bounded passive tap preserves every byte; a JSON/error body never becomes a fabricated delta.
A delta must contain non-whitespace text. The existing 2 MiB request and 256 KiB event
observation limits remain. Oversized events skip observation, never truncate transport.

operation is responses/models. timeOrigin=relay_received applies to request-context and
dispatch; other milestones use fetch_invoked. atEpochMs on dispatch is captured immediately
before fetch, independently of the later logger call. These are overlapping milestones, not
additive stage durations. GET models adds headers, first body and body completion/bytes;
failure/abort stages contain no upstream error text, URLs, queries, credentials or bodies.

The dedicated downstream x-openclaude-relay-request-id is set after copying supplier headers.
It cannot be replaced by a supplier and is never forwarded upstream. Existing x-request-id
behavior is retained. The CLI's HTTP-completed SQLite metadata links this private ID to
processUuid/threadId/turnId; kernel logs link the thread/turn to the user trace. Missing native
session/conversation request headers remain missing: we do not fabricate or send session IDs
to a provider. For a caller-selected test-account database:

~~~
python3 scripts/ocv5-496/export-codex-http-timing.py --db /path/to/logs.sqlite --since 2026-10-18T00:00:00Z
~~~

The exporter opens SQLite mode=ro, emits only validated IDs, timestamps, method/operation/status,
and labels legacy fallback correlation. It never dumps database rows, HTTP headers or content.
If thread/turn is absent on a model-directory request, processUuid gives process attribution;
do not infer a turn solely from close wall-clock timestamps.

## Process log writes

Gateway stdout/stderr and default commercial logger stdout measure the synchronous Node write()
call with numeric counters. Injected/custom log sinks keep their existing semantics.
One process-wide, reference-counted reporter emits a summary every nominal 30 seconds;
its unref timer stops when the final owner shuts down. No per-line diagnostic logs or recursion.
All counters reset before the summary's own write. Resolution is 100 ms for the Node raw
event-loop histogram; its idle baseline is approximately that resolution, not an extra 100 ms
of request blocking. Intervals are nominal, not exact. This does not measure fsync, kernel
flush, durable disk persistence, JSON serialization, or unrelated writers.

## Validation and expected effect

Targeted relay transport/timing, malformed/oversized SSE, observer exceptions, safe exporter,
logger/counter/reporter lifecycle tests; dependent TypeScript and changed-file lint.
tsx scripts/ocv5-496/observation-overhead.ts compares synthetic passive streams and counters
without network or file log writes. It is a local microbenchmark, not production TTFT.
Direct TTFT reduction expected: **0 seconds**. This step closes observation gaps for later
decisions. Risks: bounded parser/counter overhead and slightly more fixed metadata log rows;
no conclusion about the historical 51–151-second upstream waits is implied.

Local measurement (2026-10-18, shared v5-dev): 100 measured streams per mode after20 warmups,
200 frames /113600 bytes per stream, passthrough p50 0.593ms vs
observed 1.791ms (difference 1.198ms).
Maxima 55.176/61.259ms include scheduler noise.
100000 numeric write-counter calls took 156.992ms total; no actual sink IO.
Missing-Content-Type regression was also ablated: restoring the old header condition fails
the integrated delta assertion; restoring the new code passes all63 targeted tests.
Dependent commercial/gateway/protocol TypeScript build passed; changed-file lint adds no errors.
