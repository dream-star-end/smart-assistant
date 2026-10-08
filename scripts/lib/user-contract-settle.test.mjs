import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchJourneyBrowser } from "./journey-browser.mjs";
import { waitTurnUiSettled, turnTimeline } from "./user-contract-browser.mjs";

// 2026-10-08 smoke robustness: UI settle after backend-proven completion.
// The fixture page renders a finished assistant row (no caret, 发送 button, non-empty prose)
// after `settleAfter` ms; until then it shows the running state (stop button, caret).
async function fixture() {
  const server = createServer((req, res) => {
    const settleAfter = Number(new URL(req.url, "http://x").searchParams.get("settle") ?? "-1");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><div id="root"><button aria-label="停止">■</button></div><script>
      const after = ${settleAfter};
      if (after >= 0) setTimeout(() => {
        document.getElementById('root').innerHTML =
          '<div data-testid="assistant-row"><div class="prose">2</div></div><button aria-label="发送">↑</button>';
      }, after);</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function withPage(fn) {
  const { server, base } = await fixture();
  const browser = await launchJourneyBrowser();
  try { return await fn(await browser.newPage(), base); } finally {
    await browser.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const ok = () => ({ complete: true, error: false });

test("UI that settles inside the strict window passes without a warning", { timeout: 30_000 }, () => withPage(async (page, base) => {
  await page.goto(`${base}/?settle=100`);
  const logs = [];
  const r = await waitTurnUiSettled(page, 0, { model: "m", recheck: ok, strictMs: 2_000, graceMs: 2_000, log: (l) => logs.push(l) });
  assert.equal(r.slow, false);
  assert.deepEqual(logs, []);
}));

test("UI that settles in the grace window passes but is recorded as slow_ui_settle", { timeout: 30_000 }, () => withPage(async (page, base) => {
  await page.goto(`${base}/?settle=1500`);
  const logs = [];
  const r = await waitTurnUiSettled(page, 0, { model: "m", recheck: ok, strictMs: 500, graceMs: 5_000, log: (l) => logs.push(l) });
  assert.equal(r.slow, true);
  assert.match(logs.join("\n"), /^# warn slow_ui_settle model=m settled_ms=\d+ strict_ms=500 state_at_strict=\{.*"stop":true/m);
}));

test("UI that never settles fails hard after the grace window and leaves evidence", { timeout: 30_000 }, () => withPage(async (page, base) => {
  const dir = mkdtempSync(join(tmpdir(), "contract-evidence-"));
  process.env.OC_CONTRACT_ARTIFACTS = dir;
  try {
    await page.goto(`${base}/?settle=-1`);
    let err;
    try {
      await waitTurnUiSettled(page, 0, { model: "m", recheck: ok, timeline: () => [{ type: "outbound.message", final: true, error: false, ms: 9 }], strictMs: 300, graceMs: 600, log: () => {} });
    } catch (e) { err = e; }
    assert.ok(err, "must fail");
    assert.match(err.message, /did not settle within 900ms after backend completion/);
    const base0 = /evidence=(\S+)\.\{png,json\}/.exec(err.message)[1];
    assert.ok(existsSync(`${base0}.png`), "screenshot");
    const ev = JSON.parse(readFileSync(`${base0}.json`, "utf8"));
    assert.equal(ev.atFail.stop, true);
    assert.deepEqual(ev.timeline, [{ type: "outbound.message", final: true, error: false, ms: 9 }]);
  } finally {
    delete process.env.OC_CONTRACT_ARTIFACTS;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test("no grace when the backend re-check no longer shows a clean completion", { timeout: 30_000 }, () => withPage(async (page, base) => {
  await page.goto(`${base}/?settle=1500`);
  const started = Date.now();
  await assert.rejects(
    () => waitTurnUiSettled(page, 0, { model: "m", recheck: () => ({ complete: true, error: true }), strictMs: 300, graceMs: 10_000, log: () => {} }),
    /backend evidence lost on re-check \(complete=true, error=true\)/,
  );
  assert.ok(Date.now() - started < 5_000, "must not wait out the grace window");
}));

test("turn timeline keeps only type/final/error/timing of the exact turn, never content", () => {
  const sent = { peer: { id: "p1" }, clientMessageId: "c1" };
  const frames = [
    { type: "outbound.message", peer: { id: "p1" }, clientMessageId: "c1", content: { text: "secret" }, __at: 1000 },
    { type: "outbound.message", peer: { id: "p2" }, clientMessageId: "c1", __at: 1100 },
    { type: "outbound.message", peer: { id: "p1" }, clientMessageId: "c1", isFinal: true, content: { text: "2" }, __at: 1500 },
  ];
  const t = turnTimeline(frames, sent);
  assert.deepEqual(t, [
    { type: "outbound.message", final: false, error: false, ms: 0 },
    { type: "outbound.message", final: true, error: false, ms: 500 },
  ]);
  assert.doesNotMatch(JSON.stringify(t), /secret/);
});
