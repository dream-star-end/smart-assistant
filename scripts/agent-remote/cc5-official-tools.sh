#!/usr/bin/env bash
# OCV5-746: extract the builtin tool definitions the official Claude Code CLI would send to the API.
#
# Cost: zero model calls. The pinned CLI is started once (`-p hi --max-turns 1`) against a local
# endpoint that answers every request with HTTP 400. The CLI assembles the full tool list before the
# first byte leaves the process, so the body we capture is exactly what the remote model would be
# offered. Account credentials are never read: HOME and CLAUDE_CONFIG_DIR point at a throwaway
# directory, the auth token variables are dropped, and the API key is a dummy that never leaves
# 127.0.0.1. The throwaway directory (and its transcript) is removed before the script returns.
#
# Usage:
#   scripts/agent-remote/cc5-official-tools.sh --out /tmp/official-2.1.316.json
#   scripts/agent-remote/cc5-official-tools.sh --cli /home/box/.oc-remote-cc/claude-2.1.316
#
# Then: npx tsx scripts/agent-remote/cc5-tool-drift.mts --official <out> --ccb-live
#
# Requires: gcloud authenticated for the target project, and the node's ssh key below.
set -uo pipefail

NODE=ocdeploy@cc5-us
ZONE=us-west1-b
PROJECT=project-f0459640-9892-4f50-922
KEY=/home/agent/.openclaude/.ssh/gcp_cc5us_ocdeploy
CLI=/home/box/.oc-remote-cc/claude-2.1.316
OUT=
TIMEOUT_SECONDS=120

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE=$2; shift 2 ;;
    --zone) ZONE=$2; shift 2 ;;
    --project) PROJECT=$2; shift 2 ;;
    --key) KEY=$2; shift 2 ;;
    --cli) CLI=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --timeout) TIMEOUT_SECONDS=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f "$KEY" ] || { echo "ssh key not found: $KEY" >&2; exit 2; }

REMOTE_PY=$(cat <<'PY'
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

CLI = os.environ["CC5_CLI"]
ROOT = tempfile.mkdtemp(prefix="ocv5-746-drift-")
BODIES = []


class Capture(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        BODIES.append(self.rfile.read(length))
        payload = json.dumps({
            "type": "error",
            "error": {"type": "invalid_request_error", "message": "OCV5-746 drift probe: not a real request"},
        }).encode()
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


def main():
    server = http.server.HTTPServer(("127.0.0.1", 0), Capture)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        work = os.path.join(ROOT, "work")
        home = os.path.join(ROOT, "home")
        cfg = os.path.join(ROOT, "cfg")
        for path in (work, home, cfg):
            os.makedirs(path, mode=0o700)
        mcp = os.path.join(ROOT, "mcp.json")
        with open(mcp, "w") as handle:
            handle.write('{"mcpServers":{}}')

        env = {key: value for key, value in os.environ.items()
               if key not in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
                              "CLAUDE_CODE_OAUTH_TOKEN")}
        env.update({
            "HOME": home,
            "CLAUDE_CONFIG_DIR": cfg,
            "ANTHROPIC_BASE_URL": "http://127.0.0.1:%d" % port,
            "ANTHROPIC_API_KEY": "sk-ant-ocv5-746-drift-probe",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_TELEMETRY": "1",
        })
        version = "unknown"
        try:
            probe = subprocess.run([CLI, "--version"], env=env, cwd=work,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            version = (probe.stdout or b"").decode("utf-8", "replace").strip().split("\n")[0] or version
        except Exception:
            pass

        command = [CLI, "-p", "hi", "--max-turns", "1", "--strict-mcp-config", "--mcp-config", mcp]
        try:
            subprocess.run(command, env=env, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=int(os.environ.get("CC5_TIMEOUT", "90")))
        except subprocess.TimeoutExpired:
            pass

        if not BODIES:
            print("no API request reached the local probe endpoint", file=sys.stderr)
            return 3

        tools = {}
        deferred_names = []
        reminder = re.compile(
            r"The following deferred tools are now available via ToolSearch.*?before calling them:\s*\n((?:[A-Za-z][A-Za-z0-9_.:-]*\n?)+)",
            re.S)
        for raw in BODIES:
            try:
                body = json.loads(raw)
            except Exception:
                continue
            for entry in body.get("tools") or []:
                name = entry.get("name")
                if not isinstance(name, str) or not name:
                    continue
                known = tools.get(name)
                schema = entry.get("input_schema")
                if known is None or (not known.get("input_schema") and schema):
                    tools[name] = {
                        "name": name,
                        "description": entry.get("description") or "",
                        "input_schema": schema,
                        "defer_loading": bool(entry.get("defer_loading")),
                    }
            for message in body.get("messages") or []:
                content = message.get("content")
                parts = [content] if isinstance(content, str) else [
                    part.get("text") for part in (content or []) if isinstance(part, dict)]
                for text in parts:
                    if not text or "deferred tools are now available" not in text:
                        continue
                    match = reminder.search(text)
                    if match:
                        for line in match.group(1).split("\n"):
                            name = line.strip()
                            if name and name not in deferred_names:
                                deferred_names.append(name)
        for name in deferred_names:
            if name in tools:
                tools[name]["defer_loading"] = True

        result = {
            "source": "official-claude-code-cli",
            "cli_version": version.split(" ")[0] if version else "unknown",
            "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "capture_method": "pinned CLI run against a local endpoint answering HTTP 400; "
                              "isolated HOME/CLAUDE_CONFIG_DIR; dummy API key; no model calls",
            "model_calls": 0,
            "requests_captured": len(BODIES),
            "deferred_names": deferred_names,
            "tools": sorted(tools.values(), key=lambda tool: tool["name"]),
        }
        json.dump(result, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(ROOT, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
PY
)

PAYLOAD=$(printf '%s' "$REMOTE_PY" | base64 -w0)

# The payload travels base64-encoded inside the command (no stdin dependency) and is decoded on the
# node into a 0600 temp file owned by box, then removed.
REMOTE_SCRIPT=$(cat <<SH
set -u
f=\$(mktemp /tmp/ocv5-746-drift.XXXXXXXX.py) || exit 4
trap 'rm -f "\$f"' EXIT
printf '%s' '$PAYLOAD' | base64 -d > "\$f" || exit 4
CC5_CLI='$CLI' CC5_TIMEOUT='$TIMEOUT_SECONDS' python3 -I -B "\$f"
rc=\$?
rm -f "\$f"
exit \$rc
SH
)
REMOTE_B64=$(printf '%s' "$REMOTE_SCRIPT" | base64 -w0)
REMOTE_COMMAND="echo $REMOTE_B64 | base64 -d | sudo -u box -H bash"

if [ -n "$OUT" ]; then
  TMP_OUT=$(mktemp)
  trap 'rm -f "$TMP_OUT"' EXIT
  gcloud compute ssh "$NODE" --zone "$ZONE" --project "$PROJECT" --ssh-key-file="$KEY" \
    --command "$REMOTE_COMMAND" > "$TMP_OUT"
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "cc5-official-tools: extraction failed (exit $rc)" >&2
    exit $rc
  fi
  cp "$TMP_OUT" "$OUT"
  echo "wrote $OUT" >&2
else
  gcloud compute ssh "$NODE" --zone "$ZONE" --project "$PROJECT" --ssh-key-file="$KEY" \
    --command "$REMOTE_COMMAND"
fi
