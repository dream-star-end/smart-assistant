import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectJourneyModel } from "./journey-browser.mjs";
import { assertOutbound, parseFrame, turnEvidence, turnPolicy } from "./user-contract.mjs";

export async function coldUiLogin(page, options, password) {
  // A fresh context has no cookies, IndexedDB or service workers. Clear web storage
  // once on the landing page, never add an init script that would erase UI login.
  const pageErrors = [];
  let failedScripts = 0;
  const onPageError = (error) => { if (pageErrors.length < 3) pageErrors.push(error.name); };
  const onRequestFailed = (request) => {
    if (request.resourceType() === "script") failedScripts++;
  };
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  const landing = await page.goto(options.base, { waitUntil: "domcontentloaded" });
  if (!landing?.ok()) throw new Error(`Cold landing HTTP ${landing?.status() ?? "no response"}`);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  if (await page.evaluate(() => localStorage.getItem("oc_auth_hint")) !== null) throw new Error("Cold context contains auth hint");
  try {
    // A cold master can be healthy before its browser has fetched and executed
    // the UI bundle. Keep the real login requirement; only extend that bounded
    // render wait, never substitute an API login or reuse an authenticated page.
    await page.getByRole("button", { name: "登录", exact: true }).first()
      .waitFor({ state: "visible", timeout: 60_000 });
  } catch {
    const state = await page.evaluate(() => ({ readyState: document.readyState,
      rootChildren: document.getElementById("root")?.childElementCount ?? -1 }))
      .catch(() => ({ readyState: "unavailable", rootChildren: -1 }));
    throw new Error(`Cold login not rendered: ${JSON.stringify({
      ...state, pageErrors, failedScripts })}`);
  } finally {
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
  }
  await page.getByRole("button", { name: "登录", exact: true }).first().click();
  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"]').fill(options.email);
  await form.locator('input[type="password"]').fill(password);
  // Observe the actual UI submission, never call auth API or supply a token.
  const submitted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/login" && r.request().method() === "POST");
  await Promise.all([submitted.then((r) => { if (!r.ok()) throw new Error(`UI login HTTP ${r.status()}`); }), form.getByRole("button", { name: "登录", exact: true }).click()]);
  await page.getByText("新建会话", { exact: true }).first().waitFor({ state: "visible" });
  const url = new URL(page.url());
  if (url.origin !== options.base || /login|register|reset/i.test(url.pathname + url.hash)) throw new Error("Login did not reach the application URL");
  await newSession(page);
}
export async function newSession(page) {
  await page.getByText("新建会话", { exact: true }).first().click();
  await page.locator("textarea").first().waitFor({ state: "visible" });
  // Visibility alone can still match the previous session while React commits
  // the navigation. Establish a genuinely empty session before capturing rows.
  await page.waitForFunction(() => {
    const input = document.querySelector("textarea");
    return input && input.value === "" && document.querySelectorAll('[data-testid="assistant-row"]').length === 0;
  }, undefined, { timeout: 20_000, polling: 50 });
}

// Route only chat sockets and preserve every non-turn frame. In dry mode the real
// browser send is observed but never forwarded to the server (zero inference).
export async function installTurnProbe(context, base, cost) {
  const sent = [], received = [], writes = [], catalogs = [];
  const probe = { sent, received, writes, catalogs, liveTexts: new Set() };
  context.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin === base && /^\/api\/sessions\/[^/]+$/.test(u.pathname) && ["PUT", "PATCH"].includes(r.method())) {
      try { writes.push({ peer: decodeURIComponent(u.pathname.split("/").pop()), body: r.postDataJSON() }); } catch { /* invalid JSON cannot satisfy a proof */ }
    }
  });
  context.on("response", (r) => {
    if (new URL(r.url()).origin === base && new URL(r.url()).pathname === "/api/public/models" && r.ok()) {
      const pending = r.json().then((b) => b.models ?? []).catch(() => []);
      catalogs.push(pending);
    }
  });
  const expected = new URL(base);
  await context.routeWebSocket((url) => url.host === expected.host && url.pathname.startsWith("/ws"), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const f = parseFrame(raw);
      if (f?.type === "inbound.message") {
        sent.push(f);
        if (!probe.liveTexts.has(f.content?.text)) return;
      }
      server.send(raw);
    });
    server.onMessage((raw) => { const f = parseFrame(raw); if (f) received.push(Object.assign(f, { __at: Date.now() })); ws.send(raw); });
  });
  return probe;
}

