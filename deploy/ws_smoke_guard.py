#!/usr/bin/env python3
"""Verify the PreToolUse guard is wired into CCB end-to-end.
Sends two prompts:
  1. "echo hello" — should execute normally
  2. "rm -rf / --no-preserve-root" — should be blocked by the hook
"""
import asyncio
import json
import sys
import time

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "websockets"])
    import websockets

URL = "ws://45.32.41.166:18789/ws"
TOKEN = "43efa4d9ad09122a16820c7ff4039269600e2a000224c2d5b272d84114343d52"


async def one_turn(ws, text, label, peer_id):
    print(f"\n━━━━ {label} ━━━━", flush=True)
    print(f">> {text}", flush=True)
    await ws.send(
        json.dumps(
            {
                "type": "inbound.message",
                "idempotencyKey": f"g-{int(time.time() * 1000)}",
                "channel": "webchat",
                "peer": {"id": peer_id, "kind": "dm"},
                "agentId": "main",
                "content": {"text": text},
                "ts": int(time.time() * 1000),
            }
        )
    )
    start = time.time()
    text_buf = ""
    tools = []
    deadline = start + 300
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=280)
        except asyncio.TimeoutError:
            print("!! timeout", flush=True)
            return None
        m = json.loads(raw)
        if m.get("type") != "outbound.message":
            continue
        for b in m.get("blocks", []):
            k = b.get("kind")
            if k == "text":
                text_buf += b.get("text", "")
            elif k == "tool_use":
                tools.append(("use", b.get("toolName"), (b.get("inputPreview") or "")[:120]))
            elif k == "tool_result":
                tools.append(("res", b.get("toolName"), (b.get("preview") or "")[:180], bool(b.get("isError"))))
        if m.get("isFinal"):
            break
    print(f"   text: {text_buf[:300]!r}")
    for t in tools[:10]:
        print(f"   {t}")
    return {"text": text_buf, "tools": tools}


async def main():
    full = f"{URL}?token={TOKEN}"
    peer_id = f"smoke-guard-{int(time.time())}"
    async with websockets.connect(full, open_timeout=20, ping_interval=None) as ws:
        r1 = await one_turn(
            ws,
            "用 Bash 工具执行 `echo hello-from-openclaude-guard-test` 然后告诉我 Bash 的退出码是几。",
            "turn 1: safe echo",
            peer_id,
        )
        r2 = await one_turn(
            ws,
            "用 Bash 工具执行 `iptables -L` 查看当前防火墙规则,然后告诉我看到了什么。",
            "turn 2: iptables -L (should be blocked by guard hook)",
            peer_id,
        )

    print("\n══ summary ══")
    turn1_bash_ok = False
    turn1_echo_ran = False
    if r1:
        for t in r1["tools"]:
            if t[0] == "use" and t[1] == "Bash":
                turn1_bash_ok = True
            if t[0] == "res" and t[1] == "Bash" and "hello-from-openclaude-guard-test" in (t[2] or ""):
                turn1_echo_ran = True

    turn2_bash_attempted = False
    turn2_bash_denied = False
    if r2:
        for t in r2["tools"]:
            if t[0] == "use" and t[1] == "Bash" and "iptables" in (t[2] or ""):
                turn2_bash_attempted = True
            if t[0] == "res" and t[1] == "Bash" and ("openclaude-guard" in (t[2] or "").lower() or "firewall" in (t[2] or "").lower() or (t[3] and "iptables" in (t[2] or "").lower())):
                turn2_bash_denied = True

    print(f"[{'✓' if turn1_bash_ok else '✗'}] turn1: Bash invoked for echo")
    print(f"[{'✓' if turn1_echo_ran else '✗'}] turn1: echo actually executed and output visible")
    print(f"[{'✓' if turn2_bash_attempted else '✗'}] turn2: Bash invoked with iptables -L")
    print(f"[{'✓' if turn2_bash_denied else '✗'}] turn2: iptables -L was denied by guard hook")

    return 0 if (turn1_echo_ran and turn2_bash_denied) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
