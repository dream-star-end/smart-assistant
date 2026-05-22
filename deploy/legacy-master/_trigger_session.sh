#!/bin/bash
pip3 install -q websocket-client 2>&1 | tail -2
TOKEN=$(python3 -c "import json;c=json.load(open('/root/.openclaude/openclaude.json'));print(c.get('gateway',{}).get('accessToken',''))")

# Use curl to send a message via a quick HTTP-based approach:
# Actually just use the existing ws_smoke test approach with raw socket
python3 -c "
import socket, json, hashlib, base64, time, os, ssl

TOKEN='$TOKEN'
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(60)
sock.connect(('127.0.0.1', 18789))

# WS handshake
key = base64.b64encode(os.urandom(16)).decode()
req = (
    'GET /ws?token=' + TOKEN + ' HTTP/1.1\r\n'
    'Host: 127.0.0.1:18789\r\n'
    'Upgrade: websocket\r\n'
    'Connection: Upgrade\r\n'
    'Sec-WebSocket-Key: ' + key + '\r\n'
    'Sec-WebSocket-Version: 13\r\n\r\n'
)
sock.send(req.encode())
resp = sock.recv(4096).decode()
if '101' not in resp:
    print('WS handshake failed:', resp[:100])
    exit(1)
print('WS connected')

# Send a message (simplified WS frame)
import struct
msg = json.dumps({
    'type': 'inbound.message',
    'idempotencyKey': 'test-' + str(int(time.time())),
    'channel': 'webchat',
    'peer': {'id': 'prompt-test', 'kind': 'dm'},
    'content': {'text': '你是谁'},
    'ts': int(time.time() * 1000)
}).encode()
# WS text frame
frame = bytearray()
frame.append(0x81) # FIN + text
length = len(msg)
mask = os.urandom(4)
if length < 126:
    frame.append(0x80 | length) # masked
else:
    frame.append(0x80 | 126)
    frame.extend(struct.pack('>H', length))
frame.extend(mask)
for i, b in enumerate(msg):
    frame.append(b ^ mask[i % 4])
sock.send(bytes(frame))
print('Message sent, waiting for response...')

# Wait a bit for the session to be created
time.sleep(8)
print('Done waiting')
sock.close()
"

echo
echo "=== prompt section headers ==="
grep '^# ' /tmp/openclaude-main/extra-prompt.md 2>&1 || echo "(checking other dirs)"
ls /tmp/openclaude-*/extra-prompt.md 2>&1
for f in /tmp/openclaude-*/extra-prompt.md; do
  echo "=== $f headers ==="
  grep '^# ' "$f" 2>&1
  echo "=== first 20 lines ==="
  head -20 "$f" 2>&1
  echo "=== size ==="
  wc -c "$f" 2>&1
  break
done