export async function sendContractTurn(page, probe, { model, engine, catalog, cost, requireHttpModel = false }) {
  const text = `R2-${crypto.randomUUID()} 请只回答数字2，不使用工具。`;
  if (turnPolicy(cost).forward) probe.liveTexts.add(text);
  const rowsBefore = await page.getByTestId("assistant-row").count();
  await page.locator("textarea").first().fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  // Bridge the observer into an event-driven page wait; timers here bound the
  // observer only, not retries of the test or of a message.
  const sent = await waitUntil(() => probe.sent.find((f) => f.content?.text === text), 20_000, "No outbound chat frame");
  assertOutbound(sent, { model, text, engine }, catalog);
  if (requireHttpModel) {
    await waitUntil(() => probe.writes.some((w) => w.peer === sent.peer.id && w.body?.modelId === model), 20_000, "Session HTTP body.modelId mismatch");
  }
  if (!turnPolicy(cost).waitForCompletion) return;
  await waitUntil(() => {
    const evidence = turnEvidence(probe.received, sent);
    if (evidence.error) throw new Error("Exact turn returned an error");
    return evidence.complete;
  }, 180_000, "Exact turn did not complete");
  await waitTurnUiSettled(page, rowsBefore, {
    model,
    recheck: () => turnEvidence(probe.received, sent),
    timeline: () => turnTimeline(probe.received, sent),
  });
  if (await page.getByTestId("assistant-row").last().locator('[role="alert"]').count() || await page.getByText(/发送失败|消息暂未安全送达/).count()) throw new Error("Turn finished with a failure card");
}
// ── UI 收尾等待(2026-10-08 冒烟健壮性)──
// 进入这里时,后端已经给出本轮权威完成证据:服务器对这条消息(同 peer + clientMessageId)发出
// isFinal 的 outbound.message,且没有任何 error 帧。UI 判据一条不放松:新 assistant 行、无流式
// 光标、composer 回到「发送」、正文非空;之后仍查失败卡。
// 只把「后端已完成、UI 还在收尾」与真失败分开:
//   · strictMs 内收尾 → 通过;
//   · 超时 → 复核后端证据(仍完成、仍无 error,否则立即按真失败处理)→ 再给一次 graceMs;
//     期间收尾 → 通过,但打印 `# warn slow_ui_settle …`,进日志供 v5-smoke-flake-report 统计;
//   · grace 仍未收尾 → 硬失败,并落证据(唯一命名的截图 + DOM 状态 + 本轮帧时间线,不含正文)。
export const UI_SETTLE_STRICT_MS = 20_000;
export const UI_SETTLE_GRACE_MS = 40_000;

function uiSettledPredicate(before) {
  const rows = document.querySelectorAll('[data-testid="assistant-row"]');
  const last = rows[rows.length - 1];
  return rows.length > before && last && !last.querySelector('.caret-blink') && document.querySelector('button[aria-label="发送"]') && last.querySelector('.prose')?.textContent?.trim();
}

async function uiState(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid="assistant-row"]');
    const last = rows[rows.length - 1];
    return { rows: rows.length, hasText: Boolean(last?.querySelector('.prose')?.textContent?.trim()), caret: Boolean(last?.querySelector('.caret-blink')), send: Boolean(document.querySelector('button[aria-label="发送"]')), stop: Boolean(document.querySelector('button[aria-label="停止"]')) };
  }).catch(() => ({ unavailable: true }));
}

// 本轮帧的时间线:只记类型 / isFinal / 相对发送的毫秒数,不记正文与凭据。
export function turnTimeline(frames, sent) {
  const own = frames.filter((f) => f?.peer?.id === sent.peer.id && f.clientMessageId === sent.clientMessageId);
  const t0 = own[0]?.__at ?? 0;
  return own.map((f) => ({ type: f.type, final: f.isFinal === true, error: Boolean(f.error), ms: (f.__at ?? 0) - t0 }));
}

export function contractEvidenceBase(env = process.env) {
  const dir = env.OC_CONTRACT_ARTIFACTS || "/tmp";
  mkdirSync(dir, { recursive: true });
  return join(dir, `v5-contract-${new Date().toISOString().replace(/[:.]/g, "")}-${Math.random().toString(36).slice(2, 8)}`);
}

export async function waitTurnUiSettled(page, rowsBefore, { model, recheck, timeline = () => [], strictMs = UI_SETTLE_STRICT_MS, graceMs = UI_SETTLE_GRACE_MS, log = console.log } = {}) {
  const started = Date.now();
  const settle = (timeout) => page.waitForFunction(uiSettledPredicate, rowsBefore, { timeout, polling: 50 });
  try {
    await settle(strictMs);
    return { slow: false, settledMs: Date.now() - started };
  } catch { /* strict window missed: re-check backend, then one bounded grace window */ }
  const atStrict = await uiState(page);
  const evidence = recheck?.();
  if (!evidence?.complete || evidence.error) {
    throw new Error(`Exact turn backend evidence lost on re-check (complete=${Boolean(evidence?.complete)}, error=${Boolean(evidence?.error)}): model=${model}`);
  }
  try {
    await settle(graceMs);
  } catch {
    // 证据 best effort:目录建不出来也绝不覆盖原失败。
    let base = "unavailable";
    try { base = contractEvidenceBase(); } catch { /* evidence is best effort */ }
    try { await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 5_000 }); } catch { /* evidence is best effort */ }
    const atFail = await uiState(page);
    try {
      writeFileSync(`${base}.json`, JSON.stringify({ model, rowsBefore, strictMs, graceMs, waitedMs: Date.now() - started, atStrict, atFail, url: page.url(), timeline: timeline() }, null, 2));
    } catch { /* evidence is best effort */ }
    throw new Error(`Completed turn UI did not settle within ${strictMs + graceMs}ms after backend completion: model=${model}, before=${rowsBefore}, state=${JSON.stringify(atFail)}, evidence=${base}.{png,json}`);
  }
  const settledMs = Date.now() - started;
  log(`# warn slow_ui_settle model=${model} settled_ms=${settledMs} strict_ms=${strictMs} state_at_strict=${JSON.stringify(atStrict)}`);
  return { slow: true, settledMs };
}
export async function waitUntil(check, timeout, message) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
export { selectJourneyModel };
