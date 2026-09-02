# OCV5-61 Cursor Sand InferenceService live-upstream proof

- Date: 2026-09-01
- Environment: V5 selfhost uid3 container, active Cursor account key read through the existing root-only mount.
- Phase-1 live release: `rel-faf8b33b2-20260901-072739`.
- Account-pool/all-model candidate branch: `fix/ocv5-61-sand-pool-v3`.
- Credential values were never printed or persisted in this proof.

## Endpoint and identity

The candidate encoder sent a Connect-protobuf request to:

`POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream`

with `x-cursor-client-type: sand` and pinned Cursor client version. The upstream returned HTTP 200, `application/connect+proto`, decoded Fable text `ok`, exact usage frames, response metadata, and a clean Connect end frame. Observed invocation ids included `68bb84dd-fae8-47b0-aa78-74528db7c79a` and `64e77cb1-69b6-4ed9-822c-5198a912a05e`.

## Adapter loop

The same relay was exercised behind `CursorSandAdapter` with CCB as the local tool loop:

- text turn summary: `assistantText=SAND_ADAPTER_OK`, `isError=false`;
- Bash round trip: the relay recovered an allowlisted/schema-valid Bash control, CCB executed `printf SAND_TOOL_OK`, the second inference request consumed the real tool result, and the terminal summary contained `assistantText=SAND_TOOL_OK` with `tools=[Bash]`.

## Account-pool and complete model matrix

The admin-authored `.sand-mode` sidecar is now consumed for the exact slot selected by the existing `oc-cursor` pool authority. Users still select only the canonical Cursor model; the selected key's Sand flag chooses transport. Native execution and Sand settlement both report the same 1-based slot for account attribution and failover.

The current catalog contains 47 rows / 37 unique canonical choices. Direct low-output probes against the real Sand endpoint covered every unique choice:

- all 36 concrete model ids were accepted by `InferenceService/Stream` with HTTP 200 (Grok 4.5/4.6, Composer 2.5, Opus 4.8/5 and Fable 5, including effort/Fast variants);
- `composer-2.5-fast` required a larger output budget on retry, then returned a valid response;
- `cursor-auto` is not a concrete InferenceService model (`requested_model is required` / `auto` rejected), so Auto remains on the native CLI router even when its key is Sand-enabled;
- Grok 4.6 was additionally exercised through the full CCB adapter: text returned `SAND_GROK_OK`; a Bash round trip ended with `tools=[Bash]` and `SAND_GROK_TOOL_OK`.

Credential values were never logged. Raw matrix evidence is stored outside the release tree at `/home/agent/.openclaude/generated/cursor-sand-model-matrix-20260901.json`; the bounded Composer retry is `/home/agent/.openclaude/generated/cursor-sand-composer-fast-retry-20260901.json`.

## Regression anchor

live upstream accepted InferenceService/Stream with x-cursor-client-type sand and returned decoded Fable output
