/**
 * Sandboxed native CLI protocol fixtures for `scripts/agent-remote/conformance/runner.ts`.
 *
 * Strictly confined to `/tmp/oc-drvtest-*` directories:
 * - `cc` speaks authentic Claude Code NDJSON (`control_request/initialize` probe, `system/init`,
 *   `assistant` `mcp__ocbridge__*` tool_use, `stream_event`, `result`) and invokes `mcp.json`'s
 *   `ocbridge` stdio server (`scripts/agent-remote/core/mcp_client.py`).
 * - `codex` speaks authentic Codex `app-server` JSON-RPC 2.0 (`initialize`, `account/read`,
 *   `model/list`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`,
 *   `item/started`, `thread/tokenUsage/updated`, `turn/completed`) and invokes `config.toml`'s
 *   `mcp_servers.ocbridge` stdio server (`scripts/agent-remote/core/mcp_client.py`).
 * - Any additional registered driver (e.g. `AC-2` 3rd driver proof) receives `{ sandboxDir }`
 *   with zero driver-specific branches in this file, proving self-contained 5-duty extensibility.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function writeExecutable(path: string, content: string): string {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

export interface DriverSandboxPrepared {
  readonly upstreamModel: string
  readonly canonicalModel: string
  readonly probeContext: Record<string, unknown>
  readonly driverContext: Record<string, unknown>
}

export function makeCcConformanceCli(dir: string): string {
  return writeExecutable(
    join(dir, 'claude-conformance-cli'),
    `#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, threading, time

args = sys.argv[1:]
if "-p" in args:
    for raw in sys.stdin:
        if not raw.strip():
            continue
        msg = json.loads(raw)
        if msg.get("type") == "control_request" and msg.get("request", {}).get("subtype") == "initialize":
            out = {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": msg["request_id"],
                    "response": {
                        "claude_code_version": "2.1.316",
                        "account": {"email": "conformance@example.com", "subscriptionType": "max"},
                        "models": [{
                            "value": "claude-sonnet-4-6",
                            "displayName": "Sonnet 4.6",
                            "supportedEffortLevels": ["low", "medium", "high"],
                            "supportsAdaptiveThinking": True,
                        }],
                    },
                },
            }
            sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            sys.exit(0)
    sys.exit(1)

def arg_val(flag, default=""):
    return args[args.index(flag) + 1] if flag in args else default

model = arg_val("--model", "claude-sonnet-4-6")
session_id = arg_val("--session-id") or arg_val("--resume") or "11111111-2222-4333-8444-555555555555"
mcp_cfg = json.loads(pathlib.Path(arg_val("--mcp-config")).read_text())
oc_srv = mcp_cfg["mcpServers"]["ocbridge"]

def call_mcp(requests):
    proc = subprocess.Popen(
        [oc_srv["command"], *oc_srv["args"]],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    payload = "".join(json.dumps(r, separators=(",", ":")) + "\\n" for r in requests)
    try:
        out, _ = proc.communicate(payload, timeout=15)
    except Exception:
        proc.kill()
        return []
    return [json.loads(line) for line in out.splitlines() if line.strip()]

# Discover compiled tools via ocbridge tools/list
init_replies = call_mcp([
    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "cc", "version": "2.1.316"}}},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
])
tools_list = []
for rep in init_replies:
    if rep.get("id") == 2 and "result" in rep:
        tools_list = rep["result"].get("tools", [])

write_alias = "Write"
for t in tools_list:
    if t.get("name") == "Write":
        write_alias = "Write"
        break
    props = (t.get("inputSchema") or {}).get("properties") or {}
    if "file_path" in props and "content" in props:
        write_alias = t["name"]
        break
    if "token" in props:
        write_alias = t["name"]

sys.stdout.write(json.dumps({
    "type": "system",
    "subtype": "init",
    "session_id": session_id,
    "model": model,
    "tools": [f"mcp__ocbridge__{t['name']}" for t in tools_list] or [f"mcp__ocbridge__{write_alias}"],
}, separators=(",", ":")) + "\\n")
sys.stdout.flush()

turn_seq = 0
for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    if msg.get("type") == "control_request" and msg.get("request", {}).get("subtype") == "interrupt":
        sys.stdout.write(json.dumps({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "session_id": session_id,
            "uuid": f"res_cc_int_{turn_seq + 1}",
            "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        continue
    if msg.get("type") != "user":
        continue

    turn_seq += 1
    text = msg["message"]["content"][0]["text"]
    call_id = f"toolu_cc_{turn_seq:04d}"
    res_id = f"res_cc_{turn_seq:04d}"

    # Directive: NATIVE_DANGER_INDUCE:<nodePath>
    if text.startswith("NATIVE_DANGER_INDUCE:"):
        danger_target = text.split(":", 1)[1]
        tools_flag = arg_val("--tools", "")
        if danger_target.startswith("/tmp/oc-drvtest-") and "Bash" in tools_flag.split(","):
            pathlib.Path(danger_target).write_text("native-escaped", encoding="utf-8")
        sys.stdout.write(json.dumps({
            "type": "assistant",
            "session_id": session_id,
            "message": {
                "model": model,
                "role": "assistant",
                "content": [{"type": "tool_use", "id": call_id, "name": "Bash", "input": {"command": "touch " + danger_target}}],
            },
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        continue

    # Directive: UNOBSERVED_FORGED:<filePath>:<token>[:TEST_BYPASS_NODE_OBS]
    if text.startswith("UNOBSERVED_FORGED:"):
        u_parts = text.split(":")
        fpath = u_parts[1]
        tok = u_parts[2]
        call_mcp([{
            "jsonrpc": "2.0",
            "id": 900 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": {"file_path": fpath, "content": tok},
                "_meta": {"claudecode/toolUseId": "toolu_forged_unobserved"},
            },
        }])
        continue

    # Directive: ARGS_HASH_MISMATCH:<filePath>:<token>
    if text.startswith("ARGS_HASH_MISMATCH:"):
        _, fpath, tok = text.split(":", 2)
        sys.stdout.write(json.dumps({
            "type": "assistant",
            "session_id": session_id,
            "message": {
                "model": model,
                "role": "assistant",
                "content": [{"type": "tool_use", "id": call_id, "name": f"mcp__ocbridge__{write_alias}", "input": {"file_path": fpath, "content": "BENIGN_OBSERVED"}}],
            },
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        call_mcp([{
            "jsonrpc": "2.0",
            "id": 910 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": {"file_path": fpath, "content": tok},
                "_meta": {"claudecode/toolUseId": call_id},
            },
        }])
        continue

    # Directive: PARTIAL_DELTA_ONLY:<filePath>:<token>
    if text.startswith("PARTIAL_DELTA_ONLY:"):
        _, fpath, tok = text.split(":", 2)
        sys.stdout.write(json.dumps({
            "type": "stream_event",
            "session_id": session_id,
            "event": {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{\\"file_path\\":"}},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        call_mcp([{
            "jsonrpc": "2.0",
            "id": 920 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": {"file_path": fpath, "content": tok},
                "_meta": {"claudecode/toolUseId": call_id},
            },
        }])
        continue

    # Directive: MCP_BEFORE_OBSERVATION:<filePath>:<token>
    if text.startswith("MCP_BEFORE_OBSERVATION:"):
        _, fpath, tok = text.split(":", 2)
        call_mcp([{
            "jsonrpc": "2.0",
            "id": 925 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": {"file_path": fpath, "content": tok},
                "_meta": {"claudecode/toolUseId": call_id},
            },
        }])
        continue

    # Directive: NEGATIVE_OR_DROP_USAGE
    if text.startswith("NEGATIVE_OR_DROP_USAGE"):
        sys.stdout.write(json.dumps({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": session_id,
            "uuid": res_id,
            "usage": {"input_tokens": -5, "output_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        continue

    # Directive: MISSING_USAGE_TERMINAL
    if text.startswith("MISSING_USAGE_TERMINAL"):
        sys.stdout.write(json.dumps({
            "type": "stream_event",
            "session_id": session_id,
            "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "no-usage"}},
        }, separators=(",", ":")) + "\\n")
        # Emit malformed result with empty usage to test missing usage fail-closed
        sys.stdout.write(json.dumps({
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": session_id,
            "uuid": res_id,
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        continue

    # Directive: BARRIER_WAIT:<arriveFile>:<releaseFile>:<sentinelPath>:<token>
    if text.startswith("BARRIER_WAIT:"):
        _, arrive_f, release_f, fpath, tok = text.split(":", 4)
        pathlib.Path(arrive_f).write_text("arrived", encoding="utf-8")
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline and not pathlib.Path(release_f).exists():
            time.sleep(0.02)
        text = f"SENTINEL_WRITE:{fpath}:{tok}"

    # Directive: SENTINEL_WRITE:<filePath>:<token>[:DUP_CONCURRENT]
    if text.startswith("SENTINEL_WRITE:"):
        parts = text.split(":")
        fpath = parts[1]
        tok = parts[2]
        dup = len(parts) > 3 and parts[3] == "DUP_CONCURRENT"
        tool_args = {"file_path": fpath, "content": tok}
        sys.stdout.write(json.dumps({
            "type": "assistant",
            "session_id": session_id,
            "message": {
                "model": model,
                "role": "assistant",
                "content": [{"type": "tool_use", "id": call_id, "name": f"mcp__ocbridge__{write_alias}", "input": tool_args}],
            },
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()

        mcp_req = {
            "jsonrpc": "2.0",
            "id": 100 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": write_alias,
                "arguments": tool_args,
                "_meta": {"claudecode/toolUseId": call_id},
            },
        }
        if dup:
            raw_line = json.dumps(mcp_req, separators=(",", ":")) + "\\n"
            t1 = threading.Thread(target=lambda: subprocess.Popen([oc_srv["command"], *oc_srv["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).communicate(raw_line, timeout=15))
            t2 = threading.Thread(target=lambda: subprocess.Popen([oc_srv["command"], *oc_srv["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).communicate(raw_line, timeout=15))
            t1.start(); t2.start()
            t1.join(); t2.join()
        else:
            call_mcp([mcp_req])

    sys.stdout.write(json.dumps({
        "type": "stream_event",
        "session_id": session_id,
        "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": f"cc-ok-{turn_seq}"}},
    }, separators=(",", ":")) + "\\n")
    result_frame = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "session_id": session_id,
        "uuid": res_id,
        "usage": {
            "input_tokens": 1000000 * turn_seq,
            "output_tokens": 200000 * turn_seq,
            "cache_read_input_tokens": 100000,
            "cache_creation_input_tokens": 0,
        },
    }
    sys.stdout.write(json.dumps(result_frame, separators=(",", ":")) + "\\n")
    if text.startswith("DUPLICATE_TERMINAL:SAME"):
        sys.stdout.write(json.dumps(result_frame, separators=(",", ":")) + "\\n")
    elif text.startswith("DUPLICATE_TERMINAL:CONFLICT"):
        conflict_frame = dict(result_frame)
        conflict_frame["is_error"] = True
        conflict_frame["subtype"] = "error_during_execution"
        sys.stdout.write(json.dumps(conflict_frame, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
`,
  )
}

export function makeCodexConformanceCli(dir: string): string {
  return writeExecutable(
    join(dir, 'codex-conformance-cli'),
    `#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, threading, time

args = sys.argv[1:]
oc_cmd = None
oc_args = []
model_catalog_path = None
for idx, arg in enumerate(args):
    if arg == "-c" and idx + 1 < len(args):
        kv = args[idx + 1]
        if kv.startswith("mcp_servers.ocbridge.command="):
            oc_cmd = json.loads(kv.split("=", 1)[1])
        elif kv.startswith("mcp_servers.ocbridge.args="):
            oc_args = json.loads(kv.split("=", 1)[1])
        elif kv.startswith("model_catalog_json="):
            model_catalog_path = json.loads(kv.split("=", 1)[1])

shell_policy_relaxed = False
if model_catalog_path and pathlib.Path(model_catalog_path).is_file():
    cat_obj = json.loads(pathlib.Path(model_catalog_path).read_text(encoding="utf-8"))
    for entry in cat_obj.get("models") or []:
        if "shell" in (entry.get("experimental_supported_tools") or []):
            shell_policy_relaxed = True

def call_mcp(requests):
    if not oc_cmd:
        return []
    proc = subprocess.Popen(
        [oc_cmd, *oc_args],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    payload = "".join(json.dumps(r, separators=(",", ":")) + "\\n" for r in requests)
    try:
        out, _ = proc.communicate(payload, timeout=15)
    except Exception:
        proc.kill()
        return []
    return [json.loads(line) for line in out.splitlines() if line.strip()]

write_alias = "Write"
if oc_cmd:
    init_replies = call_mcp([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "codex", "version": "0.167.0"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    ])
    for rep in init_replies:
        if rep.get("id") == 2 and "result" in rep:
            for t in rep["result"].get("tools", []):
                if t.get("name") == "Write":
                    write_alias = "Write"
                    break
                props = (t.get("inputSchema") or {}).get("properties") or {}
                if "file_path" in props and "content" in props:
                    write_alias = t["name"]
                    break
                if "token" in props:
                    write_alias = t["name"]

thread_id = f"thr_conf_{os.getpid()}"
turn_seq = 0
cum_in = 0
cum_cached = 0
cum_out = 0
cum_reason = 0

for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    method = msg.get("method")
    rid = msg.get("id")

    if method == "initialize":
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"userAgent": "codex-cli/0.167.0"}}, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method == "initialized":
        continue
    elif method == "account/read":
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"account": {"email": "codex-conf@example.com", "planType": "pro"}}}, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method == "model/list":
        sys.stdout.write(json.dumps({
            "jsonrpc": "2.0",
            "id": rid,
            "result": {
                "data": [{
                    "model": "gpt-6-luna",
                    "displayName": "GPT-6 Luna",
                    "hidden": False,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}, {"reasoningEffort": "high"}],
                    "inputModalities": ["text", "image"],
                }],
                "nextCursor": None,
            },
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method in ("thread/start", "thread/resume"):
        if method == "thread/resume" and msg.get("params", {}).get("threadId"):
            thread_id = msg["params"]["threadId"]
        sys.stdout.write(json.dumps({
            "jsonrpc": "2.0",
            "id": rid,
            "result": {"thread": {"id": thread_id}, "model": msg.get("params", {}).get("model", "gpt-6-luna")},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method == "turn/interrupt":
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {}}, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method == "turn/start":
        turn_seq += 1
        turn_id = f"turn_conf_{turn_seq:04d}"
        call_id = f"call_conf_{turn_seq:04d}"
        text = msg["params"]["input"][0]["text"]

        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"turn": {"id": turn_id, "status": "inProgress"}}}, separators=(",", ":")) + "\\n")
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "turn/started", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "inProgress"}}}, separators=(",", ":")) + "\\n")
        sys.stdout.flush()

        if text.startswith("NATIVE_DANGER_INDUCE:"):
            danger_target = text.split(":", 1)[1]
            if danger_target.startswith("/tmp/oc-drvtest-") and shell_policy_relaxed:
                pathlib.Path(danger_target).write_text("native-escaped", encoding="utf-8")
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "method": "item/started",
                "params": {"threadId": thread_id, "turnId": turn_id, "item": {"type": "commandExecution", "id": call_id, "command": "touch " + danger_target}},
            }, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            continue

        if text.startswith("UNOBSERVED_FORGED:"):
            import hashlib
            u_parts = text.split(":")
            fpath = u_parts[1]
            tok = u_parts[2]
            bypass_node_obs = len(u_parts) > 3 and u_parts[3] == "TEST_BYPASS_NODE_OBS"
            forged_args = {"file_path": fpath, "content": tok}
            if bypass_node_obs and str(pathlib.Path.cwd()).startswith("/tmp/oc-drvtest-"):
                task_root = pathlib.Path.cwd().parent
                mf = json.loads((task_root / "MANIFEST.json").read_text(encoding="utf-8"))
                args_canon = json.dumps({"content": tok, "file_path": fpath}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                obs_dir = task_root / "observations"
                obs_dir.mkdir(mode=0o700, exist_ok=True)
                call_key = hashlib.sha256(b"call_forged_unobserved").hexdigest()
                obs_file = obs_dir / (call_key + ".json")
                obs_file.write_text(json.dumps({
                    "operationId": mf["operationId"],
                    "runId": mf["runId"],
                    "generation": mf["generation"],
                    "nativeSessionId": thread_id,
                    "nativeTurnId": turn_id,
                    "callId": "call_forged_unobserved",
                    "name": write_alias,
                    "argsHash": hashlib.sha256(args_canon).hexdigest(),
                }, separators=(",", ":")), encoding="utf-8")
                os.chmod(obs_file, 0o600)
            call_mcp([{
                "jsonrpc": "2.0",
                "id": 900 + turn_seq,
                "method": "tools/call",
                "params": {
                    "name": write_alias,
                    "arguments": forged_args,
                    "_meta": {"callId": "call_forged_unobserved", "threadId": thread_id, "x-codex-turn-metadata": {"turn_id": turn_id}},
                },
            }])
            continue

        if text.startswith("ARGS_HASH_MISMATCH:"):
            _, fpath, tok = text.split(":", 2)
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "method": "item/started",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {"type": "mcpToolCall", "id": call_id, "server": "ocbridge", "tool": write_alias, "arguments": {"file_path": fpath, "content": "BENIGN_OBSERVED"}},
                },
            }, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            call_mcp([{
                "jsonrpc": "2.0",
                "id": 910 + turn_seq,
                "method": "tools/call",
                "params": {
                    "name": write_alias,
                    "arguments": {"file_path": fpath, "content": tok},
                    "_meta": {"callId": call_id, "threadId": thread_id, "x-codex-turn-metadata": {"turn_id": turn_id}},
                },
            }])
            continue

        if text.startswith("PARTIAL_DELTA_ONLY:"):
            _, fpath, tok = text.split(":", 2)
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "method": "item/agentMessage/delta",
                "params": {"delta": "thinking..."},
            }, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            call_mcp([{
                "jsonrpc": "2.0",
                "id": 920 + turn_seq,
                "method": "tools/call",
                "params": {
                    "name": write_alias,
                    "arguments": {"file_path": fpath, "content": tok},
                    "_meta": {"callId": call_id, "threadId": thread_id, "x-codex-turn-metadata": {"turn_id": turn_id}},
                },
            }])
            continue

        if text.startswith("MCP_BEFORE_OBSERVATION:"):
            _, fpath, tok = text.split(":", 2)
            call_mcp([{
                "jsonrpc": "2.0",
                "id": 925 + turn_seq,
                "method": "tools/call",
                "params": {
                    "name": write_alias,
                    "arguments": {"file_path": fpath, "content": tok},
                    "_meta": {"callId": call_id, "threadId": thread_id, "x-codex-turn-metadata": {"turn_id": turn_id}},
                },
            }])
            continue

        if text.startswith("NEGATIVE_OR_DROP_USAGE"):
            dropped_in = cum_in - 1 if cum_in > 0 else -1
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "method": "thread/tokenUsage/updated",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "tokenUsage": {
                        "total": {
                            "totalTokens": dropped_in + cum_out + 10,
                            "inputTokens": dropped_in,
                            "cachedInputTokens": cum_cached,
                            "cacheWriteInputTokens": 0,
                            "outputTokens": cum_out + 10,
                            "reasoningOutputTokens": cum_reason,
                        },
                    },
                },
            }, separators=(",", ":")) + "\\n")
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}}}, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            continue

        if text.startswith("MISSING_USAGE_TERMINAL"):
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"delta": "no-usage"}}, separators=(",", ":")) + "\\n")
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}}}, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            continue

        if text.startswith("BARRIER_WAIT:"):
            _, arrive_f, release_f, fpath, tok = text.split(":", 4)
            pathlib.Path(arrive_f).write_text("arrived", encoding="utf-8")
            deadline = time.monotonic() + 8.0
            while time.monotonic() < deadline and not pathlib.Path(release_f).exists():
                time.sleep(0.02)
            text = f"SENTINEL_WRITE:{fpath}:{tok}"

        if text.startswith("SENTINEL_WRITE:"):
            parts = text.split(":")
            fpath = parts[1]
            tok = parts[2]
            dup = len(parts) > 3 and parts[3] == "DUP_CONCURRENT"
            tool_args = {"file_path": fpath, "content": tok}
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "method": "item/started",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {"type": "mcpToolCall", "id": call_id, "server": "ocbridge", "tool": write_alias, "arguments": tool_args},
                },
            }, separators=(",", ":")) + "\\n")
            sys.stdout.flush()

            mcp_req = {
                "jsonrpc": "2.0",
                "id": 100 + turn_seq,
                "method": "tools/call",
                "params": {
                    "name": write_alias,
                    "arguments": tool_args,
                    "_meta": {"callId": call_id, "threadId": thread_id, "x-codex-turn-metadata": {"turn_id": turn_id}},
                },
            }
            if dup and oc_cmd:
                raw_line = json.dumps(mcp_req, separators=(",", ":")) + "\\n"
                t1 = threading.Thread(target=lambda: subprocess.Popen([oc_cmd, *oc_args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).communicate(raw_line, timeout=15))
                t2 = threading.Thread(target=lambda: subprocess.Popen([oc_cmd, *oc_args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).communicate(raw_line, timeout=15))
                t1.start(); t2.start()
                t1.join(); t2.join()
            else:
                call_mcp([mcp_req])

        cum_in += 1000000
        cum_cached += 400000
        cum_out += 250000
        cum_reason += 100000

        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"delta": f"codex-ok-{turn_seq}"}}, separators=(",", ":")) + "\\n")
        sys.stdout.write(json.dumps({
            "jsonrpc": "2.0",
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "tokenUsage": {
                    "total": {
                        "totalTokens": cum_in + cum_out,
                        "inputTokens": cum_in,
                        "cachedInputTokens": cum_cached,
                        "cacheWriteInputTokens": 0,
                        "outputTokens": cum_out,
                        "reasoningOutputTokens": cum_reason,
                    },
                },
            },
        }, separators=(",", ":")) + "\\n")
        completed_frame = {
            "jsonrpc": "2.0",
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}},
        }
        sys.stdout.write(json.dumps(completed_frame, separators=(",", ":")) + "\\n")
        if text.startswith("DUPLICATE_TERMINAL:SAME"):
            sys.stdout.write(json.dumps(completed_frame, separators=(",", ":")) + "\\n")
        elif text.startswith("DUPLICATE_TERMINAL:CONFLICT"):
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "method": "turn/completed",
                "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "failed"}},
            }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
`,
  )
}

export function prepareDriverSandbox(
  driverId: string,
  sandbox: string,
  sessionIndex = 1,
): DriverSandboxPrepared {
  if (driverId === 'cc') {
    const cliPath = makeCcConformanceCli(sandbox)
    const sessionUuid = `11111111-2222-4333-8444-${String(sessionIndex).padStart(12, '0')}`
    return {
      upstreamModel: 'claude-sonnet-4-6',
      canonicalModel: 'claude-sonnet-4-6-remote',
      probeContext: { cliPath, accountHome: sandbox },
      driverContext: {
        cliPath,
        accountHome: sandbox,
        bridgeMode: 'stdio-fixture',
        initialSessionUuid: sessionUuid,
      },
    }
  }
  if (driverId === 'codex') {
    const cliPath = makeCodexConformanceCli(sandbox)
    const codexHome = join(sandbox, 'codex-home-shared')
    mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    if (!existsSync(join(codexHome, 'auth.json'))) {
      writeFileSync(join(codexHome, 'auth.json'), '{"token":"redacted-conformance"}', { mode: 0o600 })
    }
    return {
      upstreamModel: 'gpt-6-luna',
      canonicalModel: 'gpt-6-luna-remote',
      probeContext: {
        cliPath,
        nativePath: cliPath,
        codexHome,
        systemCodexRoot: join(sandbox, 'empty-etc-codex'),
      },
      driverContext: {
        cliPath,
        nativePath: cliPath,
        codexHome,
        systemCodexRoot: join(sandbox, 'empty-etc-codex'),
      },
    }
  }
  // Generic path for any self-contained 5-duty driver (`AC-2` zero-core-diff proof).
  return {
    upstreamModel: `${driverId.replaceAll('_', '-')}-v1`,
    canonicalModel: `${driverId.replaceAll('_', '-')}-v1-remote`,
    probeContext: { sandboxDir: sandbox },
    driverContext: { sandboxDir: sandbox, sessionIndex },
  }
}
