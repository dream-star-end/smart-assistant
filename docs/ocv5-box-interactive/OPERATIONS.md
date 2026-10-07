# Box interactive runner: operations (personal / selfhost)

## What runs by default

Personal `box-claude-opus-5-5`, `box-claude-sonnet-5` and `box-claude-haiku-4-5` have `runner: 'interactive'` in the protocol catalog (`packages/protocol/src/engineModels.ts`).
A turn on these models runs interactive Claude Code in `tmux -L oc-box` on the Box, driven by the oc-bridge mod. The gateway sees the same stream-json as with `claude -p`.

**`-p` stays the safety net, automatically, but only before the interactive session is up.** The bridge sends the interactive host nothing until it has seen `BOX_INTERACTIVE_READY`, so a fallback never runs a turn twice. After READY, failures behave as they do on `-p` (the turn errors; the next message resumes). The bridge runs a turn on `claude -p` when:

- the interactive host ends before it reports ready (a dialog, a 20 s ready timeout, a crash, no tmux or python3, a mod digest mismatch). The lines held so far are replayed to `-p` in order. Stderr shows `BOX_INTERACTIVE_NOT_READY <why>` and then `BOX_INTERACTIVE_FALLBACK not_ready`;
- the mod cannot be loaded or sent (`BOX_INTERACTIVE_FALLBACK BOX_INTERACTIVE_MOD_*`);
- held input before READY exceeded `OC_BOX_INTERACTIVE_HOLD_MAX_BYTES` (default 64 MiB) (`BOX_INTERACTIVE_ABANDON held_overflow`);
- a fallback happened in that container in the last `OC_BOX_INTERACTIVE_COOLDOWN_SEC` seconds (default 600; marker `/tmp/oc-box-cc/interactive-down` inside the user container) (`BOX_INTERACTIVE_FALLBACK cooldown`).

Both runners use the same cwd (`/workspace`) and the same Box login, so a chat moves between them with its history intact (`--resume` works either way).

## Overrides (master env, passed to user containers)

| `OC_BOX_INTERACTIVE` | Effect |
|---|---|
| unset | each catalog row decides (personal default: interactive) |
| `0` | **every** box-claude turn on `-p` (emergency switch-back) |
| `1` | every box-claude row interactive, whatever the catalog says |

The value reaches a user container when the container is (re)created. A running container keeps the value it was created with.

Code-level switch-back: set the three rows back to `runner: 'p'` and release.

## Prerequisites on the Box (done 2026-10-07 18:16 by the operator)

- `/workspace` trusted, onboarding and theme set for the product login `/home/box/.claude`. Without trust, interactive stops at the trust dialog, the host reports `NOT_READY … dialog=trust`, and the turn falls back to `-p`.
- Claude Code ≥ 2.1.287 (Mods). The Box has 2.1.292. **No version allowlist**: a CLI without Mods never reports ready and falls back.
- `tmux` and `python3` on the Box (both present).

## Leftover check (Box)

```bash
tmux -L oc-box ls                         # one oc-<hash>-<nonce> per live interactive chat process
ls -d /tmp/oc-box-cc-*.d 2>/dev/null      # run dirs of live sessions only
```

A session or run dir with no matching `/tmp/oc-box-cc-*.fifo` is an orphan. The next launch for that chat removes it, or kill it by its exact name: `tmux -L oc-box kill-session -t =oc-<hash>-<nonce>`.

## User live verification (canary cannot use `box-claude-*`)

Run this after the release **and** after the user container `oc-v5-u3` is rebuilt (an existing container keeps the old runtime):

1. Opus: new chat, 5 turns, one with a real tool (Bash), one with an image upload.
2. Box: `tmux -L oc-box ls` shows the session while the chat is active. The gateway log shows no `BOX_INTERACTIVE_FALLBACK`.
3. Stop a running tool turn, then send another message: it continues with history.
4. Wait more than 5 minutes, send again: resume works.
5. AskUserQuestion: ask the model to ask you a multiple-choice question and answer it in the web card.
6. Sonnet and haiku: one turn each, plus one parallel turn on two chats.
7. Billing: three-way check (`usage_records` = `request_finalize_journal` = `credit_ledger`). Report by usage-row count; a tool turn is ≥ 2 rows.
8. Switch-back drill (optional): set `OC_BOX_INTERACTIVE=0` on master, recreate the container, and confirm `-p` turns work. Then unset it. (The automatic fallback itself is covered by tests; do not break tmux or the CLI on the shared Box to provoke it.)

## Known differences from `-p` (see PARITY.md)

- Images and documents are passed as files and read with the Read tool.
- A message starting with `/` reaches the model as text.
- No `api_retry` or `status` lines.
- `updatedInput` on ordinary tool approvals is not applied.

D1 (account terms) remains open with the operator.
