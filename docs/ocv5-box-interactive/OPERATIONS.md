# Box interactive runner: operations (personal / selfhost)

## What runs

Every Box Claude turn (`box-claude-*`, all four rows `runner: 'interactive'`) runs interactive Claude Code in `tmux -L oc-box` on the Box, driven by the oc-bridge mod. The gateway sees the same stream-json as with `claude -p`.

**There is no `claude -p` for Box logins** (operator rule 2026-10-11 21:35 CST: cc1 and cc2 serve product traffic only in interactive mode). The bridge sends the host nothing until it has seen `BOX_INTERACTIVE_READY`, so a session that cannot come up has run nothing; the turn then fails and the next message tries again. Stderr shows `BOX_INTERACTIVE_NOT_READY <why>` and `BOX_INTERACTIVE_NOT_READY_NO_FALLBACK <why>` when:

- the interactive host ends before it reports ready (a dialog, a 20 s ready timeout, a crash, no tmux or python3, a mod digest mismatch, a login the Box refuses: `profile_unsafe`);
- the mod cannot be loaded or sent (`BOX_INTERACTIVE_NOT_READY BOX_INTERACTIVE_MOD_*`);
- held input before READY exceeded `OC_BOX_INTERACTIVE_HOLD_MAX_BYTES` (default 64 MiB) (`BOX_INTERACTIVE_ABANDON held_overflow`).

Before giving up, the bridge retries once, transparently, when nothing ran: a host that did not come up (`BOX_INTERACTIVE_RETRY not_ready`) is launched again; a login the Box refused (`BOX_INTERACTIVE_RETRY profile_unsafe`) is reported first, so the master benches it and the retry gets another login. A launch that cannot be built (mod too large) or held input over the cap is not retried. When the turn does fail, the user gets one plain failure line (`Claude 暂时繁忙，这条消息没有完成，请稍后再发一次。`, a `result` with `is_error`), never a quota, window or account detail, and the bridge exits 0 (a finished turn, not a crash; the runner's crash backoff is not touched). The same wording replaces any quota or login notice the CLI writes into a chat.

After READY, a failed write or a dead host ends the bridge; the next turn resumes. The former `OC_BOX_INTERACTIVE=0` switch-back and the container cooldown marker are gone (OCV5-378). Rolling back to `-p` would take a code change and the operator's decision.

## Which Box login a session uses

Before each launch the bridge asks the egress (`POST /internal/box/login`) and logs `BOX_INTERACTIVE_LOGIN <profile> <master|fallback>`. The admin selects logins in the account pool dialog; see `docs/ocv5-box-claude-profiles.md` (interactive route). A session stays on its login; a turn whose plan window comes back `rejected`, or a `Not logged in` notice, ends the session after its result (`BOX_LOGIN_ROTATE <profile> quota|login`) and the next message relaunches with `--resume`, possibly on another login.

## Prerequisites on the Box (done 2026-10-07 18:16 by the operator)

- `/workspace` trusted, onboarding and theme set for **every login that is selected**: `/home/box/.claude` (cc1, set by the operator 2026-10-07) and `/home/box/.claude-account2` (cc2, accepted in the CLI's own trust dialog 2026-10-11, OCV5-378). Without trust, interactive stops at the trust dialog, the host reports `NOT_READY … dialog=trust`, and the turn fails.
- A non-default login's dir must be the logged-in box user's own dir whose `projects` is the symlink to `/home/box/.claude/projects` (discovery creates it). Otherwise the host refuses it (`profile_unsafe`).
- Claude Code ≥ 2.1.287 (Mods); the plan-window line needs `$.session.usage()` (present in 2.1.296, the Box's version on 2026-10-11). **No version allowlist**: a CLI without Mods never reports ready and the turn fails.
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
2. Box (cc1, cc2 and cc3 are all on this one Box): while the chat is active, `tmux -L oc-box ls` shows its `oc-<hash>-<nonce>` session; `ps` shows `python3 -c … <run>.d oc-…` with a child `claude … --plugin-dir <run>.d/mod/oc-bridge` (no `-p`); that claude's `/proc/<pid>/environ` has no `CLAUDE_CONFIG_DIR` for cc1 and `CLAUDE_CONFIG_DIR=/home/box/.claude-account2` for cc2. No product `claude -p` process exists at any point. The bridge logs `BOX_INTERACTIVE_LOGIN <profile>`.
3. Stop a running tool turn, then send another message: it continues with history.
4. Wait more than 5 minutes, send again: resume works.
5. AskUserQuestion: ask the model to ask you a multiple-choice question and answer it in the web card.
6. Sonnet and haiku: one turn each, plus one parallel turn on two chats.
7. Billing: three-way check (`usage_records` = `request_finalize_journal` = `credit_ledger`). Report by usage-row count; a tool turn is ≥ 2 rows.
8. Each selected login (cc1, cc2) serves at least one turn, checked as in step 2, and a chat started on one login continues on the other with `--resume` (history intact).

## Known differences from `-p` (see PARITY.md)

- Images and documents are passed as files and read with the Read tool.
- A message starting with `/` reaches the model as text.
- No `api_retry` or `status` lines.
- `updatedInput` on ordinary tool approvals is not applied.

D1 (account terms) remains open with the operator.
