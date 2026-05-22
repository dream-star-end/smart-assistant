import os
#!/usr/bin/env python3
"""E2E: verify minimax-media MCP tools work for image gen + TTS."""
import asyncio
import io
import json
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "websockets"])
    import websockets

URL = os.environ.get("WS_URL", "ws://127.0.0.1:18789/ws")
TOKEN = "43efa4d9ad09122a16820c7ff4039269600e2a000224c2d5b272d84114343d52"


async def turn(ws, text, label, peer_id):
    print(f"\n━━━━ {label} ━━━━", flush=True)
    print(f">> {text[:80]}", flush=True)
    await ws.send(
        json.dumps(
            {
                "type": "inbound.message",
                "idempotencyKey": f"m-{int(time.time() * 1000)}",
                "channel": "webchat",
                "peer": {"id": peer_id, "kind": "dm"},
                "agentId": "main",
                "content": {"text": text},
                "ts": int(time.time() * 1000),
            }
        )
    )
    text_buf = ""
    tools = []
    deadline = time.time() + 360
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=300)
        except asyncio.TimeoutError:
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
                p = b.get("preview") or ""
                tools.append(("res", b.get("toolName"), p[:250], bool(b.get("isError"))))
        if m.get("isFinal"):
            break
    print(f"--- response ({len(text_buf)} chars) ---")
    print(text_buf[:500])
    print(f"--- tools ({len(tools)}) ---")
    for t in tools[:12]:
        print(" ", t)
    return {"text": text_buf, "tools": tools}


async def main():
    full = f"{URL}?token={TOKEN}"
    peer_id = f"smoke-media-{int(time.time())}"
    async with websockets.connect(full, open_timeout=20, ping_interval=None) as ws:
        r1 = await turn(
            ws,
            "用 MiniMax 的 text_to_image MCP 工具生成一张图: 一只橙色的猫坐在窗台上看月亮。告诉我图片 URL。",
            "Turn 1: text_to_image",
            peer_id,
        )
        r2 = await turn(
            ws,
            "用 text_to_audio MCP 工具把这句话转成中文语音: '你好 OpenClaude,这是一次 TTS 测试'。告诉我音频 URL。",
            "Turn 2: text_to_audio",
            peer_id,
        )

    print("\n══ summary ══")
    img_used = any(
        t[0] == "use" and "text_to_image" in (t[1] or "") for t in (r1 or {"tools": []})["tools"]
    )
    img_ok = any(
        t[0] == "res" and "text_to_image" in (t[1] or "") and not t[3]
        for t in (r1 or {"tools": []})["tools"]
    )
    tts_used = any(
        t[0] == "use" and "text_to_audio" in (t[1] or "") for t in (r2 or {"tools": []})["tools"]
    )
    tts_ok = any(
        t[0] == "res" and "text_to_audio" in (t[1] or "") and not t[3]
        for t in (r2 or {"tools": []})["tools"]
    )
    print(f"[{'✓' if img_used else '✗'}] text_to_image invoked")
    print(f"[{'✓' if img_ok else '✗'}] text_to_image returned non-error")
    print(f"[{'✓' if tts_used else '✗'}] text_to_audio invoked")
    print(f"[{'✓' if tts_ok else '✗'}] text_to_audio returned non-error")
    return 0 if (img_ok and tts_ok) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
