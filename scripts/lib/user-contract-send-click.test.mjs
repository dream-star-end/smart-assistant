import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { launchJourneyBrowser } from "./journey-browser.mjs";
import { clickSend } from "./user-contract-browser.mjs";

// OCV5-431: the gate's 发送 click must not depend on Playwright's post-click navigation
// barrier. The real trigger of the 2026-10-15 hang was not reproduced (6 probe rounds, no
// navigation request during the click); `mode=hang` stands in for it: the click queues
// the message, then requests a navigation that never commits.
const PAGE = `<!doctype html><style>#cover{position:fixed;inset:0;background:transparent}</style>
<div id="root"><textarea></textarea><button aria-label="发送">发送</button></div><script>
const mode = new URLSearchParams(location.search).get("mode");
const ws = new WebSocket("ws://" + location.host + "/ws");
const button = document.querySelector("button");
if (mode === "late") { button.disabled = true; setTimeout(() => { button.disabled = false; }, 300); }
if (mode === "cover") { const c = document.createElement("div"); c.id = "cover"; c.setAttribute("role", "dialog"); document.body.append(c); }
button.onclick = () => {
  ws.send(JSON.stringify({ type: "inbound.message", content: { text: document.querySelector("textarea").value } }));
  if (mode === "hang") location.href = "/hang";
};
</script>`;

async function fixture() {
  const held = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith("/hang")) { held.push(res); return; } // never answers
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  const frames = [];
  wss.on("connection", (ws) => ws.on("message", (raw) => frames.push(JSON.parse(String(raw)))));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchJourneyBrowser();
  const open = async (mode) => {
    const page = await browser.newPage();
    await page.goto(`${base}/?mode=${mode}`);
    await page.waitForFunction(() => true);
    await page.locator("textarea").fill(`G431-${mode}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return page;
  };
  const close = async () => {
    for (const res of held) res.destroy();
    await browser.close();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  };
  return { open, frames, close };
}

test("OCV5-431: a click whose navigation never commits hangs locator.click but not clickSend", async () => {
  const f = await fixture();
  try {
    const before = await f.open("hang");
    await assert.rejects(before.getByRole("button", { name: "发送", exact: true }).click({ timeout: 3_000 }),
      /waiting for scheduled navigations to finish|Timeout/);
    const page = await f.open("hang");
    const logs = [];
    const started = Date.now();
    await clickSend(page, (line) => logs.push(line), 3_000);
    assert.ok(Date.now() - started < 2_000, `clickSend took ${Date.now() - started}ms`);
    assert.equal(f.frames.filter((x) => x.content.text === "G431-hang").length, 2);
    assert.match(logs.join("\n"), /send_click_navigation_request \["main \/hang"\]/);
  } finally {
    await f.close();
  }
});

test("OCV5-431: clickSend waits for an enabled button and refuses a covered one", async () => {
  const f = await fixture();
  try {
    const late = await f.open("late");
    await clickSend(late, () => {}, 3_000);
    assert.equal(f.frames.filter((x) => x.content.text === "G431-late").length, 1);
    const covered = await f.open("cover");
    await assert.rejects(clickSend(covered, () => {}, 3_000), /发送 button is covered by div#cover\[role=dialog\]/);
    assert.equal(f.frames.filter((x) => x.content.text === "G431-cover").length, 0);
  } finally {
    await f.close();
  }
});
