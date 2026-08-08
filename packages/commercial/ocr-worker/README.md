# OpenClaude V5 private OCR worker

Private, durable OCR queue for SCNet Hygon BW accelerators. It is not exposed
to the public network: `run-supervisor.sh` is started as the remote command of
the V5 host's loopback-only SSH tunnel.

## Runtime contract

- one persistent PP-OCRv6 process and one persistent PaddleOCR-VL-1.6 process
  per configured card;
- global cancellable FIFO across cards, SQLite WAL recovery after disconnect;
- `hybrid`: PP det=24/rec=64, then the lowest-confidence fraction on **each
  page** goes through VL batch=4 (empty PP pages go through whole-page VL);
- `pp`: PP only; `vl`: quality-safe whole-page VL batch=1;
- complete JSONL and Markdown results; token-boundary or unsafe-page failures
  fail the whole job instead of returning partial content.

The installer must set the environment consumed by `run-supervisor.sh` and
pin `OC_OCR_WORKER_RELEASE` to the exact source commit. `GET /ready` reports
that release and protocol major 1. Releases are installed into versioned
directories; switching `current` and restarting the SSH tunnel is atomic.

Stage candidates first with
`stage-release.sh <source-directory> <40-character-source-commit>`. It copies
the candidate into a versioned directory, writes an external SHA-256 manifest,
and makes the directory read-only. `activate-release.sh <release>` refuses an
unstaged or modified candidate, serializes the symlink switch, takes and checks
an online SQLite backup, restarts the tunnel-owned supervisor, then requires an
authenticated `/ready` response for that exact release. A failed activation
restores and verifies the previous release. Use `--status` to inspect state and
`--rollback` to atomically swap back without discarding the shared queue.

The PP environment needs `pypdfium2`; PP/VL models and both pre-existing
Python environments are supplied by the SCNet host rather than downloaded at
service start.

`run-supervisor.sh` writes a fixed heartbeat over the SSH stdout channel. The
V5 host discards only that stdout while keeping SSH stderr in journald. This
prevents SCNet's application-idle disconnect; a real disconnect breaks the
heartbeat pipe and drives the supervisor's existing child cleanup before the
host tunnel reconnects.
