import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");

const NEGATIVE_SHA = "87d4554efd27289844cfb3ce0146fb713ce24954";
const NEGATIVE_HASHES = {
  "lib/composerDraft.ts": "5e4032bdbb6041f4b10c11eb310702a49fcac5c58130c7ad7cb26a4c37f12757",
  "hooks/useAuth.ts": "c5b2098b860633cd03e2cc598b548b669de89170a1901df81e14296e18fb3cc2",
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Content provenance stays truthful when CI later runs a different Git commit.
// A pinned negative control must verify its bytes before claiming the old SHA.
function sourceEvidence() {
  const baseline = process.env.OC_DRAFT_AUTH_BASELINE;
  const sourceHashes = {};
  for (const [relative, expected] of Object.entries(NEGATIVE_HASHES)) {
    const path = baseline
      ? join(baseline, relative)
      : fileURLToPath(new URL(`../src/${relative}`, import.meta.url));
    sourceHashes[relative] = sha256(readFileSync(path));
    if (baseline) assert.equal(sourceHashes[relative], expected, `negative-control source drift: ${relative}`);
  }
  for (const relative of ["components/Composer.tsx", "hooks/useComposerDraft.ts"]) {
    sourceHashes[relative] = sha256(readFileSync(new URL(`../src/${relative}`, import.meta.url)));
  }
  return {
    mode: baseline ? "pinned-negative-with-current-component" : "current-worktree",
    pinnedModulesCommit: baseline ? NEGATIVE_SHA : null,
    sourceHashes,
    harnessSha256: sha256(readFileSync(new URL("./draft-auth-isolation-harness.tsx", import.meta.url))),
    testSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  };
}

function textEvidence(value) {
  return typeof value === "string"
    ? { chars: value.length, utf8Bytes: Buffer.byteLength(value, "utf8"), empty: value === "", sha256: sha256(value) }
    : { type: typeof value, value };
}

function expectText(actual, expected, label) {
  // Exact equality is retained; only diagnostics are compact and content-free.
  assert.equal(actual === expected, true,
    `${label}; ${JSON.stringify({ expected: textEvidence(expected), actual: textEvidence(actual) })}`);
}

function baselinePlugin(baselineRoot) {
  return {
    name: "pinned-draft-auth-negative-control",
    setup(esbuildApi) {
      esbuildApi.onLoad(
        { filter: /[\\/]src[\\/](lib[\\/]composerDraft|hooks[\\/]useAuth)\.ts$/ },
        (args) => {
          const pinned = args.path.endsWith("composerDraft.ts")
            ? join(baselineRoot, "lib", "composerDraft.ts")
            : join(baselineRoot, "hooks", "useAuth.ts");
          return {
            contents: readFileSync(pinned, "utf8"),
            loader: "ts",
            resolveDir: dirname(args.path),
          };
        },
      );
    },
  };
}

async function bundleHarness() {
  const plugins = process.env.OC_DRAFT_AUTH_BASELINE
    ? [baselinePlugin(process.env.OC_DRAFT_AUTH_BASELINE)]
    : [];
  return build({
    entryPoints: [fileURLToPath(new URL("./draft-auth-isolation-harness.tsx", import.meta.url))],
    plugins,
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: {
      "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)),
      "@openclaude/protocol": fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url)),
    },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"' },
  });
}

async function fillComposer(page, text) {
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.waitFor();
  await input.fill(text);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  return input;
}

