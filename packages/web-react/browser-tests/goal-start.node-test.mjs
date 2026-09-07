import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");
test("full App goal save auto-start (desktop/mobile, failure, retry, busy)", { timeout: 120_000 }, async (t) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./goal-start-harness.tsx", import.meta.url))],
    bundle: true, write: false, format: "iife", jsx: "automatic",
    plugins: process.env.OC_GOAL_START_RED === "1" ? [{
      name: "goal-start-red-control",
      setup(build) {
        build.onLoad({ filter: /goalStart\.ts$/ }, async ({ path }) => ({
          contents: (await readFile(path, "utf8")).replace("await deps.start(goal);", "return;"),
          loader: "ts",
        }));
      },
    }] : [],
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)) },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' }, logLevel: "error",
  });
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1280, 390]) await t.test(`viewport ${width}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const rows = new Map(), goals = new Map(), calls = [], errors = [];
      let failNextGoal = true;
      page.on("pageerror", (error) => errors.push(error.message));
      // Exercise the actual ChatSocket's durable offline queue, not a mock send callback.
      await page.addInitScript(() => { window.WebSocket = undefined; localStorage.setItem("oc_auth_hint", "1"); });
      await page.route("**/api/**", async (route) => {
        const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
        const data = req.postDataJSON() ?? {};
        const user = { id: "u1", email: "test@example.com", email_verified: true, role: "user", display_name: "Test", credits: "1000" };
        let body = {}, status = 200;
        if (path === "/api/public/config") body = { turnstile_bypass: true, require_email_verified: false, allow_registration: true };
        else if (path === "/api/auth/refresh") body = { access_token: "test-token", access_exp: Date.now() / 1000 + 3600, remember: true };
        else if (path === "/api/me") body = { user };
        else if (path === "/api/public/models") body = { models: [{ id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", engine: "codex" }] };
        else if (path === "/api/me/preferences") body = { prefs: { default_model: "gpt-5.6-sol" } };
        else if (path === "/api/agent/status") body = { runtime_ready: true, container: { id: "c1", status: "running" }, subscription: { status: "active" } };
        else if (path === "/api/sessions/list") body = { sessions: [] };
        else if (/^\/api\/sessions\/[^/]+$/.test(path) && method === "PUT") {
          const id = path.split("/").at(-1); rows.set(id, data); calls.push(["session", id]); body = { ok: true };
        } else if (/^\/api\/sessions\/[^/]+$/.test(path) && method === "PATCH") {
          const id = path.split("/").at(-1); calls.push(["patch", id, data]); body = { ok: true };
        } else if (/^\/api\/session-goals\/[^/]+$/.test(path)) {
          const sessionId = path.split("/").at(-1);
          if (method === "PUT") {
            if (failNextGoal) { failNextGoal = false; status = 500; body = { error: { code: "TEST_SAVE", message: "测试保存失败" } }; }
            else {
              assert.ok(rows.has(sessionId), "server row precedes goal");
              const goal = { sessionId, goalId: "11111111-1111-4111-8111-111111111111", objective: data.objective, status: "active",
                tokenBudget: null, creditBudget: null, tokensUsed: 0, creditsUsed: "0", timeUsedSeconds: 0,
                stateRevision: (goals.get(sessionId)?.stateRevision ?? 0) + 1, snapshotRevision: 1,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), statusChangedAt: new Date().toISOString() };
              goals.set(sessionId, goal); calls.push(["goal", sessionId]); body = { goal };
            }
          } else body = { goal: goals.get(sessionId) ?? null };
        }
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const more = page.getByRole("button", { name: "更多选项", exact: true });
        await more.waitFor(); await more.click();
        await page.getByText("设定目标", { exact: true }).click();
        const objective = page.getByPlaceholder("这次会话要达成什么？");
        await objective.fill("目标自动开工验证");
        await page.getByRole("button", { name: "设置并开始", exact: true }).click();
        await page.getByRole("alert").waitFor();
        assert.equal(await page.getByTestId("user-row").count(), 0);
        await page.getByRole("button", { name: "设置并开始", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await page.getByTestId("user-row").waitFor();
        assert.equal(await page.getByTestId("user-row").count(), 1);
        assert.match(await page.getByTestId("user-row").textContent(), /目标自动开工验证/);
        assert.equal(rows.size, 1, "must send to the just-materialized session");
        assert.equal(calls.filter(([kind]) => kind === "goal").length, 1);
        assert.ok(calls.some(([kind, id, data]) => kind === "patch" && goals.has(id) && data.title === "目标自动开工验证"));
        await more.click(); await page.getByRole("menuitem", { name: /目标/ }).click();
        await objective.fill("更新目标但不重复开工");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        assert.equal(await page.getByTestId("user-row").count(), 1, "offline-queued is busy, no duplicate");
        assert.equal(calls.filter(([kind]) => kind === "goal").length, 2);
        assert.deepEqual(errors, []);
      } catch (error) {
        console.error("page errors:", errors, "body:", (await page.locator("body").innerText()).slice(-2000));
        throw error;
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
});
