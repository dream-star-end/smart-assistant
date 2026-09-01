# OCV5-61 Cursor Sand InferenceService live-upstream proof

- Date: 2026-09-01
- Environment: V5 selfhost uid3 container, active Cursor account key read through the existing root-only mount.
- Candidate branch: `fix/ocv5-61-sand-inference-v2`.
- Credential values were never printed or persisted in this proof.

## Endpoint and identity

The candidate encoder sent a Connect-protobuf request to:

`POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream`

with `x-cursor-client-type: sand` and pinned Cursor client version. The upstream returned HTTP 200, `application/connect+proto`, decoded Fable text `ok`, exact usage frames, response metadata, and a clean Connect end frame. Observed invocation ids included `68bb84dd-fae8-47b0-aa78-74528db7c79a` and `64e77cb1-69b6-4ed9-822c-5198a912a05e`.

## Adapter loop

The same relay was exercised behind `CursorSandAdapter` with CCB as the local tool loop:

- text turn summary: `assistantText=SAND_ADAPTER_OK`, `isError=false`;
- Bash round trip: the relay recovered an allowlisted/schema-valid Bash control, CCB executed `printf SAND_TOOL_OK`, the second inference request consumed the real tool result, and the terminal summary contained `assistantText=SAND_TOOL_OK` with `tools=[Bash]`.

## Regression anchor

live upstream accepted InferenceService/Stream with x-cursor-client-type sand and returned decoded Fable output
