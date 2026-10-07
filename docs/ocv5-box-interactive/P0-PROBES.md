# P0 probe report: interactive Claude Code + oc-bridge mod (2026-10-07, Asia/Taipei)

Where: this Box, `/home/box/.local/bin/claude` **2.1.292**, tmux 3.5a, python 3.13.
Login: **cc3's own** `CLAUDE_CONFIG_DIR=/home/box/.claude-account3`, **not** the product login `/home/box/.claude`. Model `claude-haiku-4-5`, about 10 small turns.
cwd: `/home/box/cc3-work/ocv5-interactive-impl/probe-cwd`. Interactive only, never `claude -p`.
Harness: `scratchpad/proto/drive.py` plays the gateway and Route B bridge: it writes stream-json into the fifo, reads stdout, and stops by TERMing the fifo readers, as the stop exec does.
Mod/host under test: the same files committed to `packages/gateway/box-bridge-mod/`.
Recordings: committed as `packages/gateway/src/__tests__/fixtures/boxInteractive-{turns,abort,ask}.ndjson` (cwd normalised to `/workspace`).

| SCHEME [verify] item | Result |
|---|---|
| Startup dialogs under tmux with bypass argv | **Trust dialog** ("Quick safety check… trust this folder") appears for an untrusted cwd. Trust **is inherited** from a trusted parent dir. **Bypass confirmation** ("WARNING: … Bypass Permissions mode") appears and is **suppressed by `--settings '{"skipDangerousModePermissionPrompt":true}'`** (no keystrokes). `session.start` does not fire until dialogs clear, so the host reports `BOX_INTERACTIVE_NOT_READY … dialog=trust\|bypass`. **Prerequisite:** `/workspace` trusted in the product `~/.claude.json` (ops step; product `projects["/workspace"]` currently has no entry). |
| Mod loads under `--plugin-dir` in interactive | Yes; `ready` in about 2–3 s from launch. `plugin.register` saw no other plugin, so the admitted list is `[oc-bridge]`. |
| `$.prompt.submit({asUser:true})` from a tap-fed loop | Works. A text starting with `/` is **refused** by the engine ("would run a command as the user"), so the mod prefixes a space. `!echo …` goes to the model as text (no shell mode), same as `-p`. |
| ~1 MB prompt byte-equality | Real CLI: **300 KB** mixed ASCII/CJK/Latin-1 prompt **byte-equal** in the CLI transcript. 1 MB would exceed haiku's context, so the 1.2 MB case is covered by the host test (Route B write execs → host → tap → back, byte-equal). |
| `turn.step` usage vs `turn.complete` usage | **Σ step usage == turn usage, field by field**, on both multi-step turns (incl. a Bash tool turn). |
| Abort | `$.turn.abort` mid-tool (`sleep 30`): `turn.complete reason=aborted`, child killed; the emitted result matches the gateway's `_isOfficialClaudeAbortResult`. |
| AskUserQuestion without a person at the TTY | `tool.call` answered by the mod from the web decision; the model read the tool's own mapped result ("…=\"Blue\"") and replied "Blue." No dialog drawn. |
| Resume after stop | Stop (TERM) → relaunch `--resume <id>` → model recalled the codeword; **session id unchanged** across resume. |
| `$.process.spawn` child (tap) over the session | Stable across all scenarios; ends with the host. |
| `$` usage | `claude plugin validate`: calls only `$.clock.sleep, $.env.get, $.http.fetch, $.process.spawn, $.prompt.submit, $.session.id, $.session.model, $.turn.abort`; no `$.model.*`, no `$.session.authorize`, no `$.env.set`, no telemetry hooks. The validator forbids keeping `$` in a variable, so detached loops live inside `session.start`. |
| `tool.call` input shape | Tool arguments sit **beside** `tool/tool_use_id/consent/agentId` on `e` (no `e.input`); `tool.check` has `e.input`. |
| Unix socket path | AF_UNIX limit is 108 bytes. Product paths (`/tmp/oc-box-cc-<16>.<8>.d/bridge.sock`, about 55 bytes) fit; the host refuses longer paths explicitly. |
| RSS | Interactive CLI about **257 MB** at startup; long-lived operator interactive sessions on this Box are 320–380 MB (vs about 300 MB measured for `-p`). |
| Leftovers | After every scenario: no tmux server, no host or tap process, and the run dir removed. |

Not yet probed: real images through the attachments path (quality), parallel subagents' parent mapping, compaction mapping, and behaviour on the product login with `/workspace` trusted (that needs the ops step and the user's live E2E).
