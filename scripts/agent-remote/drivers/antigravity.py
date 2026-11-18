#!/usr/bin/env python3
"""5-duty Remote Driver (`antigravity`) for official Google Antigravity CLI (`remote-driver-v4`).

Implements strictly the 5 pure data-returning driver duties:
1. `usage_policy()`
2. `launch_spec(context, verified_probe)`
3. `encode(command, native_state)`
4. `decode(channel, raw_frame, native_state)`
5. `probe(context, previous_step_result)`
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any, Dict, List, Optional

from core.canonical import remote_canonical_sha256, strict_json
from core.contract import IDENT_RE, TOOL_ALIAS_RE, need

DRIVER_ID = "antigravity"
ENGINE_ID = "antigravity"
AUTHORITY_ENGINE = "antigravity"
DRIVER_VERSION = "1.0.0"
SEMANTICS_ID = "antigravity-stream-json-v1"
VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max")

MODEL_SPECS: Dict[str, Dict[str, Any]] = {
    "gemini-4-carbon": {"display": "Gemini 4 Carbon", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-4-carbon-low": {"display": "Gemini 4 Carbon Low", "efforts": ["low", "medium", "high"], "default": "low"},
    "gemini-4-carbon-medium": {"display": "Gemini 4 Carbon Medium", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-4-carbon-high": {"display": "Gemini 4 Carbon High", "efforts": ["low", "medium", "high"], "default": "high"},
    "gemini-4-hydrogen": {"display": "Gemini 4 Hydrogen", "efforts": ["low", "medium", "high", "xhigh"], "default": "high"},
    "gemini-4-hydrogen-low": {"display": "Gemini 4 Hydrogen Low", "efforts": ["low", "medium", "high", "xhigh"], "default": "low"},
    "gemini-4-hydrogen-medium": {"display": "Gemini 4 Hydrogen Medium", "efforts": ["low", "medium", "high", "xhigh"], "default": "medium"},
    "gemini-4-hydrogen-high": {"display": "Gemini 4 Hydrogen High", "efforts": ["low", "medium", "high", "xhigh"], "default": "high"},
    "gemini-4-hydrogen-xhigh": {"display": "Gemini 4 Hydrogen XHigh", "efforts": ["low", "medium", "high", "xhigh"], "default": "xhigh"},
    "gemini-pro-orchestrator": {"display": "Orchestrator Carbon", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-4-argon": {"display": "Gemini 4 Argon", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-4-argon-low": {"display": "Gemini 4 Argon Low", "efforts": ["low", "medium", "high"], "default": "low"},
    "gemini-4-argon-medium": {"display": "Gemini 4 Argon Medium", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-4-argon-high": {"display": "Gemini 4 Argon High", "efforts": ["low", "medium", "high"], "default": "high"},
    "gemini-3.8-flash": {"display": "Gemini 3.8 Flash", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-3.8-flash-low": {"display": "Gemini 3.8 Flash Low", "efforts": ["low", "medium", "high"], "default": "low"},
    "gemini-3.8-flash-medium": {"display": "Gemini 3.8 Flash Medium", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-3.8-flash-high": {"display": "Gemini 3.8 Flash High", "efforts": ["low", "medium", "high"], "default": "high"},
    "claude-opus-5-5": {"display": "Claude Opus 5.5", "efforts": ["low", "medium", "high"], "default": "medium"},
    "claude-opus-5-5-low": {"display": "Claude Opus 5.5 Low", "efforts": ["low", "medium", "high"], "default": "low"},
    "claude-opus-5-5-medium": {"display": "Claude Opus 5.5 Medium", "efforts": ["low", "medium", "high"], "default": "medium"},
    "claude-opus-5-5-high": {"display": "Claude Opus 5.5 High", "efforts": ["low", "medium", "high"], "default": "high"},
    "claude-sonnet-5-5": {"display": "Claude Sonnet 5.5", "efforts": ["low", "medium", "high"], "default": "medium"},
    "claude-sonnet-5-5-low": {"display": "Claude Sonnet 5.5 Low", "efforts": ["low", "medium", "high"], "default": "low"},
    "claude-sonnet-5-5-medium": {"display": "Claude Sonnet 5.5 Medium", "efforts": ["low", "medium", "high"], "default": "medium"},
    "claude-sonnet-5-5-high": {"display": "Claude Sonnet 5.5 High", "efforts": ["low", "medium", "high"], "default": "high"},
    "gpt-oss-120b": {"display": "GPT-OSS 120B", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gpt-oss-120b-medium": {"display": "GPT-OSS 120B Medium", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-3.1-pro": {"display": "Gemini 3.1 Pro", "efforts": ["low", "medium", "high"], "default": "medium"},
    "gemini-3.1-flash": {"display": "Gemini 3.1 Flash", "efforts": ["low", "medium", "high"], "default": "medium"},
}

BASE_TO_VARIANTS: Dict[str, List[str]] = {
    "gemini-4-carbon": ["gemini-4-carbon", "gemini-4-carbon-low", "gemini-4-carbon-medium", "gemini-4-carbon-high"],
    "gemini-4-hydrogen": ["gemini-4-hydrogen", "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh"],
    "gemini-pro-orchestrator": ["gemini-pro-orchestrator"],
    "gemini-4-argon": ["gemini-4-argon", "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"],
    "gemini-3.8-flash": ["gemini-3.8-flash", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"],
    "claude-opus-5-5": ["claude-opus-5-5", "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high"],
    "claude-sonnet-5-5": ["claude-sonnet-5-5", "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high"],
    "gpt-oss-120b": ["gpt-oss-120b", "gpt-oss-120b-medium"],
    "gemini-3.1-pro": ["gemini-3.1-pro"],
    "gemini-3.1-flash": ["gemini-3.1-flash"],
}

_DENY_NATIVE_PY = r"""#!/usr/bin/env python3
import json, os, pathlib, sys, time

try:
    payload = json.loads(sys.stdin.read() or "{}")
except Exception:
    payload = {}
tool_call = payload.get("toolCall") if isinstance(payload.get("toolCall"), dict) else (
    payload.get("tool_call") if isinstance(payload.get("tool_call"), dict) else {}
)
name = str(tool_call.get("name") or payload.get("tool_name") or "")
if name.startswith("mcp_ocbridge_"):
    try:
        args = tool_call.get("args")
        if not isinstance(args, dict):
            args = tool_call.get("arguments")
        if not isinstance(args, dict):
            args = tool_call.get("input")
        if not isinstance(args, dict):
            args = payload.get("tool_input")
        if isinstance(args, dict):
            pretool_dir = pathlib.Path(__file__).resolve().parent / "run" / "pretool"
            pretool_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            doc = {"name": name, "args": args}
            sidx = payload.get("stepIdx")
            if type(sidx) is not int:
                sidx = payload.get("step_index")
            if type(sidx) is int:
                doc["stepIdx"] = sidx
            cid = payload.get("conversation_id") or payload.get("conversationId")
            if isinstance(cid, str) and cid:
                doc["conversationId"] = cid
            raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

            def _atomic_write(dst: pathlib.Path) -> None:
                tmp = dst.with_name(f".{dst.name}.{os.getpid()}.tmp")
                fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                try:
                    view = memoryview(raw)
                    while view:
                        written = os.write(fd, view)
                        if written <= 0:
                            raise OSError("short write")
                        view = view[written:]
                finally:
                    os.close(fd)
                os.replace(tmp, dst)

            if type(sidx) is int:
                _atomic_write(pretool_dir / f"step_{sidx}.json")
            _atomic_write(pretool_dir / f"seq_{time.time_ns()}_{os.getpid()}.json")
    except Exception:
        pass
    sys.stdout.write(json.dumps({"decision": "allow"}) + "\n")
