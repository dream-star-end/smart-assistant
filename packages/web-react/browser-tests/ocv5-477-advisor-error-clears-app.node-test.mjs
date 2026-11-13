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

test("a failed advisor save shows inline only and no error is left after a later successful save", { timeout: 120_000 }, async () => {
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
        calls.push({ kind: "collab", method });
        const doc = (mode, rev) => ({
          rev,
          defaultMode: "solo",
          defaultAdvisorModel: null,
          session: { mode, advisorModel: null, configVersion: `v1:${mode}:`, source: "session" },
          advisorModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" }],
          advisorConsultParents: ["ccb"],
          advisorConsultAllowed: true,
          parentEngine: "ccb",
        });
        const data = method === "PUT" ? (req.postDataJSON() ?? {}) : {};
        if (method === "GET") body = doc("solo", 0);
        else if (data.mode === "advisor") {
          status = 503;
          body = { error: { code: "UPSTREAM", message: "advisor unavailable" }, requestId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
        } else body = doc(data.mode, 1);
      } else if (path.startsWith("/api/sessions")) body = { ok: true };
      else body = {};
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    const putDone = () =>
      page.waitForResponse((res) => res.url().includes("/api/collaboration-config") && res.request().method() === "PUT").then((res) => res.status());
    const pressed = (name) => page.getByRole("button", { name }).getAttribute("aria-pressed");
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.getByRole("button", { name: /切换智能体/ }).waitFor();
      // A real session so every switch is a server save.
      await page.getByPlaceholder(/和「全能助手」对话/).fill("先建一个会话");
      await page.getByRole("button", { name: "发送" }).click();
      await page.getByTestId("queued-send-row").filter({ hasText: "先建一个会话" }).waitFor();
      await page.getByRole("button", { name: /切换智能体/ }).click();
      const advisorBtn = page.locator('[data-product-feature="advisor-mode"]');
      await page.waitForFunction(() => {
        const b = document.querySelector('[data-product-feature="advisor-mode"]');
        return b && !b.hasAttribute("disabled");
      });
      const advisorPut = putDone();
      await advisorBtn.click();
      assert.equal(await advisorPut, 503);
      await page.waitForTimeout(300);
      const dialog = page.getByRole("dialog");
      assert.equal(await dialog.getByText(/协作配置保存失败/).count(), 1, "inline error in the picker");
      assert.equal(await page.getByText(/协作配置保存失败/).count(), 1, "no extra error toast outside the picker");
      assert.equal(await pressed(/主模型独立完成/), "true", "advisor failure rolls back to solo");
      await page.getByRole("button", { name: /队长切换为/ }).click();
      await page.waitForTimeout(150);
      const soloPut = putDone();
      await page.getByRole("button", { name: /主模型独立完成/ }).click();
      assert.equal(await soloPut, 200);
      await page.waitForTimeout(300);
      assert.equal(await page.getByText(/协作配置保存失败/).count(), 0, "no stale save error after a successful save");
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
