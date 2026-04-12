#!/usr/bin/env python3
"""
Multi-scenario E2E smoke test:
  1. single turn with streaming (verify deltas come through)
  2. follow-up turn in the same session (verify cache-read)
  3. a tool-triggering prompt (verify tool_use/tool_result render with correct name)
"""
import asyncio
import json
import os
import sys
import time

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "websockets"])
    import websockets

URL = os.environ.get("WS_URL", "ws://45.32.41.166:18789/ws")
TOKEN = os.environ.get("WS_TOKEN", "")


async def one_turn(ws, text, label):
    peer_id = "smoke-multi"  # same peer → same sessionKey → same CCB subprocess
    print(f"\n━━━━━━━━━━ {label} ━━━━━━━━━━", flush=True)
    print(f">> {text}", flush=True)
    await ws.send(
        json.dumps(
            {
                "type": "inbound.message",
                "idempotencyKey": f"smoke-{int(time.time() * 1000)}",
                "channel": "webchat",
                "peer": {"id": peer_id, "kind": "dm"},
                "content": {"text": text},
                "ts": int(time.time() * 1000),
            }
        )
    )
    start = time.time()
    first_delta_at = None
    text_buf = ""
    thinking_buf = ""
    tools_seen = []
    tool_results = []
    final_meta = None
    while time.time() - start < 300:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=200)
        except asyncio.TimeoutError:
            print("!! TIMEOUT", flush=True)
            return None
        msg = json.loads(raw)
        if msg.get("type") != "outbound.message":
            continue
        for b in msg.get("blocks", []):
            if b.get("kind") == "text":
                if first_delta_at is None:
                    first_delta_at = time.time() - start
                text_buf += b.get("text", "")
            elif b.get("kind") == "thinking":
                thinking_buf += b.get("text", "")
            elif b.get("kind") == "tool_use":
                tools_seen.append((b.get("toolName"), (b.get("inputPreview") or "")[:80]))
            elif b.get("kind") == "tool_result":
                tool_results.append(
                    (b.get("toolName"), bool(b.get("isError")), (b.get("preview") or "")[:80])
                )
        if msg.get("isFinal"):
            final_meta = msg.get("meta") or {}
            break
    elapsed = time.time() - start
    print(f"   first delta: {first_delta_at:.2f}s  total: {elapsed:.2f}s", flush=True)
    if thinking_buf:
        print(f"   thinking: {thinking_buf[:120]!r}", flush=True)
    for name, inp in tools_seen:
        print(f"   🔧 {name}  {inp}", flush=True)
    for name, err, prev in tool_results:
        mark = "⚠" if err else "↳"
        print(f"   {mark} {name}: {prev}", flush=True)
    print(f"   text: {text_buf[:200]!r}", flush=True)
    if final_meta:
        m = final_meta
        line = (
            f"   meta: cost ${m.get('cost', 0):.4f}"
            f" (total ${m.get('totalCost', 0):.4f})"
            f" in={m.get('inputTokens')} out={m.get('outputTokens')}"
            f" cacheRead={m.get('cacheReadTokens')} cacheWrite={m.get('cacheCreationTokens')}"
            f" turn={m.get('turn')}"
        )
        print(line, flush=True)
    return {
        "first_delta": first_delta_at,
        "elapsed": elapsed,
        "text": text_buf,
        "thinking": thinking_buf,
        "tools": tools_seen,
        "results": tool_results,
        "meta": final_meta,
    }


async def main():
    full = f"{URL}?token={TOKEN}"
    print(f"connecting {URL}", flush=True)
    async with websockets.connect(full, open_timeout=15, ping_interval=None) as ws:
        r1 = await one_turn(ws, "remember my name is Alice. reply with just OK.", "Turn 1: set memory")
        r2 = await one_turn(ws, "what is my name? reply in one word.", "Turn 2: recall (same session)")
        r3 = await one_turn(
            ws,
            "run the command `ls /opt/openclaude` using the Bash tool and summarize what you see in one sentence.",
            "Turn 3: tool use",
        )

    print("\n══════════ SUMMARY ══════════", flush=True)
    checks = []
    if r1 and r1["first_delta"] is not None:
        checks.append(("turn1 streaming (first delta under 15s)", r1["first_delta"] < 15))
    if r1 and r1["meta"]:
        checks.append(("turn1 result has meta", True))
    if r2 and r2["meta"]:
        cache_read = r2["meta"].get("cacheReadTokens") or 0
        checks.append(("turn2 reused session cache (cacheRead > 0)", cache_read > 0))
        checks.append(
            (
                "turn2 totalCost > turn1 cost (accumulated)",
                (r2["meta"].get("totalCost") or 0) > (r1["meta"].get("cost") or 0) if r1 and r1["meta"] else False,
            )
        )
        if r1 and "alice" in (r2.get("text") or "").lower():
            checks.append(("turn2 model recalled 'Alice'", True))
        else:
            checks.append(("turn2 model recalled 'Alice'", False))
    if r3:
        tool_names = [t[0] for t in r3.get("tools", [])]
        checks.append(("turn3 fired a tool", bool(tool_names)))
        checks.append(("turn3 Bash tool used", "Bash" in tool_names))
        if r3.get("results"):
            first_result_name = r3["results"][0][0]
            checks.append(("turn3 tool_result carries tool name", first_result_name != "unknown" and bool(first_result_name)))
        else:
            checks.append(("turn3 tool_result carries tool name", False))
    for label, ok in checks:
        print(f"  [{'✓' if ok else '✗'}] {label}", flush=True)
    all_ok = all(ok for _, ok in checks)
    print(f"\n{'ALL PASS' if all_ok else 'SOME FAILURES'}", flush=True)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
