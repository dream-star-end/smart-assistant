# Route B parity checklist: interactive runner vs `claude -p`

Branch `feat/box-interactive-runner` (v5-dev worktree `workspace/ocv5-box-interactive`), 2026-10-07.
Scope: personal/selfhost `box-claude-*` (engine `cursor`, `OC_CURSOR_SAND_BOX_CC=1`). Operator ask: same features, **only the data transport changes** (interactive terminal + mod instead of `-p` stream-json).

## How parity is achieved (design in one paragraph)

Route B today: the gateway's `CcbAdapter` (official-cc harness) spawns the local `cursorBoxCcBridge.ts` as if it were `claude`. It speaks stream-json on stdio, and the bridge tunnels to the Box over the Cursor exec API: one long launch exec streams stdout, each stdin line is its own python write exec into `/tmp/oc-box-cc-<h>.<nonce>.fifo`, and a stop exec reaps whatever reads that fifo.
The interactive runner **keeps all of that unchanged**. Only the launch exec differs. Instead of `claude -p … <fifo` it runs a small Box **host** (`box-bridge-mod/host.py`) `<fifo`. The host starts interactive `claude` in `tmux -L oc-box` with the **oc-bridge mod**. The mod turns hooks into the **same stream-json lines** `-p` prints, so `CcbAdapter`, `ccbMessageParser`, billing, abort, permissions and resume run unchanged. Gateway diff: `cursorBoxCcBridge.ts` picks the launch (+18 lines), `cursorBoxCcExec.ts` exports one constant, and the new `cursorBoxCcInteractive.ts`.

Legend: ✅ same, verified · ✅* same by construction (code path untouched) · ⚠ transport-induced difference (documented, minimized) · ⏳ to do in P2/P3.

| # | Route B behaviour (today, from code) | Interactive runner | Status / evidence |
|---|---|---|---|
| 1 | Selection: catalog `box-claude-*` → `CursorBoxCcAdapter` (session-credential Cursor slot with `machineId`) | Unchanged adapter. Runner = catalog row `runner` (`p`/`interactive`, protocol `CURSOR_ENGINE_MODELS`; **personal default `interactive`** for all three rows), ops override knob `OC_BOX_INTERACTIVE` (`0` force `-p`, `1` force interactive; master→container passthrough). Resolved in the gateway, handed to the bridge as `OC_BOX_CC_RUNNER` | ✅ test `runner: catalog row decides…` (P2) |
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
| 25 | Fallback to `-p` | **Automatic, two phases.** Until the bridge has seen the host print `BOX_INTERACTIVE_READY`, it sends the host nothing and holds every line. If the host ends first (dialog, ready timeout, crash, missing tmux/python, mod digest, held input over `OC_BOX_INTERACTIVE_HOLD_MAX_BYTES`), all held lines go to `-p` on a fresh fifo, in order. Nothing ran interactively, so nothing runs twice and nothing is lost. After READY the bridge behaves exactly like `-p` (a failed write or dead host ends it; the next turn resumes); in interactive mode it also stops the host. Launch-build failures (mod missing/too large) go straight to `-p`. After a fallback, the container skips interactive for `OC_BOX_INTERACTIVE_COOLDOWN_SEC` (600) | ✅ bridge tests through a local exec emulator: dies before ready; READY delayed past host death (red on an earlier design); post-READY write failure; overflow; cooldown/bad mod. 3 consecutive green runs |
| 26 | Who can write the gateway's stream: under `-p` only the CLI's stdout (a same-uid tool could still write `/proc/<claude>/fd/1`) | Bridge socket serves HTTP only to the exact claude pid with a per-session token (read once by the mod, deleted before any tool runs); tap token on stdin, accepted once; tools get 403 | ✅ forge test (no token / stolen token / second tap). Residual same-uid ptrace risk = `-p` status quo (D4) |
| 27 | `result.usage` = CLI's turn aggregate | Engine turn usage when reported, else Σ main-step usage (abort / API error) — never zero for paid steps | ✅ frames test (review round 1) |

## Independent review (codex, read-only), 5 rounds

| Round | Findings | Outcome |
|---|---|---|
| 1 | tools could forge stream-json via the socket; zero usage on turn.complete without usage; unbounded host queues | fixed (exact-pid + token auth; Σ step usage; destructive/bounded queues) |
| 2 | READY-observation race could run a turn twice; tap loss unbounded | fixed (hold until READY; tap loss terminal) |
| 3 | first write after READY could lose a turn; hold buffer unbounded | fixed, then superseded in round 4 |
| 4 | four corner cases in post-READY recovery | **replaced** by the two-phase design (row 25) |
| 5 | **NO BLOCKING ISSUES**; plain `-p` path materially identical to upstream; compatible with the new upstream parser | one medium accepted (below) |

**Accepted limitation (medium):** the pre-READY cap is checked per line after the shared `bufferLines()` has already split a burst, so a single very large burst during startup can exceed it. The same unbounded buffering exists in the `-p` bridge today. The gateway writes about one line per user message, and fixing it means adding backpressure to code shared with `-p`. Separate ticket.

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
