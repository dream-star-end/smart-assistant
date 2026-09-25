#!/usr/bin/env python3
"""One real current-container direct CCB control, not a Box implementation.

Synthetic local-only MCP fixture; summary contains no prompt, tool result,
credential, model text, or raw event. Never retries a paid CLI invocation.
"""
import json
import os
import re
import secrets
import selectors
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/home/agent/.openclaude/workspace/ocv5-289-box-api")
MODEL = "claude-opus-5-5"
TOOL = "mcp__ocv5probe__read_secret"
CATALOG = ('import {getModelCatalogClient} from '
           '"./packages/gateway/src/modelCatalogClient.ts"; '
           'getModelCatalogClient().getToken().then(x=>process.stdout.write(x))'
           '.catch(()=>process.exit(1));')


def main():
    if os.environ.get("OCV5_289_DIRECT_PARITY_ACK") != "1":
        raise RuntimeError("DIRECT_PARITY_ACK_REQUIRED")
    if not ROOT.is_dir() or os.getuid() != 1000:
        raise RuntimeError("DIRECT_PARITY_CONTAINER_INVALID")
    nonce = secrets.token_hex(12)
    marker = "ocv5-289-direct-" + secrets.token_hex(12)
    fixture = ROOT / (".ocv5-289-read-" + nonce + ".txt")
    used = Path(str(fixture) + ".used")
    fd = os.open(fixture, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write((marker + "\n").encode())
            output.flush()
            os.fsync(output.fileno())
        catalog = subprocess.run(
            ["/opt/openclaude/node_modules/.bin/tsx", "-e", CATALOG],
            cwd="/opt/openclaude", capture_output=True, timeout=15, check=True)
        token = catalog.stdout.decode("ascii").strip()
        if not re.fullmatch(r"[A-Za-z0-9._~-]{20,8192}", token):
            raise RuntimeError("DIRECT_CATALOG_TOKEN_INVALID")
        env = os.environ.copy()
        env["ANTHROPIC_CUSTOM_HEADERS"] = "x-oc-local-catalog: " + token
        env["CLAUDE_CODE_EXTRA_METADATA"] = json.dumps({"oc_turn_key": secrets.token_hex(32)})
        env["CLAUDE_CODE_MAX_RETRIES"] = "0"
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
        mcp = {"mcpServers": {"ocv5probe": {"type": "stdio", "command": "/usr/bin/python3",
               "args": ["-I", str(ROOT / "scripts/ocv5-289/ccb_local_probe_mcp.py"), str(fixture)]}}}
        prompt = ("Use the local read_secret tool exactly once. It has no arguments and "
                  "returns an unpredictable synthetic token held only in this OpenClaude "
                  "user container. Reply with exactly that token, without quotes or explanation. "
                  "Do not guess.")
        args = ["claude", "-p", prompt, "--model", MODEL,
                "--mcp-config", json.dumps(mcp), "--strict-mcp-config", "--tools", "",
                "--allowedTools", TOOL, "--output-format", "stream-json", "--verbose",
                "--include-partial-messages", "--no-session-persistence"]
        started = time.monotonic()
        child = subprocess.Popen(args, cwd=ROOT, env=env,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ, "out")
        selector.register(child.stderr, selectors.EVENT_READ, "err")
        buffers = {"out": bytearray(), "err": bytearray()}
        raw = bytearray()
        first_visible = None
        delta_times = []
        while selector.get_map():
            if time.monotonic() - started > 240:
                child.kill()
                raise RuntimeError("DIRECT_PARITY_TIMEOUT")
            for key, _ in selector.select(timeout=1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                name = key.data
                if len(raw) + len(chunk) > 2_000_000 and name == "out":
                    child.kill()
                    raise RuntimeError("DIRECT_PARITY_OUTPUT_TOO_LARGE")
                if name == "out":
                    raw.extend(chunk)
                    buffers[name].extend(chunk)
                    while b"\n" in buffers[name]:
                        line, _, remaining = buffers[name].partition(b"\n")
                        buffers[name] = bytearray(remaining)
                        try:
                            record = json.loads(line)
                            event = record.get("event", {}) if record.get("type") == "stream_event" else {}
                            kind = event.get("type")
                            delta = event.get("delta", {})
                            visible = (kind == "content_block_start"
                                       and event.get("content_block", {}).get("type") == "tool_use")
                            visible |= (kind == "content_block_delta"
                                        and delta.get("type") == "text_delta"
                                        and bool(delta.get("text")))
                            if visible:
                                ms = int((time.monotonic() - started) * 1000)
                                if first_visible is None:
                                    first_visible = ms
                                delta_times.append(ms)
                        except (ValueError, AttributeError, TypeError):
                            pass
                else:
                    buffers[name].extend(chunk)
                    if len(buffers[name]) > 100_000:
                        child.kill()
                        raise RuntimeError("DIRECT_PARITY_STDERR_TOO_LARGE")
        exit_code = child.wait(timeout=5)
        records = [json.loads(line) for line in raw.splitlines() if line]
        results = [item for item in records if item.get("type") == "result"]
        tool_ids = set()
        for item in records:
            if item.get("type") != "assistant":
                continue
            for block in item.get("message", {}).get("content", []):
                if block.get("type") == "tool_use" and block.get("name") == TOOL:
                    tool_ids.add(block.get("id"))
        used_once = used.exists() and used.read_text() == "1\n"
        success = (exit_code == 0 and len(results) == 1
                   and results[0].get("is_error") is False
                   and str(results[0].get("result", "")).strip() == marker
                   and used_once and len(tool_ids) == 1)
        failure = None
        if not success and results:
            result = str(results[0].get("result", ""))
            for code, pattern in (("AUTHORITY", "model authority"),
                                  ("ENTITLEMENT", "entitlement"),
                                  ("QUOTA", "quota"),
                                  ("UPSTREAM", "upstream"),
                                  ("API_ERROR", "API Error")):
                if pattern.lower() in result.lower():
                    failure = code
                    break
            failure = failure or "OTHER"
        print(json.dumps({"route": "direct_ccb", "model": MODEL, "success": success,
                          "exit": exit_code, "resultCount": len(results),
                          "apiErrorStatus": results[0].get("api_error_status") if results else None,
                          "failureClass": failure,
                          "toolUseCount": len(tool_ids), "localToolOnce": used_once,
                          "firstVisibleMs": first_visible, "visibleDeltas": len(delta_times),
                          "totalMs": int((time.monotonic() - started) * 1000),
                          "maxVisibleGapMs": max((b-a for a, b in zip(delta_times, delta_times[1:])),
                                             default=None)}))
        if not success:
            raise RuntimeError("DIRECT_PARITY_BUSINESS_RESULT_INVALID")
    finally:
        for path in (used, fixture):
            try:
                path.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch(r"[A-Z][A-Z0-9_]{1,79}", str(error)) else "DIRECT_PARITY_FAILED"
        print(code, file=sys.stderr)
        sys.exit(1)
