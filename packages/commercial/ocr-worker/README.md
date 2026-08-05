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

The PP environment needs `pypdfium2`; PP/VL models and both pre-existing
Python environments are supplied by the SCNet host rather than downloaded at
service start.
