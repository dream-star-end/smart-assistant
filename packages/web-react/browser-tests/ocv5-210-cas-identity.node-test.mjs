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

function collabDoc(over = {}) {
  return {
    rev: 1,
    defaultMode: "solo",
    defaultAdvisorModel: "gpt-6-astra",
    session: { mode: "solo", advisorModel: null, configVersion: "v1:solo:", source: "default" },
    advisorModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" }],
    advisorConsultParents: ["ccb"],
    advisorConsultAllowed: true,
    parentEngine: "ccb",
    ...over,
  };
}

test("CAS reread failure after account switch does not send previous team as the new identity", { timeout: 120_000 }, async () => {
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
    page.setDefaultTimeout(20_000);
    const errors = [];
    const calls = [];
    let casArmed = false;
    let releaseReread;
    const hangReread = new Promise((resolve) => {
      releaseReread = resolve;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.WebSocket = undefined;
    });
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const method = req.method();
      const token = String(req.headers()["authorization"] ?? req.headers()["Authorization"] ?? "").replace(/^Bearer\s+/i, "");
      const data = req.postDataJSON() ?? {};
      let body = {};
      let status = 200;
      const userA = { id: "u1", email: "a@b.com", email_verified: true, role: "user", display_name: "Alice", credits: "1000" };
      const userB = { id: "u2", email: "b@c.com", email_verified: true, role: "user", display_name: "Bob", credits: "1000" };
      if (path === "/api/public/config") body = { turnstile_bypass: true, require_email_verified: false, allow_registration: true };
      else if (path === "/api/auth/refresh") {
        status = 400;
        body = { error: { code: "VALIDATION", message: "refresh_token is required" } };
      } else if (path === "/api/auth/login") {
        const email = data.email;
        body = email === "b@c.com"
          ? { user: userB, access_token: "tok-b", access_exp: Date.now() / 1000 + 3600, remember: false }
          : { user: userA, access_token: "tok-1", access_exp: Date.now() / 1000 + 3600, remember: false };
      } else if (path === "/api/me") body = { user: token === "tok-b" ? userB : userA };
      else if (path === "/api/public/models") {
        body = { models: [{ id: "glm-5.2", display_name: "GLM-5.2", engine: "ccb" }] };
      } else if (path === "/api/me/preferences") body = { prefs: { default_model: "glm-5.2" } };
      else if (path === "/api/agent/status") {
        body = { runtime_ready: true, container: { id: "c1", status: "running" }, subscription: { status: "active" } };
      } else if (path === "/api/sessions/list") body = { sessions: [] };
      else if (path === "/api/marketplace/my-agents") {
        body = { agents: [{ id: "main", slug: "main", name: "全能助手", installed: true, isDefault: true }] };
      } else if (/^\/api\/sessions\/[^/]+$/.test(path) && method === "PUT") {
        body = { ok: true, applied: true };
      } else if (path === "/api/collaboration-config" && method === "GET") {
        if (casArmed && token === "tok-1") {
          await hangReread;
          body = collabDoc({
            session: { mode: "team", advisorModel: null, configVersion: "v1:team:", source: "session" },
            defaultMode: "team",
          });
        } else if (token === "tok-b") {
          body = collabDoc();
        } else {
          body = collabDoc({
            session: { mode: "team", advisorModel: null, configVersion: "v1:team:", source: "default" },
            defaultMode: "team",
          });
        }
      } else if (path === "/api/collaboration-config" && method === "PUT") {
        calls.push({ token, mode: data.mode, asDefault: data.asDefault === true, sessionId: data.sessionId });
        if (data.mode === "solo" && data.asDefault === true) {
          casArmed = true;
          status = 409;
          body = { error: "cas conflict" };
        } else {
          body = collabDoc({
            rev: 2,
            session: {
              mode: data.mode,
              advisorModel: data.advisorModel ?? null,
              configVersion: `v1:${data.mode}:`,
              source: data.sessionId ? "session" : "default",
            },
          });
        }
      } else if (path.startsWith("/api/sessions")) body = { ok: true };
      else body = {};
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByPlaceholder("邮箱").fill("a@b.com");
      await page.getByPlaceholder("密码").fill("password123");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("button", { name: /切换智能体/ }).waitFor();
      await page.getByPlaceholder(/和「全能助手」对话/).fill("A 开场");
      await page.getByRole("button", { name: "发送" }).click();
      await page.getByTestId("user-row").filter({ hasText: "A 开场" }).waitFor();
      await page.getByRole("button", { name: /切换智能体/ }).click();
      await page.getByRole("button", { name: /队长切 Astra/ }).waitFor();
      assert.equal(await page.getByRole("button", { name: /队长切 Astra/ }).getAttribute("aria-pressed"), "true");
      await page.getByLabel(/同时作为新会话默认/).check();
      await page.getByRole("button", { name: /主模型独立完成/ }).click();
      const armedAt = Date.now();
      while (!casArmed && Date.now() - armedAt < 10_000) {
        await page.waitForTimeout(50);
      }
      assert.equal(casArmed, true, "solo+asDefault PUT must 409");
      await page.getByRole("button", { name: "关闭" }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "账号菜单" }).click();
      await page.getByRole("menuitem", { name: "退出登录" }).click();
      await page.getByRole("button", { name: "登录", exact: true }).waitFor();
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByPlaceholder("邮箱").fill("b@c.com");
      await page.getByPlaceholder("密码").fill("password123");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("button", { name: /切换智能体/ }).waitFor();
      await page.getByRole("button", { name: /切换智能体/ }).click();
      assert.equal(await page.getByRole("button", { name: /主模型独立完成/ }).getAttribute("aria-pressed"), "true");
      assert.equal(await page.getByRole("button", { name: /队长切 Astra/ }).getAttribute("aria-pressed"), "false");
      const before = calls.filter((row) => row.token === "tok-b").length;
      releaseReread();
      await page.waitForTimeout(400);
      assert.equal(await page.getByRole("button", { name: /主模型独立完成/ }).getAttribute("aria-pressed"), "true");
      assert.equal(await page.getByRole("button", { name: /队长切 Astra/ }).getAttribute("aria-pressed"), "false");
      await page.keyboard.press("Escape");
      await page.getByPlaceholder(/和「全能助手」对话/).fill("B 新消息");
      await page.getByRole("button", { name: "发送" }).click();
      await page.getByTestId("user-row").filter({ hasText: "B 新消息" }).waitFor();
      const bPuts = calls.filter((row) => row.token === "tok-b").slice(before);
      assert.equal(bPuts.some((row) => row.mode === "team" || row.asDefault === true), false);
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
