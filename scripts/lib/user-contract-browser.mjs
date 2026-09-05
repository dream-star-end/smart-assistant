import { selectJourneyModel } from "./journey-browser.mjs";
import { assertOutbound, parseFrame, turnEvidence, turnPolicy } from "./user-contract.mjs";

export async function coldUiLogin(page, options, password) {
  // A fresh context has no cookies, IndexedDB or service workers. Clear web storage
  // once on the landing page, never add an init script that would erase UI login.
  await page.goto(options.base, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  if (await page.evaluate(() => localStorage.getItem("oc_auth_hint")) !== null) throw new Error("Cold context contains auth hint");
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
    server.onMessage((raw) => { const f = parseFrame(raw); if (f) received.push(f); ws.send(raw); });
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
  await page.waitForFunction((before) => {
    const rows = document.querySelectorAll('[data-testid="assistant-row"]');
    const last = rows[rows.length - 1];
    return rows.length > before && last && !last.querySelector('.caret-blink') && document.querySelector('button[aria-label="发送"]') && last.querySelector('.prose')?.textContent?.trim();
  }, rowsBefore, { timeout: 20_000, polling: 50 }).catch(async () => {
    const state = await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-testid="assistant-row"]');
      const last = rows[rows.length - 1];
      return { rows: rows.length, hasText: Boolean(last?.querySelector('.prose')?.textContent?.trim()), caret: Boolean(last?.querySelector('.caret-blink')), send: Boolean(document.querySelector('button[aria-label="发送"]')) };
    });
    throw new Error(`Completed turn UI did not settle: model=${model}, before=${rowsBefore}, state=${JSON.stringify(state)}`);
  });
  if (await page.getByTestId("assistant-row").last().locator('[role="alert"]').count() || await page.getByText(/发送失败|消息暂未安全送达/).count()) throw new Error("Turn finished with a failure card");
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
