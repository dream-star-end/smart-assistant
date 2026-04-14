import os
#!/usr/bin/env python3
"""E2E vision test: upload a known image, verify agent calls understand_image
(from MiniMax MCP) and returns a meaningful description."""
import asyncio
import base64
import json
import sys
import time

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "websockets"])
    import websockets

URL = os.environ.get("WS_URL", "ws://127.0.0.1:18789/ws")
TOKEN = "43efa4d9ad09122a16820c7ff4039269600e2a000224c2d5b272d84114343d52"


# A tiny 100x60 red-green-blue gradient PNG, hand-crafted to be recognizable.
# Actually: use a public image URL is easier for this test — we can just
# reference the openclaude icon.svg served by the gateway itself. But the
# understand_image tool needs a local file path or http URL; our WebUI path
# only sends base64. So: base64 a real PNG.
#
# Use a "HELLO" text PNG? Easiest: use the red-square PNG we used earlier.
# 16x16 solid red PNG:
RED_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR4AWP4TwVg"
    "GDX4v8P/AQAAAP//AwD6gf/5CkHJCwAAAABJRU5ErkJggg=="
)


async def main():
    full = f"{URL}?token={TOKEN}"
    peer_id = f"smoke-vision-{int(time.time())}"
    async with websockets.connect(full, open_timeout=20, ping_interval=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "inbound.message",
                    "idempotencyKey": f"v-{int(time.time() * 1000)}",
                    "channel": "webchat",
                    "peer": {"id": peer_id, "kind": "dm"},
                    "agentId": "main",
                    "content": {
                        "text": "这张图片是什么颜色?简短回答",
                        "media": [
                            {
                                "kind": "image",
                                "base64": "data:image/png;base64," + RED_PNG_B64,
                                "mimeType": "image/png",
                                "filename": "red-square.png",
                            }
                        ],
                    },
                    "ts": int(time.time() * 1000),
                }
            )
        )
        print(f">> sent peer={peer_id}", flush=True)

        deadline = time.time() + 360
        text_buf = ""
        tools = []
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=300)
            except asyncio.TimeoutError:
                print("!! ws timeout", flush=True)
                break
            m = json.loads(raw)
            if m.get("type") != "outbound.message":
                continue


            for b in m.get("blocks", []):
                k = b.get("kind")
                if k == "text":
                    text_buf += b.get("text", "")
                elif k == "tool_use":
                    tools.append(("use", b.get("toolName"), (b.get("inputPreview") or "")[:200]))
                elif k == "tool_result":
                    tools.append(("res", b.get("toolName"), (b.get("preview") or "")[:200], bool(b.get("isError"))))
            if m.get("isFinal"):
                break

    print("\n--- response ---")
    print(text_buf[:600])
    print("\n--- tools ---")
    for t in tools[:20]:
        print(" ", t)

    print("\n══ summary ══")
    used_understand = any(t[0] == "use" and t[1] == "understand_image" for t in tools)
    used_read = any(t[0] == "use" and t[1] == "Read" for t in tools)
    red_mentioned = "红" in text_buf or "red" in text_buf.lower()
    print(f"[{'✓' if used_understand else '✗'}] agent called understand_image MCP tool")
    print(f"[{'-' if not used_read else '!'}] agent called Read as fallback: {used_read}")
    print(f"[{'✓' if red_mentioned else '✗'}] response mentions red (the image is a solid red square)")
    return 0 if (used_understand and red_mentioned) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
