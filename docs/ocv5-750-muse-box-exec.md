# OCV5-750 Muse video second backend (Box Exec relay)

Default is **hatch** — the existing `muse_bridge.py` / `/opt/hatch/bin/media-generation` path. When the mode is `hatch`, video and image jobs behave exactly as before (same offline check, same hatch slot, same wire format).

## Modes

| Value | Behaviour |
|---|---|
| `hatch` (default; empty = hatch) | Today's path only. |
| `hatch-with-box-fallback` | **Backup mode.** Hatch stays primary. A fresh video (`kind=video`, no `--resume`) moves to the Box relay only while hatch has provably not started it: hatch offline at submit, the bridge went offline while the job was still queued, the job waited past the queue window, or it was dispatched `MAX_DISPATCH_ATTEMPTS` times with no ack. The ack is hatch's execution barrier, and moving rotates the nonce so a late hatch ack/claim gets 410. A job that hatch acked is never moved (no double generation). A job that moved never moves back. |
| `box-exec` | Relay primary for fresh videos (images / `--resume` stay on hatch). |

Images and `--resume` always stay on hatch.

## How to switch

1. **Boot default** (master restart): `OC_MUSE_VIDEO_BACKEND=hatch|hatch-with-box-fallback|box-exec` plus `OC_MUSE_BOX_EXEC_UID=<uid whose Box account hosts the relay>`.
2. **Live override** (no restart): write one of the three values to `$OC_MUSE_STATE_ROOT/video-backend`. The hub re-reads it on every routing decision. Delete the file (or write `hatch`) to switch back. The directory is master-owned `0700`; containers cannot flip it.
3. Commercial (Aurora): box→hatch fallback is not implemented; a box-exec failure fails the job with no charge.

GET `/internal/v3/muse-media/status` reports `video_backend`.

## Rollback

- Fastest: `echo hatch > $OC_MUSE_STATE_ROOT/video-backend` (no restart; new jobs stop using the relay; in-flight relay jobs finish or time out).
- Permanent: unset `OC_MUSE_VIDEO_BACKEND` (or set `hatch`) and restart the master.

## Safety rules

- Relay jobs are pinned to the Box transport they resolved (no retargeting mid-job).
- After a relay `submit` may have been accepted (`BOX_EXEC_INCOMPLETE` / `TIMEOUT` / `AFTER_EXIT`), the job is not re-run anywhere.
- Billing is the existing success-only path: one finish per job, whichever backend produced it.
- Box-exec concurrency is capped at 5 and does not use the hatch slot or Claude-run leases.

## Relay side (on the Box)

`/workspace/muse-relay` serves several Muse accounts (`accounts.json`, `bin/muse-account list|add|login|code|enable|disable`). Each account has its own browser profile and side-chat pool; the scheduler spreads jobs over healthy accounts and skips accounts with a usage cap / lost login. `bin/muse-exec-cli health` shows per-account state with masked emails.
