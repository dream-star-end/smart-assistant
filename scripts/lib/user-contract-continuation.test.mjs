import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { launchJourneyBrowser } from "./journey-browser.mjs";
import { installTurnProbe, runContinuationTurns } from "./user-contract-browser.mjs";

// OCV5-405: the C3 per-model sequence against a minimal chat page. The page
// sends real inbound.message frames over /ws and renders each final reply as an
// assistant row. `mode` makes the fake backend misbehave in exactly one way.
//   remember  – turn 2 answers the code from turn 1 (healthy)
//   forget    – turn 2 has no context
//   newpeer   – the page sends turn 2 from another session (backend still answers)
//   alert1    – after turn 2 the first row turns into a failure card
//   error1    – after turn 2 the backend sends an error frame for turn 1
const PAGE = `<!doctype html><div id="root"><div id="rows"></div><textarea></textarea><button aria-label="发送">发送</button></div><script>
const mode = new URLSearchParams(location.search).get("mode");
const ws = new WebSocket("ws://" + location.host + "/ws");
let n = 0;
document.querySelector("button").onclick = () => {
  const input = document.querySelector("textarea");
  const text = input.value; input.value = ""; n++;
  const peer = mode === "newpeer" && n === 2 ? "p2" : "p1";
  ws.send(JSON.stringify({ type: "inbound.message", model: "m", content: { text }, peer: { id: peer }, clientMessageId: "m" + n }));
};
ws.onmessage = (e) => {
  const f = JSON.parse(e.data);
  if (f.type !== "outbound.message" || !f.isFinal) return;
  const row = document.createElement("div");
  row.dataset.testid = "assistant-row";
  row.innerHTML = '<div class="prose"></div>';
  row.querySelector(".prose").textContent = f.text;
  document.getElementById("rows").append(row);
  if (mode === "alert1" && f.clientMessageId === "m2") {
    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.textContent = "x";
    document.querySelector('[data-testid="assistant-row"]').append(alert);
  }
};
</script>`;

async function fixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  let mode = "remember";
  wss.on("connection", (ws) => {
    let code = "";
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type !== "inbound.message") return;
      const reply = (text, extra = {}) => ws.send(JSON.stringify({ type: "outbound.message", isFinal: true, peer: f.peer, clientMessageId: f.clientMessageId, text, ...extra }));
      const given = /编号是 PO-([A-Z0-9]{8})/.exec(f.content.text);
      if (given) { code = given[1]; reply("2"); return; }
      reply(mode === "forget" ? "我不知道之前的内容" : `编号是 PO-${code}`);
      if (mode === "error1") ws.send(JSON.stringify({ type: "outbound.error", peer: f.peer, clientMessageId: "m1", error: "late" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, wss, base: `http://127.0.0.1:${server.address().port}`, setMode: (m) => { mode = m; } };
}

async function run(mode, cost = "live") {
  const fx = await fixture();
  fx.setMode(mode);
  const browser = await launchJourneyBrowser();
  const logs = [];
  try {
    const context = await browser.newContext();
    const probe = await installTurnProbe(context, fx.base, cost);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${fx.base}/?mode=${mode}`);
    const result = await runContinuationTurns(page, probe, { model: "m", catalog: [], cost }, (l) => logs.push(l));
    return { result, logs, probe };
  } finally {
    await browser.close().catch(() => {});
    for (const c of fx.wss.clients) c.terminate();
    fx.wss.close();
    fx.server.closeAllConnections();
    await new Promise((resolve) => fx.server.close(resolve));
  }
}

const T = { timeout: 60_000 };
test("healthy backend: two turns in one session recall the code", T, async () => {
  const { result, logs, probe } = await run("remember");
  assert.deepEqual(result, { executed: true });
  assert.equal(probe.sent.length, 2);
  assert.match(logs.join("\n"), /# continuation model=m turns=2 same_session=ok recall=ok/);
});
test("backend that loses context fails the gate", T, async () => {
  await assert.rejects(() => run("forget"), /did not recall the first turn's code/);
});
test("second turn sent from another session fails the gate", T, async () => {
  await assert.rejects(() => run("newpeer"), /left the first turn's session/);
});
test("failure card on an earlier row after turn 2 fails the gate", T, async () => {
  await assert.rejects(() => run("alert1"), /failure card after the continuation turn/);
});
test("late error frame for turn 1 fails the gate", T, async () => {
  await assert.rejects(() => run("error1"), /lost completion or returned an error \(complete=true, error=true\)/);
});
test("dry mode sends one unforwarded turn and reports continuation as not executed", T, async () => {
  const { result, logs, probe } = await run("remember", "dry");
  assert.deepEqual(result, { executed: false });
  assert.equal(probe.sent.length, 1);
  assert.equal(probe.received.length, 0);
  assert.match(logs.join("\n"), /# continuation model=m not executed \(cost=dry\)/);
});
