#!/usr/bin/env python3
"""Regenerate the single-file CC payload and Codex dependency hashes after resource changes."""
import base64
import hashlib
from pathlib import Path
import re
import zlib
p=Path(__file__).resolve().parent
data=(p/'remote-engine-resources.py').read_bytes()
f=p/'cc5-host-controller.py';s=f.read_text()
s=re.sub(r"^RESOURCE_MODULE_B64 = '[^']*'$",'RESOURCE_MODULE_B64 = '+repr(base64.b64encode(zlib.compress(data,9)).decode()),s,flags=re.M)
f.write_text(s)
f=p/'oc-remote-hostd.py';s=f.read_text()
s=re.sub(r"hashlib.sha256\(data\).hexdigest\(\) != '[a-f0-9]{64}'", "hashlib.sha256(data).hexdigest() != '"+hashlib.sha256(data).hexdigest()+"'",s);f.write_text(s)
f=p/'codex-host-controller.py';s=f.read_text()
s=re.sub(r"'oc-remote-hostd.py': '[a-f0-9]{64}'","'oc-remote-hostd.py': '"+hashlib.sha256((p/'oc-remote-hostd.py').read_bytes()).hexdigest()+"'",s);f.write_text(s)
