#!/usr/bin/env bash
# R1 Generation Drain CLI / Release Hook (`OCV5-749` `AC-5`).
#
# Communicates with the running master's singleton `RemoteReleaseDrainCoordinator`
# over `/run/openclaude-v5-selfhost/remote-v4-drain.sock` (`OC_REMOTE_V4_DRAIN_SOCKET`):
#   --drain   : close new admissions (`REMOTE_POOL_DRAINING_RETRY_LATER`) and wait for
#               all registered relays (`idle === true`) + `request_finalize_journal` rows.
#   --reopen  : reopen admissions if cutover aborted before unit mutation/restart.
#   --status  : inspect current drain status and unsettled journal count.
#
# Exit codes:
#   0  : operation succeeded (`ok: true`)
#   75 : drain socket does not exist (pre-R1 master or remote runtime disabled)
#   1  : drain timed out (`REMOTE_RELEASE_DRAIN_TIMEOUT`) or failed
set -Eeuo pipefail

ACTION="drain"
SOCK="${OC_REMOTE_V4_DRAIN_SOCKET:-/run/openclaude-v5-selfhost/remote-v4-drain.sock}"
TIMEOUT_MS="${OC_REMOTE_V4_DRAIN_TIMEOUT_MS:-600000}"
POLL_MS="${OC_REMOTE_V4_DRAIN_POLL_MS:-100}"
RUN_ID="${LEASE_TRAIN_ID:-cutover-$$}"
KEEP_CLOSED="true"

while (( $# > 0 )); do
  case "$1" in
    --drain) ACTION="drain"; shift ;;
    --reopen) ACTION="reopen"; shift ;;
    --status) ACTION="status"; shift ;;
    --socket) SOCK="${2:?missing --socket value}"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="${2:?missing --timeout-ms value}"; shift 2 ;;
    --poll-ms) POLL_MS="${2:?missing --poll-ms value}"; shift 2 ;;
    --release-run-id) RUN_ID="${2:?missing --release-run-id value}"; shift 2 ;;
    --reopen-after-drain) KEEP_CLOSED="false"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

exec /usr/bin/python3 -I -B - "$ACTION" "$SOCK" "$TIMEOUT_MS" "$POLL_MS" "$RUN_ID" "$KEEP_CLOSED" <<'PY'
import http.client
import json
import os
import pathlib
import socket
import stat
import sys

action, sock_path, timeout_ms_s, poll_ms_s, run_id, keep_closed_s = sys.argv[1:7]
p = pathlib.Path(sock_path)
if not p.exists():
    sys.exit(75)
st = p.lstat()
if not stat.S_ISSOCK(st.st_mode):
    sys.stderr.write(f"Refusing non-socket path: {sock_path}\n")
    sys.exit(1)

timeout_ms = max(50, int(timeout_ms_s))
poll_ms = max(10, int(poll_ms_s))
http_timeout_sec = max(10.0, (timeout_ms / 1000.0) + 15.0)


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(http_timeout_sec)
        s.connect(sock_path)
        self.sock = s


try:
    conn = UnixHTTPConnection("localhost")
    if action == "status":
        conn.request("GET", "/status")
    elif action == "reopen":
        conn.request("POST", "/reopen", body=b"{}", headers={"Content-Type": "application/json", "Content-Length": "2"})
    else:
        payload = json.dumps(
            {
                "timeoutMs": timeout_ms,
                "pollIntervalMs": poll_ms,
                "releaseRunId": run_id,
                "keepClosedForRestart": keep_closed_s == "true",
            },
            separators=(",", ":"),
        ).encode("utf-8")
        conn.request(
            "POST",
            "/drain",
            body=payload,
            headers={"Content-Type": "application/json", "Content-Length": str(len(payload))},
        )
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8", errors="replace")
    conn.close()
except FileNotFoundError:
    sys.exit(75)
except ConnectionRefusedError:
    sys.exit(75)
except Exception as exc:
    sys.stderr.write(json.dumps({"ok": False, "error": str(exc)}) + "\n")
    sys.exit(1)

sys.stdout.write(raw.strip() + "\n")
try:
    parsed = json.loads(raw)
except Exception:
    sys.exit(1)

if resp.status == 200 and parsed.get("ok") is True:
    sys.exit(0)
sys.exit(1)
PY
