# OpenClaude H3 worker

The worker exposes a bearer-authenticated execution protocol for
two resource classes:

- `gpu-h3`: MiniMax H3 video generation on the two-rank sequence-parallel worker.
- `cpu-compose`: ordered clip composition through a locally installed FFmpeg.

PostgreSQL in OpenClaude V5 remains the queue authority. The worker only mirrors
the currently fenced attempt, so reconnecting a tunnel never creates a second
GPU process.

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
4. `POST /cancel` terminates the active process group.
5. `GET /result` streams the verified MP4.
6. `POST /ack` removes opaque attempt staging after V5 has persisted the result.

Every request requires `Authorization: Bearer $H3_WORKER_TOKEN`; mutations and
result reads also require the matching `X-Fence-Version`.

The GPU resource stays occupied through the `releasing_gpus` phase. Completion
is published only after both H3 ranks have stopped and both cards report at most
2% memory use.
