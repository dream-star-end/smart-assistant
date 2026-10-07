# Route B parity checklist: interactive runner vs `claude -p`

Branch `feat/box-interactive-runner` (v5-dev worktree `workspace/ocv5-box-interactive`), 2026-10-07.
Scope: personal/selfhost `box-claude-*` (engine `cursor`, `OC_CURSOR_SAND_BOX_CC=1`). Operator ask: same features, **only the data transport changes** (interactive terminal + mod instead of `-p` stream-json).

## How parity is achieved (design in one paragraph)

Route B today: the gateway's `CcbAdapter` (official-cc harness) spawns the local `cursorBoxCcBridge.ts` as if it were `claude`. It speaks stream-json on stdio, and the bridge tunnels to the Box over the Cursor exec API: one long launch exec streams stdout, each stdin line is its own python write exec into `/tmp/oc-box-cc-<h>.<nonce>.fifo`, and a stop exec reaps whatever reads that fifo.
The interactive runner **keeps all of that unchanged**. Only the launch exec differs. Instead of `claude -p … <fifo` it runs a small Box **host** (`box-bridge-mod/host.py`) `<fifo`. The host starts interactive `claude` in `tmux -L oc-box` with the **oc-bridge mod**. The mod turns hooks into the **same stream-json lines** `-p` prints, so `CcbAdapter`, `ccbMessageParser`, billing, abort, permissions and resume run unchanged. Gateway diff: `cursorBoxCcBridge.ts` picks the launch (+18 lines), `cursorBoxCcExec.ts` exports one constant, and the new `cursorBoxCcInteractive.ts`.

Legend: ✅ same, verified · ✅* same by construction (code path untouched) · ⚠ transport-induced difference (documented, minimized) · ⏳ to do in P2/P3.