elif name == "exit_plan_mode":
    sys.stdout.write(json.dumps({"decision": "allow"}) + "\n")
else:
    sys.stdout.write(json.dumps({"decision": "deny", "reason": "native_tool_forbidden:" + name}) + "\n")
sys.stdout.flush()
"""

_AGY_HOST_PY = r"""#!/usr/bin/env python3
import collections, json, os, pathlib, queue, re, shutil, signal, sqlite3, subprocess, sys, threading, time

cfg = json.loads((pathlib.Path(__file__).resolve().parent / "host_config.json").read_text(encoding="utf-8"))
home_dir = pathlib.Path(os.environ["HOME"])
cli_home_dir = home_dir / ".gemini" / "antigravity-cli"
cli_home_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
acct_home_raw = str(cfg.get("accountHome") or "").strip()
if acct_home_raw:
    acct_home = pathlib.Path(acct_home_raw)
    if acct_home.is_dir():
        for cand in (
            acct_home / ".gemini" / "antigravity-cli" / "antigravity-oauth-token",
            acct_home / "antigravity-cli" / "antigravity-oauth-token",
            acct_home / "antigravity-oauth-token",
            acct_home / ".gemini" / "antigravity-cli" / "auth.json",
        ):
            if cand.is_file():
                dst = cli_home_dir / "antigravity-oauth-token"
                shutil.copy2(cand, dst)
                os.chmod(dst, 0o600)
                break
        acct_cli_dir = acct_home / ".gemini" / "antigravity-cli"
        if acct_cli_dir.is_dir():
            for sub in ("conversations", "bin"):
                target = acct_cli_dir / sub
                if sub == "conversations":
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                if not target.exists():
                    continue
                local_sub = cli_home_dir / sub
                if local_sub.is_symlink():
                    local_sub.unlink()
                elif local_sub.is_dir():
                    try:
                        local_sub.rmdir()
                    except OSError:
                        shutil.rmtree(local_sub)
                os.symlink(str(target), str(local_sub))

out_lock = threading.Lock()
state_lock = threading.Lock()
cmd_queue = queue.Queue()

def emit(obj):
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    with out_lock:
        sys.stdout.write(line)
        sys.stdout.flush()

def is_elf(path_str):
    try:
        with open(path_str, "rb") as f:
            return f.read(4) == b"\x7fELF"
    except Exception:
        return False

def resolve_cli_prefix():
    cli_path = cfg["cliPath"]
    qemu_path = str(cfg.get("qemuPath") or "").strip()
    if is_elf(cli_path):
        if qemu_path and pathlib.Path(qemu_path).is_file():
            return [qemu_path, "-cpu", "max", cli_path]
        try:
            cpuinfo = pathlib.Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore")
        except Exception:
            cpuinfo = ""
        if "pclmulqdq" not in cpuinfo:
            cand = pathlib.Path(cli_path).resolve().parent.parent / "lib" / "antigravity-compat" / "usr" / "bin" / "qemu-x86_64-static"
            if cand.is_file():
                return [str(cand), "-cpu", "max", cli_path]
    return [cli_path]

conv_id = str(cfg.get("initialSessionId") or "").strip()
child = None
current_child_model = ""
probed_models_set = set(str(x) for x in (cfg.get("probedModels") or []))
active_turn_seq = 0
seen_max_step_idx = -1
turn_in_flight = False
interrupted_flag = False
pending_interrupt_cmd = None
applied_launch_system_prompt = False
stderr_tail = collections.deque(maxlen=40)

def resolve_cli_model(base_model, effort_val=""):
    eff = str(effort_val or "").strip().lower()
    if not eff:
        return base_model
    m = re.match(r"^(.+)-(low|medium|high|xhigh|max)$", base_model)
    family = m.group(1) if m else base_model
    cand = f"{family}-{eff}"
    if cand in probed_models_set:
        return cand
    return base_model

def compute_db_baseline(resume_id):
    if not resume_id:
        return -1
    db_file = cli_home_dir / "conversations" / f"{resume_id}.db"
    if not db_file.is_file():
        return -1
    try:
        conn = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True, timeout=1.0)
        try:
            row = conn.execute("SELECT COALESCE(MAX(idx), -1) FROM steps").fetchone()
            return int(row[0]) if row and row[0] is not None else -1
        finally:
            conn.close()
    except Exception:
        return -1

def stop_child_gracefully():
    global child
    with state_lock:
        proc = child
    if proc is None or proc.poll() is not None:
        return
    try:
        if proc.stdin:
            proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        try:
            proc.terminate()
            proc.wait(timeout=1.5)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=1.0)
            except Exception:
                pass
    with state_lock:
        if child is proc:
            child = None

