#!/usr/bin/env python3
"""Offline two-process analogue of two concurrent Box Exec requests."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

SUPERVISOR = str(Path(__file__).with_name("box_supervisor.py"))
MODEL_ID = "toolu_model_289"
CHILD = r'''
import json,sys,time,pathlib
def emit(e): print(json.dumps({"type":"stream_event","event":e}),flush=True)
emit({"type":"message_start","message":{}})
emit({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})
emit({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ordinary text"}})
emit({"type":"content_block_stop","index":0})
emit({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_model_289","name":"mcp__box_stub__local_echo","input":{}}})
emit({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"value\":\"ping\"}"}})
emit({"type":"content_block_stop","index":1})
emit({"type":"message_stop"})
p=pathlib.Path(sys.argv[1]);end=time.time()+5
while time.time()<end and not p.exists():time.sleep(.02)
if not p.exists():raise SystemExit(2)
v=json.loads(p.read_text())
if v.get("toolUseId")!="toolu_model_289" or not str(v.get("text","")).startswith("local-dynamic-"):raise SystemExit(3)
print(json.dumps({"type":"result","subtype":"success","text":"confirmed:"+v["text"]}),flush=True)
'''
WRITE_RESULT = r'''
import json,os,sys
p=sys.argv[1];tmp=p+".tmp"
with open(tmp,"x",encoding="utf8") as f:
 json.dump({"toolUseId":sys.argv[2],"text":sys.argv[3]},f);f.flush();os.fsync(f.fileno())
os.replace(tmp,p)
'''


def run(wrong_id: bool) -> None:
    root = Path(tempfile.mkdtemp(prefix="ocv5-289-tool-"))
    os.chmod(root, 0o700)
    event, result = root / "event.json", root / "result.json"
    env = {**os.environ, "OCV5_SUPERVISOR_TOOL_EVENT_FILE": str(event)}
    proc = subprocess.Popen([sys.executable, SUPERVISOR, "--deadline", "7", "--",
                             sys.executable, "-c", CHILD, str(result)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        end = time.time() + 4
        while time.time() < end and not event.exists() and proc.poll() is None:
            time.sleep(.02)
        assert event.exists() and proc.poll() is None, "event not published while child alive"
        frame = json.loads(event.read_text())
        assert frame == {"modelToolUseId": MODEL_ID, "name": "mcp__box_stub__local_echo",
                         "input": {"value": "ping"}}
        result_text = "local-dynamic-" + secrets.token_hex(8)
        sender = subprocess.run([sys.executable, "-c", WRITE_RESULT, str(result),
                                 "wrong_id" if wrong_id else MODEL_ID, result_text],
                                capture_output=True, timeout=2)
        assert sender.returncode == 0 and proc.poll() is None, "second process did not finish in parallel"
        out, err = proc.communicate(timeout=4)
        success = b'confirmed:' + result_text.encode() in out
        print(json.dumps({"negative": wrong_id, "supervisorExit": proc.returncode,
                          "secondExecExit": sender.returncode, "eventComplete": True,
                          "finalSuccess": success, "stderrBytes": len(err)}))
        assert (proc.returncode != 0 and not success) if wrong_id else (proc.returncode == 0 and success)
    finally:
        if proc.poll() is None:
            proc.kill(); proc.wait()
        shutil.rmtree(root)


run(False)
run(True)

# A second tool start must fail before the first event is published, even when
# it uses a different content-block index within the same model message.
root = Path(tempfile.mkdtemp(prefix="ocv5-289-tool-")); os.chmod(root, 0o700)
event = root / "event.json"
duplicate = r'''
import json,time
def emit(e): print(json.dumps({"type":"stream_event","event":e}),flush=True)
emit({"type":"message_start","message":{}})
emit({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_a","name":"mcp__fixture__a","input":{}}})
emit({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_b","name":"mcp__fixture__b","input":{}}})
time.sleep(10)
'''
try:
    env = {**os.environ, "OCV5_SUPERVISOR_TOOL_EVENT_FILE": str(event)}
    result = subprocess.run([sys.executable, SUPERVISOR, "--deadline", "2", "--",
                             sys.executable, "-c", duplicate], capture_output=True, timeout=4, env=env)
    print(json.dumps({"duplicateExit": result.returncode, "eventPublished": event.exists()}))
    assert result.returncode == 125 and not event.exists()
finally:
    shutil.rmtree(root)

# A tool block outside a model message has no valid origin.
root = Path(tempfile.mkdtemp(prefix="ocv5-289-tool-")); os.chmod(root, 0o700)
event = root / "event.json"
no_start = json.dumps({"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
    "content_block": {"type": "tool_use", "id": "toolu_orphan", "name": "mcp__fixture__a", "input": {}}}}) + "\n"
try:
    env = {**os.environ, "OCV5_SUPERVISOR_TOOL_EVENT_FILE": str(event)}
    result = subprocess.run([sys.executable, SUPERVISOR, "--deadline", "2", "--",
                             sys.executable, "-c", "import sys;sys.stdout.write(sys.argv[1]);sys.stdout.flush()", no_start],
                            capture_output=True, timeout=4, env=env)
    print(json.dumps({"orphanExit": result.returncode, "eventPublished": event.exists()}))
    assert result.returncode == 125 and not event.exists()
finally:
    shutil.rmtree(root)
