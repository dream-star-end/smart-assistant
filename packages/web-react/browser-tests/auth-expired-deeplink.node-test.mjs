// INC-20261030-REFRESH-UNDELIVERED-SETCOOKIE, user-visible half, in a real browser.
// A browser that had logged in (oc_auth_hint) reopens /p/<project> and its boot refresh
// is explicitly INVALID_REFRESH. It must say 登录已过期 and show the login form instead of
// the marketing landing, keep /p/p1 in the address bar, and return there after login.
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

test("expired boot refresh on /p/p1 shows 登录已过期 and login returns to the project", { timeout: 120_000 }, async () => {
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
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    const calls = [];
    let loggedIn = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.WebSocket = undefined;
      localStorage.setItem("oc_auth_hint", "1");
    });
    const user = { id: "u2", email: "b@example.com", email_verified: true, role: "user", display_name: "Bob", avatar_url: null, credits: "300", created_at: "2026-01-01T00:00:00.000Z" };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      calls.push(path);
      let status = 200;
      let body = {};
      if (path === "/api/public/config") body = { turnstile_site_key: "", turnstile_bypass: true, require_email_verified: false, allow_registration: true };
      else if (path === "/api/auth/refresh") {
        if (loggedIn) body = { access_token: "fixture-access", access_exp: Math.floor(Date.now() / 1000) + 3600, remember: true };
        else {
          status = 401;
          body = { error: { code: "INVALID_REFRESH", message: "refresh token invalid or expired" } };
        }
      } else if (path === "/api/auth/login") {
        loggedIn = true;
        body = { user, access_token: "fixture-access", access_exp: Math.floor(Date.now() / 1000) + 3600, refresh_exp: Math.floor(Date.now() / 1000) + 86_400, remember: true };
      } else if (path === "/api/me") body = { user };
      else if (path === "/api/public/models") body = { models: [{ id: "glm-5.2", display_name: "GLM-5.2", engine: "ccb" }] };
      else if (path === "/api/me/preferences") body = { prefs: {} };
      else if (path === "/api/agent/status") body = { runtime_ready: true, container: { id: "c1", status: "running" }, subscription: { status: "active" } };
      else if (path === "/api/chat-projects") body = { projects: [{ id: "p1", name: "论文综述", sortOrder: 0, createdAt: 1, updatedAt: 1, sessionCount: 0 }] };
      else if (path === "/api/sessions/list") body = { sessions: [] };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/p/p1`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.getByText("登录已过期，请重新登录").waitFor();
      await page.getByLabel("邮箱").waitFor();
      assert.equal(await page.getByRole("button", { name: "免费开始" }).count(), 0, "must not fall back to the marketing landing");
      assert.equal(await page.getByText("网络较慢，正在加载…").count(), 0, "boot refresh must not claim a slow network");
      assert.equal(new URL(page.url()).pathname, "/p/p1", "the deep link stays in the address bar");
      assert.ok(calls.includes("/api/auth/refresh"));

      await page.getByLabel("邮箱", { exact: true }).fill("b@example.com");
      await page.getByLabel("密码", { exact: true }).fill("fixture password");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByTestId("project-home").waitFor();
      assert.equal(new URL(page.url()).pathname, "/p/p1", "login returns to the project");
      assert.equal(await page.getByText("登录已过期，请重新登录").count(), 0);
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error("page errors:", errors, "calls:", calls, "url:", page.url(), "body:", (await page.locator("body").innerText()).slice(-2000));
      throw error;
    } finally {
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
});
