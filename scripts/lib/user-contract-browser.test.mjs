import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { launchJourneyBrowser } from "./journey-browser.mjs";
import { coldUiLogin } from "./user-contract-browser.mjs";

async function fixture(status) {
  const server = createServer((req, res) => {
    if (req.url === "/api/auth/login") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(status !== 200 ? "unavailable" : `<!doctype html><div id="root"></div>
      <script>setTimeout(() => {
        document.getElementById('root').innerHTML =
          '<button>登录</button><form><input type="email"><input type="password">' +
          '<button>登录</button></form><button>新建会话</button><textarea></textarea>';
        document.querySelector('form').addEventListener('submit', e => {
          e.preventDefault(); fetch('/api/auth/login', { method: 'POST' });
        });
      }, 25000);</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("cold UI login waits for a delayed real button rather than bypassing login",
  { timeout: 75_000 }, async () => {
    const { server, base } = await fixture(200);
    let browser;
    try {
      browser = await launchJourneyBrowser();
      const context = await browser.newContext({ serviceWorkers: "block" });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await coldUiLogin(page, { base, email: "canary@example.invalid" }, "synthetic");
      assert.equal(await page.locator("textarea").count(), 1);
    } finally {
      await browser?.close().catch(() => {});
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

test("cold UI login fails immediately on a non-200 landing page", async () => {
  const { server, base } = await fixture(503);
  let browser;
  try {
    browser = await launchJourneyBrowser();
    const page = await browser.newPage();
    await assert.rejects(() => coldUiLogin(page,
      { base, email: "canary@example.invalid" }, "synthetic"),
    /Cold landing HTTP 503/);
  } finally {
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cold UI login failure names the failed scripts and what the page shows (OCV5-437)",
  { timeout: 30_000 }, async () => {
    const server = createServer((req, res) => {
      if (req.url.startsWith("/assets/reset-")) { req.socket.destroy(); return; }
      if (req.url.startsWith("/assets/gone-")) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><div id="root"><div>正在加载</div></div>
        <script src="/assets/reset-a1.js?token=s3cret"></script>
        <script src="/assets/gone-b2.js"></script>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
      browser = await launchJourneyBrowser();
      const page = await browser.newPage();
      const error = await coldUiLogin(page,
        { base, email: "canary@example.invalid", renderTimeoutMs: 3_000 }, "synthetic")
        .then(() => null, (e) => e);
      assert.ok(error, "cold login must fail without a login button");
      const detail = JSON.parse(error.message.replace(/^Cold login not rendered: /, ""));
      assert.equal(detail.failedScripts, 2);
      assert.equal(detail.rootText, "正在加载");
      assert.ok(detail.scriptFailures.some((s) => /^\/assets\/reset-a1\.js net::ERR_/.test(s)), detail.scriptFailures.join(" | "));
      assert.ok(detail.scriptFailures.some((s) => /^\/assets\/gone-b2\.js .*HTTP 404/.test(s)), detail.scriptFailures.join(" | "));
      assert.doesNotMatch(error.message, /s3cret|token=/);
    } finally {
      await browser?.close().catch(() => {});
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
