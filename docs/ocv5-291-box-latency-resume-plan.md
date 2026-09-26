# OCV5-291 · Box latency and native resume (selfhost only)

Base: `ff66d04bcc3ba9f0af84f806208e85387f6b34e1`. Task: OCV5-291. This is a plan, not an enablement claim. Do not change commercial production.

## User outcome

- Completed-turn continuation should prefer the same Box account's **native Claude session** when the authenticated OpenClaude transcript exactly matches, rather than reconstructing and uploading all history.
- Cold, warm and long conversations should stream reliably. Measure first visible delta and cache-read/write tokens, not just upstream first byte.
- OpenClaude remains agent, memory, Skill, tool, billing and session authority. A Box native session is a disposable acceleration cache, not a second authority.

## Phase 0: evidence and timings, no behavior change

Add privacy-safe per-phase durations/counts: account resolve, journal admission, asset stage, prelaunch bootstrap, private stage bytes/Exec count, launch, first remote model delta, first client-visible delta, final proof/cleanup. Do not log prompts, tool args/results or credentials. Establish paired cold and warm same-fixture baselines and compare actual CLI cache-read/write tokens.

## Phase 1: collapse network round trips, not safety checks

1. Replace four sequential static helper stage Exec calls (two on text path) with one bounded remote batch. Keep content-addressed paths, per-file SHA-256, owner/mode/type checks, `O_NOFOLLOW`, no-clobber publication and an exact final manifest reply. A partial/unknown batch never grants launch permission.
2. Batch private `INIT`, small `WRITE`s and `FINISH`es inside one guarded Exec where request/output bounds permit; split only by measured payload limit. Preserve prelaunch control identity, pinned directory fds, individual hashes, atomic publication and remote cleanup semantics. Do not use a shell command string or arbitrarily writable paths.
3. Keep journal admission/launch-arm and terminal proof separate. No ambiguous paid-call replay. Retain old path under a scoped switch until negative tests and real Box acceptance pass.

## Phase 2: native resume at completed-turn boundary only

1. Verify on pinned Claude CLI 2.1.280 that `--session-id` then `--resume` preserves completed text and completed tool history in the **same real Box**, with the same CLI project cwd; validate actual request roles, system prompt, tool schema, usage/cache fields and no duplicate tool execution.
2. Only the native lane removes `--no-session-persistence`; the synthetic-snapshot lane retains it and its disposable project directory. Do not set `CLAUDE_CODE_SKIP_PROMPT_HISTORY`. Native calls set `CLAUDE_CONFIG_DIR` to a 0700 opaque directory bound to uid, OpenClaude session and exact Box account. Use a separate short stable CLI cwd whose Claude project key is unambiguous and within the CLI's path limit; keep per-invocation input/proof in unique run directories. The native config/project directory is **not** passed to existing CLEANUP. Same Box UID is not an OS-level tenant boundary, so the only permitted file access is through the authenticated, pinned-account coordinator. Use one native UUID (`--session-id` first, then `--resume`), not the mapper's new UUID each call. Disable CLI auto-compaction (`DISABLE_AUTO_COMPACT=1`) to prevent a hidden second paid request; OpenClaude remains responsible for explicit context management. Remote native files have bounded size/retention and are deleted only after no live owner.
3. On terminal proof, store only a small cache pointer in existing selfhost journal JSONB (no migration): uid, OpenClaude session ID, canonical/upstream model, account ID, CLI version, native UUID/project path, **native JSONL SHA-256**, exact completed-history digest, system/tool-catalog hashes, terminal revision and expiry. No prompt/history/tool plaintext in PG. Derive the completed-prefix digest with existing semantic normalization/context hashing and the tool hash with the existing catalog compiler; do not add a second parser for a matching native JSONL.
4. **Before any CAS or paid launch**, resolve the pinned account and read/check the native file's presence, size and SHA-256. An absent/corrupt file, account mismatch, expired pointer, or any transcript/system/tool mismatch is a cache miss and takes the existing synthetic path **once**. If the pinned account is unavailable before launch, treat it as a cache miss and use the ordinary account resolver for the synthetic path; do not copy the native directory or mark an invocation unknown. A cache hit atomically claims the predecessor, admits the new request and binds its replay fingerprint in one transaction under the existing `(uid,session)` advisory lock; the CAS records the new request ID and commits before any Box Exec. Do not use the per-run random lease epoch as a cross-turn cache key. After the first launch attempt, ambiguous transport is `unknown`: retain the claim and never fall back or retry. No mid-tool Bot switch or native resume after unknown termination; do not copy native config to another account.
5. Keep the in-flight cross-HTTP tool_result coordinator unchanged: it already resumes the same live CLI.

## Acceptance and release

- Offline negatives: wrong user/account/session/terminal revision/prefix/system/tool, duplicate claim, crash between claim/launch, missing/corrupt native file, path swaps, long history, large output and cleanup.
- Real Box: cold/warm paired requests on account 20; text and completed-tool continuation; >20-message conversation; cancellation, disconnect, Box restart/hibernation, unknown outcome. Assert native UUID reuse and actual cache-read growth, not only green response. Measure p50/p95 first visible delta and phase budgets. If direct Box comparison is unavailable, report that gap rather than claim parity.
- T2 auditor PASS, full relevant tests, fast-forward push to selfhost shared branch, official one-line deploy/ride and read-only post-deploy verification. Keep new native lane disabled until acceptance; no production debugging.

If pinned CLI cannot safely persist/resume exact completed history, do not fake it with a new synthetic `--resume` label. Ship only the batched-staging win and report the native-resume incompatibility.
