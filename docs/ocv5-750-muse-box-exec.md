# OCV5-750 Muse video second backend (Box Exec)

Default is **hatch** — the existing `muse_bridge.py` / `/opt/hatch/bin/media-generation` path. When the flag is off, video and image jobs behave as they do today (same offline check, same single hatch slot, same wire format).

## How to turn it on or off

1. **Boot default** (requires a master restart to pick up): `OC_MUSE_VIDEO_BACKEND=hatch` (default) or `OC_MUSE_VIDEO_BACKEND=box-exec`.
2. **Live override** (no restart): write `hatch` or `box-exec` to `$OC_MUSE_STATE_ROOT/video-backend` (default `/var/lib/openclaude-v5-selfhost/muse-media/video-backend`). The hub re-reads this file on every routing decision. The directory is master-owned `0700`; containers cannot flip it.
3. Optional fallback: `OC_MUSE_BOX_EXEC_FALLBACK_HATCH=1` lets a down relay (`MUSE_BRIDGE_OFFLINE`) re-queue the job onto hatch if the hatch bridge is online.
4. `OC_MUSE_BOX_EXEC_UID` must be a decimal uid the Box account resolver can use (`interactiveExecTarget`, no Claude login is scheduled). Unset + `box-exec` fails the job with `MUSE_BRIDGE_OFFLINE`.

GET `/internal/v3/muse-media/status` includes `video_backend` so operators can see the effective value.

Images and `--resume` always stay on hatch, even when the video backend is `box-exec`.

Box-exec concurrency is capped at 5 and does not occupy the hatch `active` slot or Claude-run leases.

Do **not** enable this on production (`kl-mirror`) without a dedicated review: the current Muse web login on the relay box is a public temp-mail session, not a dedicated production account.
