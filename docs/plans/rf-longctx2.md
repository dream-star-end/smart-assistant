# Ordinary CCB request bytes and attachment references (W2 slice 2)

Depends on #1201 (`d4138dbe2`); personal branch only. No Box context/journal, billing, or deployment changes.

## Evidence and cause

The ordinary proxy authority in `packages/commercial/src/http/proxy/shared.ts` has an 8 MiB messages field limit, 16 MiB body limit and 2 MiB system/tools limits. These are stricter than the reported upstream “max 20MB”. They are unchanged. `claude-code-best/src/services/tokenEstimation.ts` estimates **2000 tokens per image/document**, deliberately avoiding treating base64 as text tokens. `services/api/claude.ts` previously removed only media items over the **100-item count**. The native transcript is normalized and serialized again on every API request; a small number of large image/PDF blocks, including media nested in tool results, can exceed byte limits while below token/count thresholds. Text and tool results can also exhaust the message/body budget. A larger model token window does not remedy this.

Read-only selfhost evidence, collected 2026-10-28 UTC:

- Retained personal master/egress logs: 11 matching `BODY_FIELD_TOO_LARGE` records, all on 2026-10-23 12:13–12:19Z, all uid765/container1260. The trace SQL maps sampled trace IDs `1da8a2d15ae3270320270a1e4e7bf8ee` and `fb0dc7151a70db229d726c3cf6f59e08` to the Box verification session `g607mvkvggpkfabede`, model `box-claude-haiku-5-5`. They are **not ordinary CCB user incidents**.
- Personal uid3, last 30 days: dispatch failure/conflict keys, usage error messages, and assistant tape payloads yielded no retained literal matches for the reported 20MB/request-too-large family. Queries used the local `openclaude_v5_selfhost` DB, `BEGIN READ ONLY`, read-only PGOPTIONS, 30s statement timeout and rollback. No production data writes or credentials in output.
- Therefore the exact t1031 20MB incident cannot be attributed to an ordinary CCB image/PDF or tool-result payload from retained personal evidence. The code defect and synthetic reproduction are proved separately; no claim about incident prevalence or commercial production is made.
- Local evidence: `$P/rf-longctx2/log-evidence.json`, `readonly.sql`, `readonly-results.log`, and `pr-1201.diff`.

## Implementation boundary

`services/api/client.ts` wraps the SDK fetch after serialization. Enabled for platform sessions (`OPENCLAUDE_SESSION_KEY`) using the first-party Anthropic-shaped transport: ordinary OAuth/static-key routes, including static providers proxied by the platform. It covers streaming, non-stream fallback and compact/auxiliary calls using that client. Direct OpenAI/Gemini/Grok adapters, standalone CCB without a platform session and every exact Box native model retain their existing paths. Box is bypassed before byte events, mutation and IO; its transport/journal owners are untouched.

The fitter evaluates actual UTF-8 JSON body and field bytes, plus message/media counts. Old large image/PDF blocks become complete binary workspace file references, including nested tool-result media. Fresh attachments remain inline when they fit; a current attachment/text/tool result that alone exhausts the envelope can be referenced intact. Tool IDs, error flags, active tool pairs and thinking signatures are preserved. If old conversation text/count alone is too large, the complete old-turn prefix is saved as JSONL and referenced; the current user turn and active tool chain stay together. Native transcript and master history are never overwritten. This is deferred access to exact source data, **not a model-generated semantic summary or a guarantee that the model reads every file**.

The old 100-media filter is bypassed only for ordinary platform first-party requests with Read available, so it cannot silently remove media before the file fitter sees it. The fitter preserves the same 100-item limit by references instead. No server limit is raised.

Budget thresholds/events are extracted from #1201 `engine/boundedPrompt.ts` into `protocol/contextPressure.ts`. Both launch and native request fitting use that implementation. Private reference IO is extracted into `engine/contextReference.ts` and reused by Antigravity and CCB (source import, bundled with CCB). The helper remains in the engine layer instead of creating an unapproved same-layer gateway→storage dependency. No architecture exemption is added.

Content-addressed reference keys include workspace, native session, extension and original bytes. Private directories/files are 0700/0600; a unique temporary directory is written completely then atomically renamed. Existing references are checked for exact content, including concurrent writers. The same input reuses a file across retries, multiple turns and process restarts. Files remain with the workspace because native history may still reference them; lifecycle deletion/GC is a later task.

## Public contract

- `session.context_pressure`: `engine=claude-code`, `scope=native_context`, `dimension=transport_bytes`; warning >=0.8, critical >=1. `usedRatio` is the maximum of actual body/messages/system/tools byte fractions, not cumulative billed tokens and not native token occupancy.
- `sys.context_compacted`: additively permits `scope=native_context`, `strategy=file_reference`, actual before/after body bytes, `droppedEntries=0`. Emitted only after files and final fitting succeed. Existing launch scope/strategies are retained.
- CCB SDK queue emits a `system/context_observation` sideband. The gateway validates/project-whitelists scalar fields and uses #1201's engine→WS/ring route. No paths, contents or billing frames are emitted.
- Impossible fixed system/tool envelopes, oversized active tool-use scaffolding, or oversized tool-less compact/auxiliary calls cannot be made semantically readable with file references. They fail before network dispatch with local 413 and the existing `request_too_large` family. A fetch exception would become “connection error”, so the guard returns a normal 413 response. No model retry or extra paid turn is added.

## Verification and remaining work

Offline regression fixtures include >20MB mixed images/PDFs, four consecutive requests in one native session, exact original bytes and permissions, old/current nested tool media, CJK/escaping, thousands of small messages, current oversized PDF/text, preserved tool pairs, 100+ media, warning/event order, IO failure/abort, immutable Box bypass and protocol/parser routing. Tests run in CI's existing context budget step; local tests obey train priority and the gateway mutex. No real paid model rounds.

Validation results and the exact pushed head are recorded in CONTINUE. This slice does not claim full W2 completion: Codex/Grok native token watermarks/compaction, Box's separately owned transport/native history, tool-less oversized summaries, reference GC, durable observation replay/frontend presentation, and seven production days without oversize failures remain to be verified or implemented by their owners.
