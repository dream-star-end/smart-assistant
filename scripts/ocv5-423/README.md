# OCV5-423 · Gemini 4 Argon Contributor via OpenCode Go

Scope: uid3 selfhost, manually selectable/admin-only; no default change.
Contributor sends prompts/completions for potential Google training (not ZDR).
The Go workspace must explicitly allow paid endpoints that train on request data.

The model supports only Google generateContent. Existing opencodego Anthropic
routes are untouched. The billed proxy selects the Google bridge only from the
trusted static-provider session and exact upstream model. Fixed LOW thinking,
text input, no exposed effort/vision capability; conservative 1M context.
Google tools preserve their native IDs/signatures in opaque replay IDs. CCB
hashes only these IDs when naming persisted tool-result files. Foreign model
signed tool history is rejected clearly: start a new conversation for Gemini.

Google cache counts are a subset of prompt tokens, and thought tokens are
additional output. Successful streams emit only ONE message_delta (CCB records
cost per delta); unfinished/blocked/malformed streams are errors with the last
observed partial usage, never success. Contiguous text chunks share a block.

## Release order

1. Review, targeted tests, real SDK loop and real CCB Write→Read artifact.
2. Commit+push; serial integration and official selfhost lease-train registration.
3. On callback, verify reviewed SHA in live master+egress and runtime-source/CCB
   surfaces. No model row is automatically activated by this code release.
4. From selfhost host with its existing env loaded (never print credentials):
   `node --import tsx scripts/ocv5-423/catalog.ts --on --sha <reviewed-40hex>`.
   The op checks current DB and running master/egress release ancestry before
   its transaction. CAS authority functions and triggers govern state changes.
5. Check admin model selector, a real canonical-model turn and authoritative
   usage_records/price_snapshot. The default and other model rows stay unchanged.

`--check` is read-only. `--off` hides/disables only this model (before reverting
runtime to a release without the bridge); never delete its billing history.
Price follows the existing selfhost 0288 convention, not an FX conversion:
input200/output1000/cache-read10/cache-write0 fen per million tokens, multiplier1.

## Evidence

`geminiGoBridge.test.ts` covers actual UsageObserver through the byte pipe,
fragmented native SSE, cache+thought counts, signed replay, errors and cancel.
`proxyCore.unit.test.ts` tests the real core transport and finalizer selection;
`proxyUpstream.unit.test.ts` tests trusted selection and existing Go routes.
`geminiGoCatalog.integ.test.ts` runs an isolated dedicated DB, proves the
unmodified DB guard rejects it, then a test-only name substitution verifies
on/on/off/on and unchanged other pricing. It is registered in nightly-2.
`geminiToolResultStorage.test.ts` isolates mocks in a child and actually writes
and re-reads long-ID text/JSON results. No mock state leaks to the Bun suite.
