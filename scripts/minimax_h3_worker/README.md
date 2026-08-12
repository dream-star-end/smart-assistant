# OpenClaude H3 worker

The worker exposes a bearer-authenticated execution protocol for
two resource classes:

- `gpu-h3`: MiniMax H3 video generation on the two-rank sequence-parallel worker.
- `cpu-compose`: ordered clip composition through a locally installed FFmpeg.

PostgreSQL in OpenClaude V5 remains the queue authority. The worker only mirrors
the currently fenced attempt, so reconnecting a tunnel never creates a second
GPU process.

## Versioned activation

`install-service.sh` stages the exact Git commit with `git archive`, writes an
external SHA-256 manifest, and makes the candidate read-only. Existing unsigned
or modified release directories are rejected rather than trusted in place.
The worker SQLite database and attempt artifacts stay in the shared
`H3_WORKER_STATE` directory. Activate, inspect, or roll back only through:

```bash
scripts/minimax_h3_worker/activate-release.sh <release>
scripts/minimax_h3_worker/activate-release.sh --status
scripts/minimax_h3_worker/activate-release.sh --rollback
```

The script serializes mutations with `flock`, atomically switches `current` /
`previous`, takes and integrity-checks an online `worker.sqlite` backup, proves
the candidate can open/migrate a copy, restarts the unit, and verifies that
authenticated health reports the exact candidate release. A failed verification
restores the old symlink while retaining the recorded backup path.

The listener defaults to loopback. Public binding is accepted only when
`H3_WORKER_HOST=0.0.0.0` and `H3_WORKER_ALLOW_PUBLIC_BIND=1` are both set; use
that mode only behind the SCNet HTTPS custom-service proxy. Bearer authentication
remains mandatory for every route, including health checks.

## Attempt protocol

For `/v1/attempts/:job_id/:attempt_id`:

1. `PUT /inputs/:ordinal` streams an immutable input with
   `X-Fence-Version`, `X-Content-SHA256`, `X-Content-Size`,
   `X-Input-Kind`, and `X-Input-Filename`.
2. `POST /submit` accepts `fence_version`, `resource_class`, and `request`.
3. `GET /status` returns durable phase and sampling-step progress.
4. `POST /cancel` includes `resource_class`, terminates the active process group, and
   durably tombstones an absent fenced attempt so cancellation remains final when a
   V5 queue reconnects to a replacement worker.
5. `GET /result` streams the verified MP4.
6. `POST /ack` removes opaque attempt staging after V5 has persisted the result.

Every request requires `Authorization: Bearer $H3_WORKER_TOKEN`; mutations and
result reads also require the matching `X-Fence-Version`.

The GPU resource stays occupied through the `releasing_gpus` phase. Completion
is published only after both H3 ranks have stopped and both cards return within
`H3_WORKER_GPU_RELEASE_MAX_PERCENT`. The strict default is `2,2`. On a host with
a proven persistent co-tenant such as the OCR model on card 0, configure the two
per-card ceilings from the measured idle floor plus a small margin (for example,
`18,2` for a measured `16,0` floor). A card above its ceiling keeps the H3 lease
poisoned and retries cleanup instead of admitting the next job.
