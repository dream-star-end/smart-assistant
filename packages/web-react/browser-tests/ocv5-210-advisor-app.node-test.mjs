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

test("actual App new-session advisor/team send materializes session before collab PUT", { timeout: 120_000 }, async () => {
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
      const data = req.postDataJSON() ?? {};
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
      } else if (/^\/api\/sessions\/[^/]+$/.test(path) && method === "PUT") {
        const id = path.split("/").at(-1);
        owned.add(id);
        calls.push({ kind: "session", id, modelId: data.modelId });
        body = { ok: true };
      } else if (path === "/api/collaboration-config" && method === "GET") {
        body = {
          rev: 0,
          defaultMode: "solo",
          defaultAdvisorModel: "gpt-6-astra",
          session: { mode: "solo", advisorModel: null, configVersion: "v1:solo:", source: "default" },
          advisorModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" }],
          advisorConsultParents: ["ccb"],
          advisorConsultParentReason: "一期仅 CCB 主会话可咨询顾问。",
        };
      } else if (path === "/api/collaboration-config" && method === "PUT") {
        if (data.sessionId && !owned.has(data.sessionId)) {
          status = 404;
          body = { error: "session not found" };
        } else {
          calls.push({ kind: "collab", sessionId: data.sessionId, mode: data.mode, asDefault: data.asDefault === true });
          body = {
            rev: 1,
            defaultMode: data.asDefault ? data.mode : "solo",
            defaultAdvisorModel: data.mode === "advisor" ? data.advisorModel : null,
            session: {
              mode: data.mode,
              advisorModel: data.advisorModel ?? null,
              configVersion: data.mode === "advisor" ? `v1:advisor:${data.advisorModel}` : `v1:${data.mode}:`,
              source: "session",
            },
            advisorModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" }],
            advisorConsultParents: ["ccb"],
            advisorConsultAllowed: true,
            parentEngine: "ccb",
          };
        }
      } else if (path.startsWith("/api/sessions")) body = { ok: true };
      else body = {};
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.getByRole("button", { name: /切换智能体/ }).waitFor();
      await page.getByRole("button", { name: /切换智能体/ }).click();
      await page.getByRole("button", { name: /主模型不切换/ }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByPlaceholder(/和「全能助手」对话/).fill("顾问首发不要 404");
      await page.getByRole("button", { name: "发送" }).click();
      await page.getByTestId("user-row").waitFor();
      const sessionIdx = calls.findIndex((row) => row.kind === "session");
      const collabIdx = calls.findIndex((row) => row.kind === "collab" && row.mode === "advisor");
      assert.ok(sessionIdx >= 0, "must PUT client session");
      assert.ok(collabIdx >= 0, "must PUT collaboration config");
      assert.ok(sessionIdx < collabIdx, `session PUT must precede collab PUT: ${JSON.stringify(calls)}`);
      assert.equal(calls[collabIdx].asDefault, false);
      assert.equal(calls[collabIdx].sessionId, calls[sessionIdx].id);
      assert.deepEqual(errors, []);

      await page.getByRole("button", { name: "新建会话" }).click();
      await page.getByRole("button", { name: /切换智能体/ }).click();
      await page.getByRole("button", { name: /队长切 Astra/ }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByPlaceholder(/和「全能助手」对话/).fill("团队首发不要 404");
      await page.getByRole("button", { name: "发送" }).click();
      await page.getByTestId("user-row").filter({ hasText: "团队首发不要 404" }).waitFor();
      const teamSession = calls.map((row, i) => ({ ...row, i })).filter((row) => row.kind === "session");
      const teamCollab = calls.find((row) => row.kind === "collab" && row.mode === "team");
      assert.ok(teamCollab, "team collab PUT");
      assert.ok(teamSession.some((row) => row.id === teamCollab.sessionId && row.i < calls.indexOf(teamCollab)));
      assert.equal(teamCollab.asDefault, false);
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