test("Composer drafts isolate across real useAuth login/logout (Chromium, stubbed auth network)", { timeout: 180_000 }, async (t) => {
  const sources = sourceEvidence();
  t.diagnostic(`draft-auth-sources ${JSON.stringify(sources)}`);
  const bundle = await bundleHarness();
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });

    async function openPage() {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      return { context, page, errors };
    }

    await t.test("persistent new draft: logout then B first-read is empty", async () => {
      const { context, page, errors } = await openPage();
      const evidence = {
        contractId: "F5-PERSIST-A-LOGOUT-B-FIRST-READ", status: "failed",
        expected: { aPersisted: true, bFirstReadEmpty: true, aAfterLogoutEmpty: true, bareNewEmpty: true, bInputEmpty: true, pageErrors: 0 },
        actual: {},
      };
      try {
        const marker = `OCV5-188-F5-A-PERSIST-${Date.now()}`;
        await page.getByRole("button", { name: "login A", exact: true }).click();
        await page.getByTestId("account").filter({ hasText: "user-a" }).waitFor();
        const input = await fillComposer(page, marker);
        expectText(await input.inputValue(), marker, "A input contains the exact body");
        const before = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          const aKey = p.accountDraftKey(p.newKey, "user-a");
          return {
            aKey,
            aRead: p.readDraft(aKey),
            aStored: p.sessionItem(aKey),
            keys: p.allDraftStorageKeys(),
            draftKey: document.querySelector('[data-testid="draft-key"]')?.textContent ?? "",
            fetches: window.__authFetches.slice(),
          };
        });
        evidence.actual.before = { aKey: before.aKey, aRead: textEvidence(before.aRead), aStored: textEvidence(before.aStored) };
        expectText(before.aRead, marker, "A readDraft must prove the unique body exists before logout");
        expectText(before.aStored, marker, "A body must be persisted before logout");
        assert.equal(before.draftKey, before.aKey);
        assert.ok(before.fetches.some((f) => f.url.includes("/api/auth/login") && f.email === "a@example.test"));

        await page.getByRole("button", { name: "logout", exact: true }).click();
        await page.getByTestId("authed").filter({ hasText: "0" }).waitFor();
        assert.equal(await page.getByRole("textbox", { name: "消息输入框" }).count(), 0, "Composer must unmount before B login");

        const afterLogout = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          const aKey = p.accountDraftKey(p.newKey, "user-a");
          const bKey = p.accountDraftKey(p.newKey, "user-b");
          return {
            bFirstRead: p.readDraft(bKey),
            aRead: p.readDraft(aKey),
            bareNew: p.readDraft(p.newKey),
            aStored: p.sessionItem(aKey),
            bareStored: p.sessionItem(p.newKey),
            keys: p.allDraftStorageKeys(),
            fetches: window.__authFetches.slice(),
          };
        });
        evidence.actual.afterLogout = {
          bFirstRead: textEvidence(afterLogout.bFirstRead), aRead: textEvidence(afterLogout.aRead),
          bareNew: textEvidence(afterLogout.bareNew), aStorageEmpty: afterLogout.aStored === null,
          bareStorageEmpty: afterLogout.bareStored === null, remainingDraftKeys: afterLogout.keys,
          logoutRequests: afterLogout.fetches.filter((f) => f.url.includes("/api/auth/logout")).length,
        };
        expectText(afterLogout.bFirstRead, "", "B new must be empty on first read, before any B write/clear/fill");
        expectText(afterLogout.aRead, "", "A persistent body must be gone after logout");
        expectText(afterLogout.bareNew, "", "legacy bare-new draft must be gone");
        assert.equal(afterLogout.aStored, null);
        assert.equal(afterLogout.bareStored, null);
        assert.ok(afterLogout.fetches.some((f) => f.url.includes("/api/auth/logout")));

        await page.getByRole("button", { name: "login B", exact: true }).click();
        await page.getByTestId("account").filter({ hasText: "user-b" }).waitFor();
        const bInput = page.getByRole("textbox", { name: "消息输入框" });
        await bInput.waitFor();
        const bValue = await bInput.inputValue();
        evidence.actual.bInput = textEvidence(bValue);
        expectText(bValue, "", "B input must be empty after real login");
        assert.equal(bValue.includes(marker), false);
        const bKey = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          return p.accountDraftKey(p.newKey, "user-b");
        });
        assert.equal(await page.getByTestId("draft-key").textContent(), bKey);
        assert.equal(await page.evaluate(() => window.__authFetches.filter((f) => f.url.includes("/api/auth/login") && f.email === "b@example.test").length), 1);
        assert.deepEqual(errors, []);
        evidence.status = "passed";
      } finally {
        evidence.actual.pageErrors = errors.length;
        t.diagnostic(`draft-auth-result ${JSON.stringify(evidence)}`);
        await context.close();
      }
    });

    await t.test("volatile >20KiB draft: logout clears A read, then B is empty", async () => {
      const { context, page, errors } = await openPage();
      const evidence = {
        contractId: "F5-VOLATILE-A-LOGOUT-B-FIRST-READ", status: "failed",
        expected: { inputBytesGreaterThan: 20 * 1024, aReadExact: true, aStorageEmpty: true, aAfterLogoutEmpty: true, bFirstReadEmpty: true, bInputEmpty: true, pageErrors: 0 },
        actual: {},
      };
      try {
        const unique = `OCV5-188-F5-A-VOL-${Date.now()}-`;
        const text = unique + "x".repeat(20 * 1024 + 32);
        assert.ok(new Blob([text]).size > 20 * 1024);
        await page.getByRole("button", { name: "login A", exact: true }).click();
        await page.getByTestId("account").filter({ hasText: "user-a" }).waitFor();
        const input = await fillComposer(page, text);
        expectText(await input.inputValue(), text, "A input contains the exact >20KiB body");
        const before = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          const aKey = p.accountDraftKey(p.newKey, "user-a");
          return {
            aRead: p.readDraft(aKey),
            aStored: p.sessionItem(aKey),
            input: document.querySelector('[aria-label="消息输入框"]')?.value ?? "",
          };
        });
        evidence.actual.before = { aRead: textEvidence(before.aRead), input: textEvidence(before.input), aStorageEmpty: before.aStored === null };
        expectText(before.aRead, text, "volatile A readDraft must return the full body");
        expectText(before.input, text, "volatile A input must contain the full body");
        assert.equal(before.aStored, null, "sessionStorage A key empty is the positive proof of the volatile path");

        await page.getByRole("button", { name: "logout", exact: true }).click();
        await page.getByTestId("authed").filter({ hasText: "0" }).waitFor();
        const afterLogout = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          const aKey = p.accountDraftKey(p.newKey, "user-a");
          const bKey = p.accountDraftKey(p.newKey, "user-b");
          return {
            aRead: p.readDraft(aKey),
            bFirstRead: p.readDraft(bKey),
            aStored: p.sessionItem(aKey),
          };
        });
        evidence.actual.afterLogout = { aRead: textEvidence(afterLogout.aRead), bFirstRead: textEvidence(afterLogout.bFirstRead), aStorageEmpty: afterLogout.aStored === null };
        expectText(afterLogout.aRead, "", "A read empty after logout proves volatile teardown, B empty alone is not enough");
        expectText(afterLogout.bFirstRead, "", "volatile B first read must be empty");
        assert.equal(afterLogout.aStored, null);

        await page.getByRole("button", { name: "login B", exact: true }).click();
        await page.getByTestId("account").filter({ hasText: "user-b" }).waitFor();
        const bInput = page.getByRole("textbox", { name: "消息输入框" });
        await bInput.waitFor();
        const bValue = await bInput.inputValue();
        evidence.actual.bInput = textEvidence(bValue);
        expectText(bValue, "", "volatile B input must be empty after real login");
        assert.equal(bValue.includes(unique), false);
        assert.deepEqual(errors, []);
        evidence.status = "passed";
      } finally {
        evidence.actual.pageErrors = errors.length;
        t.diagnostic(`draft-auth-result ${JSON.stringify(evidence)}`);
        await context.close();
      }
    });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