def spawn_cli(resume_id, effort_val=""):
    global child, current_child_model
    launch_baseline = max(seen_max_step_idx, compute_db_baseline(resume_id)) if resume_id else -1
    is_resumed = bool(resume_id)
    target_model = resolve_cli_model(cfg["model"], effort_val)
    cmd = resolve_cli_prefix() + [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--model", target_model,
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
    ]
    if not cfg.get("nativeToolsFlag"):
        cmd.extend(["--agent", "ocremote"])
    if resume_id:
        cmd.extend(["--conversation", resume_id])
    ev = threading.Event()
    reader_done = threading.Event()
    with state_lock:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=os.environ.copy(),
        )
        child = proc
        current_child_model = target_model

    def read_err():
        try:
            for ln in proc.stderr:
                stderr_tail.append(ln.rstrip("\n")[:240])
        except Exception:
            pass

    pretool_dir = pathlib.Path(__file__).resolve().parent / "run" / "pretool"
    hydrated_by_step = {}

    def _has_truncated_string(val):
        if isinstance(val, str):
            return val.endswith("\u2026")
        if isinstance(val, dict):
            return any(_has_truncated_string(v) for v in val.values())
        if isinstance(val, list):
            return any(_has_truncated_string(x) for x in val)
        return False

    def _value_matches_truncated(cur, full):
        if isinstance(cur, str) and cur.endswith("\u2026"):
            return isinstance(full, str) and full.startswith(cur[:-1])
        if isinstance(cur, dict):
            return isinstance(full, dict) and all(k in full and _value_matches_truncated(v, full[k]) for k, v in cur.items())
        if isinstance(cur, list):
            return isinstance(full, list) and len(cur) == len(full) and all(_value_matches_truncated(a, b) for a, b in zip(cur, full))
        if isinstance(cur, bool) or isinstance(full, bool):
            return type(cur) is bool and type(full) is bool and cur == full
        return cur == full

    def _read_pretool_doc(path_obj):
        try:
            doc = json.loads(path_obj.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(doc, dict) or not isinstance(doc.get("args"), dict):
            return None
        return doc

    def _try_hydrate_from_pretool_dir(scid, sidx, tname, cur_params):
        if not pretool_dir.is_dir():
            return None
        if type(sidx) is int:
            step_path = pretool_dir / f"step_{sidx}.json"
            if step_path.is_file():
                doc = _read_pretool_doc(step_path)
                if doc and doc.get("name") == tname:
                    dcid = str(doc.get("conversationId") or "")
                    if (not dcid or not scid or dcid == scid) and _value_matches_truncated(cur_params, doc["args"]):
                        hydrated_by_step[(scid, sidx)] = doc["args"]
                        return doc["args"]
        for cand in sorted(pretool_dir.glob("seq_*.json")):
            doc = _read_pretool_doc(cand)
            if not doc or doc.get("name") != tname:
                continue
            dcid = str(doc.get("conversationId") or "")
            if dcid and scid and dcid != scid:
                continue
            dsidx = doc.get("stepIdx")
            if type(dsidx) is int and type(sidx) is int and dsidx != sidx:
                continue
            if _value_matches_truncated(cur_params, doc["args"]):
                try:
                    cand.unlink()
                except OSError:
                    pass
                if type(sidx) is int:
                    hydrated_by_step[(scid, sidx)] = doc["args"]
                return doc["args"]
        return None

    def hydrate_mcp_tool_params(scid, sidx, tname, cur_params):
        if type(sidx) is int and (scid, sidx) in hydrated_by_step:
            return hydrated_by_step[(scid, sidx)]
        found = _try_hydrate_from_pretool_dir(scid, sidx, tname, cur_params)
        if found is not None:
            return found
        if not _has_truncated_string(cur_params):
            return cur_params
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            time.sleep(0.01)
            found = _try_hydrate_from_pretool_dir(scid, sidx, tname, cur_params)
            if found is not None:
                return found
        return cur_params

    def read_out():
        global conv_id, child, turn_in_flight, interrupted_flag, pending_interrupt_cmd, seen_max_step_idx
        try:
            for raw_ln in proc.stdout:
                raw_ln = raw_ln.strip()
                if not raw_ln:
                    continue
                try:
                    parsed = json.loads(raw_ln)
                except Exception:
                    continue
                if isinstance(parsed, dict) and parsed.get("event") == "init":
                    cid = parsed.get("conversation_id")
                    if isinstance(cid, str) and cid and not conv_id:
                        conv_id = cid
                    ev.set()
                if isinstance(parsed, dict) and parsed.get("event") == "step_update":
                    step = parsed.get("step_update")
                    if isinstance(step, dict) and type(step.get("step_index")) is int:
                        seen_max_step_idx = max(seen_max_step_idx, int(step["step_index"]))
                    if isinstance(step, dict) and step.get("step_type") == "tool":
                        tinfo = step.get("tool_info")
                        if isinstance(tinfo, dict):
                            tname = str(tinfo.get("name") or step.get("tool_name") or "")
                            if tname.startswith("mcp_ocbridge_"):
                                sidx = step.get("step_index")
                                scid = str(step.get("conversation_id") or conv_id or "")
                                cur_params = tinfo.get("parameters") if isinstance(tinfo.get("parameters"), dict) else {}
                                hydrated = hydrate_mcp_tool_params(scid, sidx, tname, cur_params)
                                if isinstance(hydrated, dict):
                                    tinfo["parameters"] = hydrated
                with state_lock:
                    tseq = active_turn_seq
                    if isinstance(parsed, dict) and parsed.get("event") == "result":
                        turn_in_flight = False
                emit({"ev": "cli", "turnSeq": tseq, "resumed": is_resumed, "baselineStepIndex": launch_baseline, "raw": parsed})
        finally:
            rc = proc.wait()
            ev.set()
            reader_done.set()
            with state_lock:
                was_active = turn_in_flight
                tseq = active_turn_seq
                was_int = interrupted_flag
                int_cmd = pending_interrupt_cmd
                if child is proc:
                    child = None
                turn_in_flight = False
                interrupted_flag = False
                pending_interrupt_cmd = None
            if int_cmd:
                emit({"ev": "interrupt_ack", "commandId": int_cmd})
            if was_active:
                if was_int:
                    emit({"ev": "host_turn_interrupted", "sessionId": conv_id, "turnSeq": tseq})
                else:
                    emit({"ev": "host_turn_error", "sessionId": conv_id, "turnSeq": tseq, "code": rc, "stderr": "\n".join(stderr_tail)})

    threading.Thread(target=read_err, daemon=True).start()
    threading.Thread(target=read_out, daemon=True).start()
    ev.wait(timeout=30.0)
    return proc

def terminate_child(cmd_id):
    global interrupted_flag, pending_interrupt_cmd
    with state_lock:
        proc = child
        if proc is None or proc.poll() is not None:
            interrupted_flag = False
            pending_interrupt_cmd = None
            emit({"ev": "interrupt_ack", "commandId": cmd_id})
            return
        interrupted_flag = True
        pending_interrupt_cmd = cmd_id
    try:
        proc.send_signal(signal.SIGINT)
    except Exception:
        pass
    try:
        proc.wait(timeout=3.0)
    except subprocess.TimeoutExpired:
        try:
            proc.terminate()
            proc.wait(timeout=1.5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

def stdin_reader():
    try:
        for raw_ln in sys.stdin:
            raw_ln = raw_ln.strip()
            if not raw_ln:
                continue
            cmd = json.loads(raw_ln)
            if isinstance(cmd, dict) and cmd.get("op") == "interrupt":
                terminate_child(str(cmd.get("commandId") or ""))
            else:
                cmd_queue.put(cmd)
    finally:
        cmd_queue.put(None)

threading.Thread(target=stdin_reader, daemon=True).start()

while True:
    cmd = cmd_queue.get()
    if cmd is None:
        stop_child_gracefully()
        break
    op = cmd.get("op")
    if op == "init":
        init_eff = str(cmd.get("effort") or cfg.get("effort") or "").strip()
        if conv_id:
            emit({"ev": "host_ready", "sessionId": conv_id, "model": resolve_cli_model(cfg["model"], init_eff)})
        elif child is None:
            spawn_cli("", init_eff)
    elif op == "resume":
        sid = str(cmd.get("sessionId") or "").strip()
        res_eff = str(cmd.get("effort") or cfg.get("effort") or "").strip()
        if sid and sid != "new":
            conv_id = sid
            emit({"ev": "host_ready", "sessionId": conv_id, "model": resolve_cli_model(cfg["model"], res_eff)})
        elif child is None:
            spawn_cli("", res_eff)
    elif op == "turn":
        prompt = str(cmd.get("prompt") or "")
        if not cmd.get("hasInstructions") and cfg.get("systemPrompt") and not applied_launch_system_prompt:
            prompt = "<openclaude_platform_context>\n" + str(cfg["systemPrompt"]) + "\n</openclaude_platform_context>\n\n" + prompt
            applied_launch_system_prompt = True
        elif cmd.get("hasInstructions"):
            applied_launch_system_prompt = True
        tseq = int(cmd.get("turnSeq") or 1)
        desired_eff = str(cmd.get("effort") or cfg.get("effort") or "").strip()
        desired_model = resolve_cli_model(cfg["model"], desired_eff)
        with state_lock:
            proc = child
            same_model = (proc is not None and proc.poll() is None and current_child_model == desired_model)
        if proc is not None and proc.poll() is None and not same_model:
            stop_child_gracefully()
            proc = None
        with state_lock:
            active_turn_seq = tseq
            turn_in_flight = True
            interrupted_flag = False
            proc = child
        if proc is None or proc.poll() is not None:
            proc = spawn_cli(conv_id, desired_eff)
        try:
            proc.stdin.write(json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False, separators=(",", ":")) + "\n")
            proc.stdin.flush()
        except Exception as exc:
            with state_lock:
                turn_in_flight = False
            emit({"ev": "host_turn_error", "sessionId": conv_id, "turnSeq": tseq, "code": -1, "stderr": str(exc)})
"""

_PROBE_HELPER_PY = r"""#!/usr/bin/env python3
import json, os, pathlib, re, shutil, subprocess, sys, tempfile

cli_path = sys.argv[1]
qemu_path = sys.argv[2] if len(sys.argv) > 2 else ""
acct_home = sys.argv[3] if len(sys.argv) > 3 else ""

def is_elf(p):
    try:
        with open(p, "rb") as f:
            return f.read(4) == b"\x7fELF"
    except Exception:
        return False

runner = [cli_path]
if is_elf(cli_path):
    if qemu_path and pathlib.Path(qemu_path).is_file():
        runner = [qemu_path, "-cpu", "max", cli_path]
    else:
        try:
            cpuinfo = pathlib.Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore")
        except Exception:
            cpuinfo = ""
        if "pclmulqdq" not in cpuinfo:
            cand = pathlib.Path(cli_path).resolve().parent.parent / "lib" / "antigravity-compat" / "usr" / "bin" / "qemu-x86_64-static"
            if cand.is_file():
                runner = [str(cand), "-cpu", "max", cli_path]

auth_present = False
account_observed = False
email = ""
plan_type = ""
tok_src = None
if acct_home:
    ah = pathlib.Path(acct_home)
    for c in (
        ah / ".gemini" / "antigravity-cli" / "antigravity-oauth-token",
        ah / "antigravity-cli" / "antigravity-oauth-token",
        ah / "antigravity-oauth-token",
        ah / ".gemini" / "antigravity-cli" / "auth.json",
    ):
        if c.is_file():
            tok_src = c
            try:
                raw_tok = json.loads(c.read_text(encoding="utf-8"))
                if isinstance(raw_tok, dict):
                    has_tok = bool(raw_tok.get("access_token") or raw_tok.get("token") or raw_tok.get("refresh_token"))
                    auth_present = has_tok or len(raw_tok) > 0
                    email = str(raw_tok.get("email") or "").strip()
                    plan_type = str(raw_tok.get("tier") or raw_tok.get("plan_type") or raw_tok.get("plan") or raw_tok.get("auth_method") or "").strip()
                    account_observed = bool(email) or auth_present
            except Exception:
                pass
            break

env = os.environ.copy()
with tempfile.TemporaryDirectory(prefix="oc-agy-probe-") as td:
    h = pathlib.Path(td)
    if tok_src is not None:
        cli_d = h / ".gemini" / "antigravity-cli"
        cli_d.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copy2(tok_src, cli_d / "antigravity-oauth-token")
    env["HOME"] = str(h)
    env["XDG_CACHE_HOME"] = str(h / "cache")
    ver_res = subprocess.run(runner + ["--version"], capture_output=True, text=True, timeout=20, env=env, check=False)
    ver_line = ((ver_res.stdout or "") + "\n" + (ver_res.stderr or "")).strip().splitlines()[0] if (ver_res.stdout or ver_res.stderr) else ""
    mod_res = subprocess.run(runner + ["models"], capture_output=True, text=True, timeout=20, env=env, check=False)
    mod_text = (mod_res.stdout or "") + "\n" + (mod_res.stderr or "")
    models_out = []
    json_parsed = None
    for ln in mod_res.stdout.splitlines():
        ln_s = ln.strip()
        if ln_s.startswith("{"):
            try:
                obj = json.loads(ln_s)
                if isinstance(obj, dict) and isinstance(obj.get("models"), list):
                    json_parsed = obj
                    break
            except Exception:
                pass
    if json_parsed is not None:
        models_out = json_parsed["models"]
        if isinstance(json_parsed.get("account"), dict):
            acct = json_parsed["account"]
            email = str(acct.get("email") or email)
            plan_type = str(acct.get("plan") or acct.get("tier") or plan_type)
            auth_present = auth_present or bool(acct.get("email") or acct.get("authPresent", True))
            account_observed = account_observed or bool(acct.get("email"))
    else:
        seen = set()
        for m in re.finditer(r"\b((?:gemini|claude|gpt|kimi|minimax|glm|qwen)-[a-z0-9][a-z0-9._-]{1,62})\b", mod_text.lower()):
            mid = m.group(1)
            if mid not in seen:
                seen.add(mid)
                models_out.append({"id": mid})
        if ver_res.returncode == 0 and not models_out:
            models_out = [{"id": "gemini-4-carbon"}, {"id": "gemini-4-hydrogen"}]
    out = {
        "version": ver_line or "1.5.5",
        "authPresent": auth_present,
        "accountObserved": account_observed,
        "email": email,
        "planType": plan_type,
        "models": models_out,
        "modelsRc": mod_res.returncode,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    if ver_res.returncode != 0:
        sys.exit(ver_res.returncode or 1)
"""


def _mask_email(email: str) -> str:
    email = email.strip()
    if "@" not in email:
        return email[:2] + "***" if len(email) > 2 else "***"
    local, domain = email.split("@", 1)
    head = local[:2] if len(local) >= 2 else local[:1]
    return f"{head}***@{domain}"


def usage_policy() -> Dict[str, Any]:
    return {
        "semanticsId": SEMANTICS_ID,
        "mode": "per_turn",
        "inputField": "input_tokens",
        "outputField": "output_tokens",
        "cacheReadField": "cache_read_tokens",
        "inputIncludesCacheRead": False,
        "outputIncludesReasoning": True,
        "allowCacheWrite": False,
    }


def _policy_hash(native_tools_flag: str = "") -> str:
    return remote_canonical_sha256(
        {
            "driverId": DRIVER_ID,
            "driverVersion": DRIVER_VERSION,
            "agentName": "ocremote",
            "nativeTools": native_tools_flag,
            "ocbridgeOnly": native_tools_flag == "",
            "excludeDefaultComponents": native_tools_flag == "",
            "hostSha256": remote_canonical_sha256(_AGY_HOST_PY),
            "denyHookSha256": remote_canonical_sha256(_DENY_NATIVE_PY),
        }
    )


def _normalize_effort(raw_effort: Any) -> str:
    if raw_effort is None or raw_effort == "":
        return ""
    need(isinstance(raw_effort, str), "AGY_EFFORT_INVALID")
    eff = raw_effort.strip().lower()
    if not eff:
        return ""
    need(eff in VALID_EFFORTS, "AGY_EFFORT_INVALID")
    return eff


def launch_spec(context: Dict[str, Any], verified_probe: Dict[str, Any]) -> Dict[str, Any]:
    need(isinstance(context, dict) and isinstance(verified_probe, dict), "AGY_LAUNCH_CONTEXT_INVALID")
    root = Path(context["root"]).resolve()
    model = context.get("model")
    probed_models = {
        m["upstreamModelId"]: m
        for m in (verified_probe.get("models") or [])
        if isinstance(m, dict) and isinstance(m.get("upstreamModelId"), str)
    }
    need(isinstance(model, str) and model in probed_models, "AGY_MODEL_NOT_OBSERVED")

    cli_path = str(context.get("cliPath") or "/home/box/.local/bin/agy").strip()
    need(cli_path.startswith("/"), "AGY_CLI_PATH_INVALID")
    qemu_path = str(context.get("qemuPath") or "").strip()
    account_home = str(context.get("accountHome") or "").strip()
    system_prompt = str(context.get("systemPrompt") or "")

    mcp_client_path = str(Path(context["mcpClientPath"]).resolve())
    tools_obj = context.get("tools")
    need(
        isinstance(tools_obj, dict)
        and isinstance(tools_obj.get("tools"), list)
        and 1 <= len(tools_obj["tools"]) <= 128,
        "AGY_TOOLS_CATALOG_INVALID",
    )
    tool_names = [
        str(t["name"])
        for t in tools_obj["tools"]
        if isinstance(t, dict) and isinstance(t.get("name"), str) and TOOL_ALIAS_RE.fullmatch(str(t["name"]))
    ]
    need(len(tool_names) >= 1, "AGY_TOOLS_CATALOG_INVALID")

    fault_tokens: List[str] = []
    if str(root).startswith("/tmp/oc-drvtest-"):
        if context.get("testFaultDropAgentLockdown"):
            fault_tokens.append("drop_agent")
        if isinstance(context.get("testFaultAllowNativeTools"), list) and context["testFaultAllowNativeTools"]:
            fault_tokens.extend(str(x) for x in context["testFaultAllowNativeTools"])
        if isinstance(context.get("testFaultEnableFeatures"), list) and context["testFaultEnableFeatures"]:
            fault_tokens.extend(str(x) for x in context["testFaultEnableFeatures"])
    native_tools_flag = ",".join(fault_tokens)

    effort = _normalize_effort(context.get("effort") if context.get("effort") is not None else context.get("reasoningEffort"))

    existing_session = context.get("nativeSessionId")
    initial_session_id = ""
    if isinstance(existing_session, str) and existing_session and existing_session != "new":
        need(IDENT_RE.fullmatch(existing_session), "AGY_SESSION_ID_INVALID")
        initial_session_id = existing_session

    eager_tools = {name: {"eager": True} for name in tool_names}
    mcp_config = {
        "mcpServers": {
            "ocbridge": {
                "command": "/usr/bin/python3",
                "args": ["-I", "-B", mcp_client_path, str(root)],
                "timeout": 3600,
                "tools": eager_tools,
            }
        }
    }

    agent_tools_yaml = json.dumps(list(fault_tokens)) if native_tools_flag else "[]"
    exclude_line = "excludeDefaultComponents: true\n" if not native_tools_flag else ""
    agent_body = (
        f"{system_prompt.strip()}\n\n" if system_prompt.strip() else ""
    ) + "Use only the configured ocbridge MCP tools (`mcp_ocbridge_*`). Native host tools are forbidden.\n"
    agent_md = (
        "---\n"
        "name: ocremote\n"
        "description: OpenClaude remote brain\n"
        f"{exclude_line}"
        f"tools: {agent_tools_yaml}\n"
        "---\n"
        f"{agent_body}"
    )

    hooks_obj: Dict[str, Any] = {}
    if not native_tools_flag:
        hooks_obj["ocremote-deny-native"] = {
            "PreToolUse": [
                {
                    "matcher": ".*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"/usr/bin/python3 -I -B {str(root / 'deny_native.py')}",
                            "timeout": 5,
                        }
                    ],
                }
            ]
        }

    host_cfg = {
        "cliPath": cli_path,
        "qemuPath": qemu_path,
        "accountHome": account_home,
        "model": model,
        "probedModels": sorted(probed_models.keys()),
        "effort": effort,
        "systemPrompt": system_prompt,
        "initialSessionId": initial_session_id,
        "nativeToolsFlag": native_tools_flag,
    }

    files: Dict[str, Dict[str, Any]] = {
        "home/.gemini/config/mcp_config.json": {"content": json.dumps(mcp_config, separators=(",", ":")), "mode": 0o400},
        "home/.gemini/config/hooks.json": {"content": json.dumps(hooks_obj, separators=(",", ":")), "mode": 0o400},
        "home/.gemini/antigravity-cli/agents/ocremote.md": {"content": agent_md, "mode": 0o400},
        "home/.gemini/antigravity-cli/settings.json": {"content": "{}\n", "mode": 0o600},
        "deny_native.py": {"content": _DENY_NATIVE_PY, "mode": 0o400},
        "host_config.json": {"content": json.dumps(host_cfg, separators=(",", ":")), "mode": 0o400},
        "agy_host.py": {"content": _AGY_HOST_PY, "mode": 0o400},
    }

    return {
        "argv": ["/usr/bin/python3", "-I", "-B", str(root / "agy_host.py")],
        "environment": {
            "HOME": str(root / "home"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "TMPDIR": str(root / "tmp"),
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "AGY_CLI_DISABLE_AUTO_UPDATE": "true",
            "GOMAXPROCS": "4",
        },
        "cwd": str(root / "cwd"),
        "policySha256": _policy_hash(native_tools_flag),
        "files": files,
        "dirs": [
            "run",
            "run/pretool",
            "cache",
            "tmp",
            "home/.gemini/config",
            "home/.gemini/antigravity-cli/agents",
            "home/.gemini/antigravity-cli/conversations",
        ],
        "artifactDigests": {cli_path: str(verified_probe["cliSha256"])},
    }


def _reset_turn_counters(state: Dict[str, Any], turn_seq: int, cmd_id: str) -> None:
    state["activeTurn"] = True
    state["activeTurnSeq"] = turn_seq
    state["activeTurnCommandId"] = cmd_id
    state["firstOwnStepIndex"] = None
    state["turnInput"] = 0
    state["turnOutput"] = 0
    state["turnCacheRead"] = 0
    state["turnSawUsage"] = False
    state["seenUsageSteps"] = []
    state["observedToolCalls"] = []
    state["preludeError"] = None
    state["trailingError"] = None
    state["terminalEmittedForSeq"] = None


def encode(command: Dict[str, Any], native_state: Dict[str, Any]) -> Dict[str, Any]:
    kind = command.get("kind")
    cmd_id = command.get("commandId")
    need(isinstance(cmd_id, str) and IDENT_RE.fullmatch(cmd_id), "AGY_COMMAND_ID_INVALID")
    state = dict(native_state)
    lines: List[str] = []
    immediate: List[Dict[str, Any]] = []

    if kind == "initialize":
        if isinstance(command.get("instructions"), str) and command["instructions"]:
            state["pendingInstructionsHash"] = remote_canonical_sha256(command["instructions"])
        eff = _normalize_effort(command.get("effort"))
        if eff:
            state["defaultEffort"] = eff
        if state.get("initialized") is True and isinstance(state.get("sessionId"), str):
            immediate.append(
                {
                    "commandId": cmd_id,
                    "commandKind": "initialize",
                    "ok": True,
                    "nativeSessionId": state["sessionId"],
                    "upstreamModel": state.get("observedModel") or command.get("model"),
                }
            )
        else:
            state["pendingInitCommandId"] = cmd_id
            state["expectedModel"] = command.get("model") or state.get("expectedModel")
            payload: Dict[str, Any] = {"op": "init"}
            if eff or state.get("defaultEffort"):
                payload["effort"] = eff or state["defaultEffort"]
            lines.append(json.dumps(payload, separators=(",", ":")))

    elif kind == "resume":
        target = command.get("nativeSessionId")
        need(isinstance(target, str) and (target == "new" or IDENT_RE.fullmatch(target)), "AGY_RESUME_ID_INVALID")
        if isinstance(command.get("instructions"), str) and command["instructions"]:
            state["pendingInstructionsHash"] = remote_canonical_sha256(command["instructions"])
        eff = _normalize_effort(command.get("effort"))
        if eff:
            state["defaultEffort"] = eff
        if state.get("sessionId"):
            need(target in ("new", state["sessionId"]), "AGY_SESSION_MISMATCH")
            immediate.append(
                {
                    "commandId": cmd_id,
                    "commandKind": "resume",
                    "ok": True,
                    "nativeSessionId": state["sessionId"],
                    "upstreamModel": state.get("observedModel") or command.get("model"),
                }
            )
        else:
            if target != "new":
                state["expectedSessionId"] = target
            state["pendingResumeCommandId"] = cmd_id
            payload = {"op": "resume", "sessionId": target}
            if eff or state.get("defaultEffort"):
                payload["effort"] = eff or state["defaultEffort"]
            lines.append(json.dumps(payload, separators=(",", ":")))

    elif kind == "newTurn":
        prompt = command.get("prompt")
        need(isinstance(prompt, str) and len(prompt.strip()) > 0, "AGY_EMPTY_PROMPT")
        need(not state.get("activeTurn"), "AGY_TURN_ALREADY_ACTIVE")
        turn_seq = int(state.get("turnSeq") or 0) + 1
        state["turnSeq"] = turn_seq
        _reset_turn_counters(state, turn_seq, cmd_id)

        eff = _normalize_effort(command.get("effort")) or str(state.get("defaultEffort") or "")
        inst = command.get("instructions")
        wire_prompt = prompt
        has_instructions = False
        if isinstance(inst, str) and inst:
            has_instructions = True
            inst_hash = remote_canonical_sha256(inst)
            if state.get("loadedInstructionsHash") != inst_hash:
                wire_prompt = f"<openclaude_platform_context>\n{inst}\n</openclaude_platform_context>\n\n{prompt}"
                state["loadedInstructionsHash"] = inst_hash
            state.pop("pendingInstructionsHash", None)
        elif isinstance(state.get("pendingInstructionsHash"), str) and state.get("loadedInstructionsHash") != state.get("pendingInstructionsHash"):
            # launch_spec wrote host_config.json["systemPrompt"]; mark loaded once host consumes it on turn 1.
            state["loadedInstructionsHash"] = state.pop("pendingInstructionsHash")

        turn_payload: Dict[str, Any] = {
            "op": "turn",
            "prompt": wire_prompt,
            "turnSeq": turn_seq,
            "hasInstructions": has_instructions,
        }
        if eff:
            turn_payload["effort"] = eff
            state["lastEffort"] = eff
        lines.append(json.dumps(turn_payload, ensure_ascii=False, separators=(",", ":")))
        immediate.append(
            {
                "commandId": cmd_id,
                "commandKind": "newTurn",
                "ok": True,
                "nativeSessionId": state.get("sessionId"),
            }
        )

    elif kind == "interrupt":
        state["pendingInterruptCommandId"] = cmd_id
        lines.append(json.dumps({"op": "interrupt", "commandId": cmd_id}, separators=(",", ":")))

    elif kind == "readState":
        immediate.append(
            {
                "commandId": cmd_id,
                "commandKind": "readState",
                "ok": True,
                "nativeSessionId": state.get("sessionId"),
            }
        )
    else:
        raise ValueError("AGY_UNKNOWN_COMMAND")

    return {"lines": lines, "nextNativeState": state, "immediateControlReplies": immediate}


def _extract_mcp_call_id(meta: Any, sess_id: str, rpc_id: Any) -> str:
    need(isinstance(meta, dict), "AGY_MCP_META_MISSING")
    conv_id = meta.get("antigravity.google/conversation_id")
    prog = meta.get("progressToken")
    need(isinstance(conv_id, str) and conv_id == sess_id, "AGY_MCP_CONVERSATION_MISMATCH")
    need(isinstance(prog, str) and ":" in prog, "AGY_MCP_PROGRESS_INVALID")
    prog_prefix, step_suffix = prog.rsplit(":", 1)
    need(IDENT_RE.fullmatch(prog_prefix) and step_suffix.isdigit(), "AGY_MCP_STEP_INVALID")
    call_id = f"agy_{sess_id.replace('-', '')[:12]}_{step_suffix}"
    need(IDENT_RE.fullmatch(call_id) and call_id != rpc_id, "AGY_MCP_CALL_ID_INVALID")
    return call_id


def _strip_effort_suffix(model_id: str) -> str:
    m = re.match(r"^(.+)-(low|medium|high|xhigh|max)$", model_id.strip().lower())
    return m.group(1) if m else model_id.strip().lower()


def _models_compatible(observed: str, expected: str) -> bool:
    return _strip_effort_suffix(observed) == _strip_effort_suffix(expected)


def _bind_session_id(state: Dict[str, Any], cid: str) -> None:
    need(isinstance(cid, str) and IDENT_RE.fullmatch(cid), "AGY_INVALID_SESSION_ID")
    if state.get("expectedSessionId"):
        need(cid == state["expectedSessionId"], "AGY_SESSION_ID_MISMATCH")
    if state.get("sessionId"):
        need(cid == state["sessionId"], "AGY_SESSION_ID_CHANGED")
    state["sessionId"] = cid


def _flush_init_replies(state: Dict[str, Any], replies: List[Dict[str, Any]]) -> None:
    sess = state.get("sessionId")
    if not sess:
        return
    if state.get("pendingInitCommandId"):
        replies.append(
            {
                "commandId": state.pop("pendingInitCommandId"),
                "commandKind": "initialize",
                "ok": True,
                "nativeSessionId": sess,
                "upstreamModel": state.get("observedModel"),
            }
        )
    if state.get("pendingResumeCommandId"):
        replies.append(
            {
                "commandId": state.pop("pendingResumeCommandId"),
                "commandKind": "resume",
                "ok": True,
                "nativeSessionId": sess,
                "upstreamModel": state.get("observedModel"),
            }
        )


def _turn_terminal_id(state: Dict[str, Any], sess_id: str, tseq: int) -> str:
    cmd_id = state.get("activeTurnCommandId")
    if isinstance(cmd_id, str) and IDENT_RE.fullmatch(cmd_id):
        return cmd_id
    return f"turn_{str(sess_id).replace('-', '')[:12]}_{tseq}"


def decode(channel: str, raw_frame: bytes, native_state: Dict[str, Any]) -> Dict[str, Any]:
    state = dict(native_state)
    frame = strict_json(raw_frame)
    need(isinstance(frame, dict), "AGY_FRAME_NOT_OBJECT")

    if channel == "fixed_mcp":
        rpc_id = frame.get("id")
        need(frame.get("method") == "tools/call" and isinstance(rpc_id, (str, int)) and not isinstance(rpc_id, bool), "AGY_MCP_INVALID")
        params = frame.get("params")
        need(isinstance(params, dict), "AGY_MCP_PARAMS_INVALID")
        sess_id = state.get("sessionId")
        need(isinstance(sess_id, str) and IDENT_RE.fullmatch(sess_id), "AGY_MCP_MISSING_SESSION")
        name = params.get("name")
        args = params.get("arguments")
        need(isinstance(name, str) and TOOL_ALIAS_RE.fullmatch(name) and type(args) is dict, "AGY_MCP_ARGS_INVALID")
        call_id = _extract_mcp_call_id(params.get("_meta"), sess_id, rpc_id)
        return {
            "securityEvents": [],
            "presentation": [],
            "controlReplies": [],
            "pendingToolRequest": {
                "rpcId": rpc_id,
                "callId": call_id,
                "nativeSessionId": sess_id,
                "server": "ocbridge",
                "name": name,
                "arguments": args,
                "argsHash": remote_canonical_sha256(args),
            },
            "nextNativeState": state,
        }

    need(channel == "native", "AGY_UNSUPPORTED_DECODE_CHANNEL")
    security_events: List[Dict[str, Any]] = []
    presentation: List[Dict[str, Any]] = []
    control_replies: List[Dict[str, Any]] = []

    ev = frame.get("ev")
    if ev == "host_ready":
        _bind_session_id(state, str(frame.get("sessionId") or ""))
        if isinstance(frame.get("model"), str) and frame["model"]:
            if state.get("expectedModel"):
                need(_models_compatible(frame["model"], str(state["expectedModel"])), "AGY_MODEL_MISMATCH")
            state["observedModel"] = frame["model"]
        state["initialized"] = True
        _flush_init_replies(state, control_replies)
        return {"securityEvents": security_events, "presentation": presentation, "controlReplies": control_replies, "nextNativeState": state}

    if ev == "interrupt_ack":
        cid = frame.get("commandId")
        if isinstance(cid, str) and cid == state.get("pendingInterruptCommandId"):
            state.pop("pendingInterruptCommandId", None)
            control_replies.append({"commandId": cid, "commandKind": "interrupt", "ok": True})
        return {"securityEvents": security_events, "presentation": presentation, "controlReplies": control_replies, "nextNativeState": state}

    if ev in ("host_turn_interrupted", "host_turn_error"):
        tseq = int(frame.get("turnSeq") or state.get("activeTurnSeq") or 1)
        if state.get("terminalEmittedForSeq") != tseq and state.get("activeTurn"):
            sess_id = state.get("sessionId") or "unknown"
            term_id = _turn_terminal_id(state, str(sess_id), tseq)
            state["activeTurn"] = False
            state["terminalEmittedForSeq"] = tseq
            status = "interrupted" if ev == "host_turn_interrupted" else "error"
            security_events.append(
                {
                    "kind": "usage",
                    "sampleId": term_id,
                    "scopeId": term_id,
                    "semanticsId": SEMANTICS_ID,
                    "rawCounters": {
                        "input_tokens": int(state.get("turnInput") or 0),
                        "output_tokens": int(state.get("turnOutput") or 0),
                        "cache_read_tokens": int(state.get("turnCacheRead") or 0),
                    },
                }
            )
            term_ev: Dict[str, Any] = {"kind": "turnTerminal", "terminalId": term_id, "status": status}
            if status == "error":
                term_ev["errorCode"] = "AGY_HOST_ERROR"
            security_events.append(term_ev)
        return {"securityEvents": security_events, "presentation": presentation, "controlReplies": control_replies, "nextNativeState": state}

    need(ev == "cli" and isinstance(frame.get("raw"), dict), "AGY_UNKNOWN_HOST_FRAME")
    raw = frame["raw"]
    raw_ev = raw.get("event")

    if raw_ev == "init":
        _bind_session_id(state, str(raw.get("conversation_id") or ""))
        init_obj = raw.get("init") if isinstance(raw.get("init"), dict) else {}
        model = init_obj.get("model") or raw.get("model")
        if isinstance(model, str) and model:
            if state.get("expectedModel"):
                need(_models_compatible(model, str(state["expectedModel"])), "AGY_MODEL_MISMATCH")
            state["observedModel"] = model
        state["initialized"] = True
        _flush_init_replies(state, control_replies)

    elif raw_ev == "step_update":
        step = raw.get("step_update")
        need(isinstance(step, dict), "AGY_STEP_INVALID")
        scid = step.get("conversation_id")
        if isinstance(scid, str) and scid and state.get("sessionId"):
            need(scid == state["sessionId"], "AGY_STEP_CONVERSATION_MISMATCH")
        stype = step.get("step_type")
        sstate = str(step.get("state") or "")
        sidx = step.get("step_index")
        baseline_idx = frame.get("baselineStepIndex")
        is_resumed = bool(frame.get("resumed"))
        if is_resumed and type(baseline_idx) is int and baseline_idx >= 0 and type(sidx) is int and sidx <= baseline_idx:
            if stype == "error_message":
                err = step.get("error")
                msg = err.get("message") if isinstance(err, dict) else err
                state["preludeError"] = str(msg or "AGY_PRELUDE_ERROR")
            return {"securityEvents": security_events, "presentation": presentation, "controlReplies": control_replies, "nextNativeState": state}
        if stype == "user_input" and state.get("firstOwnStepIndex") is None and type(sidx) is int:
            state["firstOwnStepIndex"] = sidx
        first_own = state.get("firstOwnStepIndex")
        if is_resumed and first_own is None and stype != "user_input" and (type(baseline_idx) is not int or baseline_idx < 0):
            if stype == "error_message":
                err = step.get("error")
                msg = err.get("message") if isinstance(err, dict) else err
                state["preludeError"] = str(msg or "AGY_PRELUDE_ERROR")
            return {"securityEvents": security_events, "presentation": presentation, "controlReplies": control_replies, "nextNativeState": state}
        if first_own is not None and type(sidx) is int and sidx < first_own:
            return {"securityEvents": security_events, "presentation": presentation, "controlReplies": control_replies, "nextNativeState": state}

        if stype == "agent_response":
            txt_out = step.get("text_delta")
            if isinstance(txt_out, str) and txt_out:
                state["trailingError"] = None
                security_events.append({"kind": "textDelta", "channel": "answer", "delta": txt_out})
                presentation.append({"kind": "text_delta", "text": txt_out})
            usage = step.get("usage")
            seen_steps = list(state.get("seenUsageSteps") or [])
            if sstate == "DONE" and isinstance(usage, dict) and sidx not in seen_steps:
                inp = usage.get("input_tokens")
                out = usage.get("output_tokens")
                cread = usage.get("cache_read_tokens", 0)
                think = usage.get("thinking_tokens", 0)
                for val in (inp, out, cread, think):
                    need(type(val) is int and val >= 0, "AGY_USAGE_INVALID")
                state["turnInput"] = int(state.get("turnInput") or 0) + inp
                state["turnOutput"] = int(state.get("turnOutput") or 0) + max(out, think)
                state["turnCacheRead"] = int(state.get("turnCacheRead") or 0) + cread
                state["turnSawUsage"] = True
                seen_steps.append(sidx)
                state["seenUsageSteps"] = seen_steps

        elif stype == "tool":
            state["trailingError"] = None
            tinfo = step.get("tool_info") if isinstance(step.get("tool_info"), dict) else {}
            tname = str(tinfo.get("name") or step.get("tool_name") or "")
            if tname == "exit_plan_mode":
                pass
            elif not tname.startswith("mcp_ocbridge_"):
                security_events.append(
                    {"kind": "disallowedItem", "reason": "non_ocbridge_tool_call", "itemType": tname[:120] or "native_tool"}
                )
            else:
                alias = tname[len("mcp_ocbridge_") :]
                params = tinfo.get("parameters") if isinstance(tinfo.get("parameters"), dict) else {}
                need(TOOL_ALIAS_RE.fullmatch(alias) and type(sidx) is int and sidx >= 0, "AGY_TOOL_STEP_INVALID")
                sess_id = state.get("sessionId")
                need(isinstance(sess_id, str) and IDENT_RE.fullmatch(sess_id), "AGY_TOOL_MISSING_SESSION")
                call_id = f"agy_{sess_id.replace('-', '')[:12]}_{sidx}"
                observed = list(state.get("observedToolCalls") or [])
                if call_id not in observed:
                    observed.append(call_id)
                    state["observedToolCalls"] = observed
                    security_events.append(
                        {
                            "kind": "toolCallObserved",
                            "callId": call_id,
                            "name": alias,
                            "argsHash": remote_canonical_sha256(params),
                            "arguments": params,
                            "phase": "started",
                        }
                    )

        elif stype == "error_message":
            err = step.get("error")
            msg = err.get("message") if isinstance(err, dict) else err
            err_text = msg if isinstance(msg, str) and msg else "AGY_ERROR_STEP"
            if first_own is None:
                state["preludeError"] = err_text
            else:
                state["trailingError"] = err_text

    elif raw_ev == "result":
        res = raw.get("result")
        need(isinstance(res, dict), "AGY_RESULT_INVALID")
        rcid = str(res.get("conversation_id") or "")
        sess_id = state.get("sessionId")
        if rcid and sess_id:
            need(rcid == sess_id, "AGY_RESULT_SESSION_MISMATCH")
        elif rcid and not sess_id:
            _bind_session_id(state, rcid)
            sess_id = rcid
        need(isinstance(sess_id, str) and IDENT_RE.fullmatch(sess_id), "AGY_RESULT_NO_SESSION")
        tseq = int(frame.get("turnSeq") or state.get("activeTurnSeq") or 1)
        term_id = _turn_terminal_id(state, sess_id, tseq)
        raw_status = str(res.get("status") or "").upper()
        err_str = str(res.get("error") or state.get("trailingError") or state.get("preludeError") or "")
        if raw_status == "SUCCESS" and state.get("trailingError"):
            status = "error"
        elif raw_status == "SUCCESS":
            status = "success"
        elif raw_status in ("CANCELED", "INTERRUPTED") or (state.get("pendingInterruptCommandId") and "interrupt" in err_str.lower()):
            status = "interrupted"
        else:
            status = "error"

        state["activeTurn"] = False
        state["terminalEmittedForSeq"] = tseq
        if status == "success":
            need(bool(state.get("turnSawUsage")), "AGY_USAGE_MISSING")
        counters = {
            "input_tokens": int(state.get("turnInput") or 0),
            "output_tokens": int(state.get("turnOutput") or 0),
            "cache_read_tokens": int(state.get("turnCacheRead") or 0),
        }
        security_events.append(
            {
                "kind": "usage",
                "sampleId": term_id,
                "scopeId": term_id,
                "semanticsId": SEMANTICS_ID,
                "rawCounters": counters,
            }
        )
        term_ev: Dict[str, Any] = {"kind": "turnTerminal", "terminalId": term_id, "status": status}
        if status == "error":
            term_ev["errorCode"] = "AGY_TURN_ERROR"
        security_events.append(term_ev)

    else:
        raise ValueError("AGY_UNKNOWN_CLI_EVENT")

    return {
        "securityEvents": security_events,
        "presentation": presentation,
        "controlReplies": control_replies,
        "nextNativeState": state,
    }


def _normalize_probed_models(raw_models: Any) -> List[Dict[str, Any]]:
    models: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_models if isinstance(raw_models, list) else []:
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or item.get("upstreamModelId") or "").strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", mid):
            continue
        variants = BASE_TO_VARIANTS.get(mid, [mid])
        for vid in variants:
            if vid in seen:
                continue
            seen.add(vid)
            spec = MODEL_SPECS.get(vid, {})
            efforts = [str(e) for e in (item.get("efforts") or spec.get("efforts") or ["low", "medium", "high"])]
            default_eff = str(spec.get("default") or ("medium" if "medium" in efforts else efforts[0]))
            models.append(
                {
                    "upstreamModelId": vid,
                    "displayName": str(item.get("displayName") or spec.get("display") or vid),
                    "supportedEfforts": efforts,
                    "defaultEffort": default_eff if default_eff in efforts else efforts[0],
                    "supportsAdaptiveThinking": True,
                    "supportsVision": not vid.startswith("gpt-oss"),
                }
            )
    return models


def probe(context: Dict[str, Any], previous_step_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    need(isinstance(context, dict), "AGY_PROBE_CONTEXT_INVALID")
    cli_path = str(context.get("cliPath") or context.get("binaryPath") or "/home/box/.local/bin/agy").strip()
    need(cli_path.startswith("/"), "AGY_CLI_PATH_INVALID")
    qemu_path = str(context.get("qemuPath") or "").strip()
    acct_home = str(context.get("accountHome") or "").strip()

    if previous_step_result is None:
        return {
            "kind": "step",
            "step": {
                "argv": ["/usr/bin/python3", "-I", "-B", "-c", _PROBE_HELPER_PY, cli_path, qemu_path, acct_home],
                "stdinLines": [],
                "environment": {"LANG": "C.UTF-8", "PATH": "/usr/local/bin:/usr/bin:/bin", "XDG_CACHE_HOME": "/tmp"},
                "timeoutSec": 25,
                "hashFiles": {"cli": cli_path},
            },
        }

    lines = previous_step_result.get("stdoutLines") or []
    parsed: Optional[Dict[str, Any]] = None
    for line in lines:
        if line.strip():
            obj = strict_json(line)
            if isinstance(obj, dict) and "version" in obj:
                parsed = obj
                break
    need(isinstance(parsed, dict) and int(previous_step_result.get("returncode", 1)) == 0, "AGY_PROBE_OUTPUT_MISSING")
    models = _normalize_probed_models(parsed.get("models"))
    need(len(models) > 0, "AGY_PROBE_MODELS_EMPTY")

    email = str(parsed.get("email") or "").strip()
    plan_raw = str(parsed.get("planType") or "").strip().lower()
    plan = "ultra" if "ultra" in plan_raw else ("pro" if "pro" in plan_raw else (plan_raw or "consumer"))
    cli_sha = str((previous_step_result.get("artifactHashes") or {}).get("cli") or "0" * 64)
    raw_sha = str(previous_step_result.get("stdoutSha256") or remote_canonical_sha256(parsed))

    snapshot: Dict[str, Any] = {
        "schemaVersion": 4,
        "engineId": ENGINE_ID,
        "driverId": DRIVER_ID,
        "driverVersion": DRIVER_VERSION,
        "source": "antigravity-cli:models",
        "freshness": "cli-observed",
        "authPresent": bool(parsed.get("authPresent", False)),
        "accountObserved": bool(parsed.get("accountObserved", False)),
        "cliVersion": str(parsed.get("version") or "1.5.5"),
        "cliSha256": cli_sha,
        "models": models,
        "rawResponseSha256": raw_sha,
        "observedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    if email:
        snapshot["accountHint"] = _mask_email(email)
    if plan:
        snapshot["planType"] = plan

    return {"kind": "snapshot", "snapshot": snapshot, "policySha256": _policy_hash("")}
