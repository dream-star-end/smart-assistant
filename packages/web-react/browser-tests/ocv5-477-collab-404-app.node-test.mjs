import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

if (!process.env.OC_E2E_BROWSER) {
  const cached = "/usr/local/share/ms-playwright/chromium-1226/chrome-linux64/chrome";
  if (existsSync(cached)) process.env.OC_E2E_BROWSER = cached;
}

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");

test("commercial 404 collaboration-config: solo/team stay selectable and team still sends", { timeout: 120_000 }, async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./goal-start-harness.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)) },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}',
    },
    logLevel: "error",
  });
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    const owned = new Set();
    const calls = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.WebSocket = undefined;
      localStorage.setItem("oc_auth_hint", "1");
    });
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const method = req.method();
      const user = {
        id: "u1",
        email: "test@example.com",
        email_verified: true,
        role: "user",
        display_name: "Test",
        credits: "1000",
      };
      let body = {};
      let status = 200;
      if (path === "/api/public/config") body = { turnstile_bypass: true, require_email_verified: false, allow_registration: true };
      else if (path === "/api/auth/refresh") {
        body = { access_token: "test-token", access_exp: Date.now() / 1000 + 3600, remember: true };
      } else if (path === "/api/me") body = { user };
      else if (path === "/api/public/models") {
        body = { models: [{ id: "glm-5.2", display_name: "GLM-5.2", engine: "ccb" }] };
      } else if (path === "/api/me/preferences") body = { prefs: { default_model: "glm-5.2" } };
      else if (path === "/api/agent/status") {
        body = { runtime_ready: true, container: { id: "c1", status: "running" }, subscription: { status: "active" } };
      } else if (path === "/api/sessions/list") body = { sessions: [] };
      else if (path === "/api/marketplace/my-agents") {
        body = { agents: [{ id: "main", slug: "main", name: "全能助手", installed: true, isDefault: true }] };
      } else if (path === "/api/collaboration-config") {
        // Commercial containers serve this route as selfhost-only: always 404.
        calls.push({ kind: "collab", method });
        status = 404;
        body = { error: { code: "NOT_FOUND", message: "collaboration-config is selfhost only" }, requestId: "50e024e47bcd4ccd9500877225074562" };
      } else if (path.startsWith("/api/sessions")) body = { ok: true };
      else body = {};
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    const putDone = () =>
      page.waitForResponse((res) => res.url().includes("/api/collaboration-config") && res.request().method() === "PUT");
    const pressed = (name) => page.getByRole("button", { name }).getAttribute("aria-pressed");
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.getByRole("button", { name: /切换智能体/ }).waitFor();
      await page.getByRole("button", { name: /切换智能体/ }).click();
      await page.getByRole("button", { name: /队长切换为/ }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      const firstPut = putDone();
      await page.getByPlaceholder(/和「全能助手」对话/).fill("团队首发在 404 下也要发出");
      await page.getByRole("button", { name: "发送" }).click();
      await firstPut;
      await page.getByTestId("queued-send-row").filter({ hasText: "团队首发在 404 下也要发出" }).waitFor();

      await page.getByRole("button", { name: /切换智能体/ }).click();
      // No advisor model (config GET 404): 顾问 is disabled with the reason, no doomed save is sent.
      const advisorBtn = page.locator('[data-product-feature="advisor-mode"]');
      assert.equal(await advisorBtn.isDisabled(), true, "advisor must be disabled without a model");
      assert.match(await advisorBtn.innerText(), /暂时没有可用的顾问型号/);
      const putsBefore = calls.filter((row) => row.kind === "collab" && row.method === "PUT").length;
      await advisorBtn.click({ force: true });
      await page.waitForTimeout(300);
      assert.equal(calls.filter((row) => row.kind === "collab" && row.method === "PUT").length, putsBefore);
      const soloPut = putDone();
      await page.getByRole("button", { name: /主模型独立完成/ }).click();
      await soloPut;
      await page.waitForTimeout(200);
      assert.equal(await pressed(/主模型独立完成/), "true", "solo must stick after a 404 save");
      await page.getByRole("dialog").getByText(/协作配置保存失败/).waitFor();
      assert.equal(await page.getByRole("dialog").getByText(/协作配置保存失败/).count(), 1, "persistence failure stays visible while the solo choice remains selected");

      const teamPut = putDone();
      await page.getByRole("button", { name: /队长切换为/ }).click();
      await teamPut;
      await page.waitForTimeout(200);
      assert.equal(await pressed(/队长切换为/), "true", "team must stick after a 404 save");
      assert.ok(calls.filter((row) => row.kind === "collab" && row.method === "PUT").length >= 3);
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error("page errors:", errors, "calls:", calls, "body:", (await page.locator("body").innerText()).slice(-2000));
      throw error;
    } finally {
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
});