| # | Route B behaviour (today, from code) | Interactive runner | Status / evidence |
|---|---|---|---|
| 1 | Selection: catalog `box-claude-*` → `CursorBoxCcAdapter` (session-credential Cursor slot with `machineId`) | Unchanged adapter. Runner = catalog row `runner` (`p`/`interactive`, protocol `CURSOR_ENGINE_MODELS`), ops override knob `OC_BOX_INTERACTIVE` (`0` force `-p`, `1` force interactive; master→container passthrough). Resolved in the gateway, handed to the bridge as `OC_BOX_CC_RUNNER` | ✅ test `runner: catalog row decides…` (P2) |
| 2 | Gateway↔Box channel: Cursor exec API, control file 0600, `execUrl/execToken/networkToken` | Same control, same `postExec` | ✅* (D9 resolved: **reuse Route B's channel**, no new transport) |
| 3 | Inbound: per-line write execs, 60 KB×4 base64 parts, seq/lock de-dup, 15 s fifo wait, fail fast | Same execs into the same fifo; host is the reader | ✅ host test delivers a **1.2 MB multi-byte line** via `boxCcWriteExecs` and gets it back byte-equal; real CLI 300 KB byte-equal in transcript (P0) |
| 4 | Stop: stdin EOF → stop exec → TERM/KILL fifo readers, rm fifo | Same stop exec; host is a fifo reader → TERM → kills its tmux session; next launch also reaps an orphaned session by name | ✅ host test: no tmux session, run dir or fifo left |
| 5 | Box argv: `-p --input-format/--output-format=stream-json --include-partial-messages --verbose --permission-prompt-tool stdio` + only `--model/--resume/--permission-mode` (+`--dangerously-skip-permissions`) | Same three adapter-owned flags with identical values; drops `-p`/stream-json; adds `--settings {"skipDangerousModePermissionPrompt":true}` (bypass only) and `--plugin-dir <run>/mod/oc-bridge` | ⚠ R1 (minimal). Test asserts model/resume/permission values equal `remoteClaudeArgs` |
| 6 | cwd `/workspace`, `HOME=/home/box`, product login `/home/box/.claude`, default setting sources, no MCP/system-prompt files | Same cwd/HOME/login/setting sources | ✅* Same project slug → **transcripts interchangeable** between `-p` and interactive (fallback either way keeps history) |
| 7 | Launch env `HOME, PATH, LANG` | claude env via `env -i`: `HOME, PATH, LANG, TERM, DISABLE_AUTOUPDATER=1, OC_BRIDGE_DIR, OC_BRIDGE_PERMISSION_MODE`; no `CLAUDE_CONFIG_DIR`, no exec payload | ✅ host test asserts the exact env key set |
| 8 | Output: stream-json parsed by `CcbMessageParser` | Mod emits `system/init`, `stream_event` (message_start, content_block_start/delta/stop, message_delta, message_stop), `assistant` (per block, from `session.append`), `user` tool_result, `result`, `control_request can_use_tool`, `control_response`, `system/compact_boundary` | ✅ real recordings replayed through the **unchanged parser** (3 tests) |
| 9 | Billing: per-call usage from `message_start/message_delta` → `call_usage`; turn aggregate from `result.usage`; `costMode: external` | Per-step usage on `message_delta` (from `turn.step` result); `result.usage` = `turn.complete.usage`; `total_cost_usd: 0` (ignored under `external`) | ✅ **Σ step usage == turn usage** on real CLI (2/2 turns); parser token fields match. Three-way reconciliation unchanged downstream ✅* (live check is the user's, P2) |
| 10 | Abort: `control_request interrupt` → CLI result with `error_during_execution / aborted_streaming / stop_reason null` → runner retires process, next turn `--resume` | `interrupt` → `$.turn.abort(turnId)` → identical result fingerprint + `control_response success` | ✅ real abort mid-`sleep 30`: `_isOfficialClaudeAbortResult` true, child killed |
| 11 | Permissions: `--permission-prompt-tool stdio` → `can_use_tool` for every `ask` verdict and for AskUserQuestion/ExitPlanMode even under bypass → web card → `control_response` | `tool.check` `ask` → `can_use_tool` (decision via host long-poll); AskUserQuestion/ExitPlanMode answered in `tool.call` from the web decision (tool's own result mapper) | ✅ real AskUserQuestion round-trip ("Blue"). ⚠ `updatedInput` on ordinary tools not applied (tool.check cannot rewrite input); `permission_suggestions` empty; ExitPlanMode result shape ⏳ verify |
| 12 | Resume: native `--resume <session_id>`; gateway resume-map from `session_id` | Same flag; interactive keeps the same session id across resume | ✅ real stop→`--resume`→recall (TANGERINE-17) |
| 13 | Model authority: `--model` fixed per process; model change recycles the process | Same (gateway logic untouched); mod never rewrites `turn.step` model | ✅* No Route B model-mismatch assert exists in the gateway, so none is added (parity). Optional later |
| 14 | Concurrency: gateway per-account cap (personal default 10); no Box-wide cap | Unchanged | ✅* Box-wide cap stays a separate item (SCHEME §6.3) ⏳ |
| 15 | Process lifetime: one Box CLI per gateway runner; idle/model-switch recycles via stdin close | Identical lifetime (no extra parking in v1) → memory profile ≈ `-p` (interactive RSS ≈ 260–380 MB vs ~300 MB) | ✅* D3 park/idle tuning not needed for parity |
| 16 | Images/documents: native base64 blocks in the stream-json user message | Host writes them to `<run>/attachments/<sha>.<ext>`; text gets `[Attached image: <path>]`; model uses Read | ⚠ D8 (accepted v1). One extra tool step per image ⏳ quality check |
| 17 | `/cmd` text: `-p` treats it as a slash command | `$.prompt.submit` refuses a leading `/`; the mod sends ` /cmd` as text to the model | ⚠ (P0 finding). Web sends no slash commands to Route B **[verify in P2]** |
| 18 | `!cmd` text: sent to the model as text | Same | ✅ P0 |
| 19 | Mid-turn user message: queued by the CLI | `$.prompt.submit` queues; starts its own turn when idle, never folded in | ⚠ minor; InlinePush semantics to compare in P2 ⏳ |
| 20 | CLI version gate: none (allowlist removed, `49a1cd7c1`) | **No allowlist.** Mods need ≥ 2.1.287 (Box: 2.1.292); a CLI without Mods never sends `ready` → `BOX_INTERACTIVE_NOT_READY` | ✅ operator rule 「白名单不要恢复」 kept |
| 21 | Plugins: whatever the Box profile enables (none today) | Mod's `plugin.register` admits only `oc-bridge@inline` and `@builtin` | ⚠ tightening only (P0: only `oc-bridge` registered) |
| 22 | Startup dialogs: none under `-p` | Bypass confirmation suppressed by `--settings`; **trust dialog for `/workspace` must be pre-accepted in the product config** (ops step, needs approval); otherwise `BOX_INTERACTIVE_NOT_READY … dialog=trust` | ⏳ ops prerequisite before enabling (P0 finding) |
| 23 | Errors surfaced by `-p` as `system/api_retry`, `system/status`, `task_notification`, `bash_output_tail` | Not emitted (hooks don't expose API retries; background-task deliveries ⏳) | ⚠ status/UX lines only; billing unaffected. P2 ⏳ |
| 24 | `assistant.message.usage` per message | Zeroed (usage is carried on `message_delta`/`result`, which the parser uses) | ✅ parser test |
| 25 | Fallback to `-p` | **Automatic.** The mod posts `ready` before it reads any input, so until the host prints `BOX_INTERACTIVE_READY` no line has reached Claude. The bridge keeps those lines; if the host ends before ready (dialog, timeout, crash, missing mod/tmux, mod digest), it starts `-p` on a fresh fifo, replays them in order, then continues. Launch build failures (mod missing/too large) go straight to `-p`. After a fallback the container skips interactive for `OC_BOX_INTERACTIVE_COOLDOWN_SEC` (default 600). A write that failed before ready is replayed on fallback, or fails the bridge loudly if the host then gets ready (no silent loss) | ✅ end-to-end bridge tests with a local exec emulator: dies-before-ready → `-p` replays 2 turns in order; ready → no fallback; cooldown / bad mod → `-p` (P2) |

## Release packaging (P2)

The user container runs the **precompiled** gateway from the runtime release (`/var/lib/openclaude-v5-selfhost/runtime-releases/rel-*` → `/opt/openclaude`). That release is `git archive` + `rsync --exclude-from=packages/commercial/agent-sandbox/runtime-src-excludes.txt`; nothing there excludes `packages/gateway/box-bridge-mod/`, and `dist/engine/*.js` sits at the same depth as `src/engine`, so `boxBridgeModRoot()` finds the mod in the container. Locked by `scripts/__tests__/v5ReleaseSafety.test.ts` (archive + prune keeps host.py and all four mod files). If the mod were ever missing, the bridge falls back to `-p` (`BOX_INTERACTIVE_FALLBACK BOX_INTERACTIVE_MOD_MISSING`). Existing user containers only get it after a container rebuild (release-verify §3).

## Product rules touched (SCHEME §7.4), as actually needed

- **R1 argv**: yes, minimal (row 5).
- **R2 product-owned plugin**: yes. The mod ships **inside the gateway release** and is passed in the launch exec env, sha256-verified by the host. No Box staging, no Box installer change (R6 ✅).
- **R3 `--safe-mode`**: not applicable (Route B `-p` never had it). D10 stays a separate ticket.
- **R4 persistence**: **no change**. Route B already persists for native `--resume`.
- **R5 model authority**: unchanged.
- **R7 version allow-list**: **not restored** (operator 2026-10-07 16:48). Mods capability is checked functionally (`ready`).

## Open decisions

- **D1 (ToS)**: open, operator-owned. Not blocking engineering.
- D2–D10: defaults per PROMPT. D9 resolved: reuse Route B's exec channel.
