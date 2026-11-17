import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

// OCV5-778 / INC-20261117-DROPDOWN-SHORT-VIEWPORT-CLIP:
// On short landscape touch viewports (e.g. 640x320), opening the sidebar ProjectRow「⋯」menu
// flipped the 8-item menu above the trigger (side="top") and clipped the top item「新建会话」outside the viewport.
// OC_DROPDOWN_RED_REF=<git ref> swaps DropdownMenu.tsx from that ref as a negative control.
// OC_DROPDOWN_SHOTS=<dir> writes verification screenshots.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const dropdownPath = resolve(here, "../src/components/ui/DropdownMenu.tsx");
const redRef = process.env.OC_DROPDOWN_RED_REF || "";
const shotsDir = process.env.OC_DROPDOWN_SHOTS || "";

async function bundle(assetDir) {
  let swapped = 0;
  await build({
    entryPoints: [join(here, "dropdown-short-viewport-harness.tsx")],
    bundle: true,
    format: "iife",
    outfile: join(assetDir, "app.js"),
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}',
    },
    plugins: redRef
      ? [
          {
            name: "dropdown-from-ref",
            setup(b) {
              b.onLoad({ filter: /[\\/]ui[\\/]DropdownMenu\.tsx$/ }, ({ path }) => {
                assert.equal(resolve(path), dropdownPath);
                swapped += 1;
                const rel = "packages/web-react/src/components/ui/DropdownMenu.tsx";
                const contents = execFileSync("git", ["show", `${redRef}:${rel}`], {
                  cwd: here,
                  encoding: "utf8",
                });
                return { contents, loader: "tsx", resolveDir: dirname(path) };
              });
            },
          },
        ]
      : [],
    logLevel: "warning",
  });
  assert.equal(swapped, redRef ? 1 : 0);

  const entry = join(assetDir, "entry.css");
  writeFileSync(
    entry,
    `@import ${JSON.stringify(resolve(here, "../src/styles.css"))};\n@source ${JSON.stringify(join(assetDir, "app.js"))};\n`,
  );
  const entryJs = join(assetDir, "entry.ts");
  writeFileSync(entryJs, `import ${JSON.stringify(entry)};\n`);
  const cssDir = join(assetDir, "css-build");
  mkdirSync(cssDir);
  await viteBuild({
    root: join(here, ".."),
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: {
      outDir: cssDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: { input: entryJs, output: { assetFileNames: "styles[extname]" } },
    },
  });
  writeFileSync(
    join(assetDir, "styles.css"),
    readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))),
  );
}

test(
  "OCV5-778: short landscape touch viewport keeps ProjectRow「新建会话」visible and scrollable inside viewport (INC-20261117-DROPDOWN-SHORT-VIEWPORT-CLIP)",
  { timeout: 180000 },
  async (t) => {
    const assetDir = mkdtempSync(join(tmpdir(), "oc-dropdown-short-"));
    t.after(() => rmSync(assetDir, { recursive: true, force: true }));
    await bundle(assetDir);

    const server = createServer((req, res) => {
      const file = { "/": null, "/app.js": "app.js", "/styles.css": "styles.css" }[req.url];
      if (file === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (file === null) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css"><body class="bg-bg"><div id="root"></div><script src="/app.js"></script>',
        );
        return;
      }
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/css");
      res.end(readFileSync(join(assetDir, file)));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => server.close(done)));
    const url = `http://127.0.0.1:${server.address().port}/`;

    const browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());

    const saveShot = async (page, name) => {
      if (!shotsDir) return;
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, `${redRef ? "before" : "after"}-${name}.png`) });
    };

    await t.test("landscape touch 640x320: flipped top menu & downward bottom menu both keep「新建会话」visible and scroll to「删除」", async () => {
      const context = await browser.newContext({
        viewport: { width: 640, height: 320 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(url);
        await page.getByTestId("row-target").waitFor();
        assert.equal(await page.evaluate(() => matchMedia("(hover: none)").matches), true);

        // 1) Lower-half row「外协采购」: Radix flips side="top" (the exact user screenshot reproduction).
        await page.getByRole("button", { name: "项目 外协采购 更多" }).tap();
        const menu = page.getByRole("menu");
        await menu.waitFor();
        await page.waitForTimeout(150);
        await saveShot(page, "landscape-flipped-top");

        const initial = await page.evaluate(() => {
          const menuEl = document.querySelector("[role='menu']");
          const items = [...menuEl.querySelectorAll("[role='menuitem']")];
          const first = items.find((el) => el.textContent?.includes("新建会话"));
          const last = items.find((el) => el.textContent?.includes("删除"));
          const mr = menuEl.getBoundingClientRect();
          const fr = first.getBoundingClientRect();
          const lr = last.getBoundingClientRect();
          return {
            side: menuEl.getAttribute("data-side"),
            viewportHeight: window.innerHeight,
            menu: { top: mr.top, bottom: mr.bottom, clientHeight: menuEl.clientHeight, scrollHeight: menuEl.scrollHeight },
            first: { top: fr.top, bottom: fr.bottom, height: fr.height },
            last: { top: lr.top, bottom: lr.bottom },
          };
        });

        assert.equal(initial.side, "top", "lower-half row flips menu above trigger");
        assert.ok(initial.first.height >= 43.5, `touch menu item keeps 44px hit target (${initial.first.height})`);
        assert.ok(initial.menu.top >= 7.5, `flipped menu top (${initial.menu.top}) is not clipped above viewport`);
        assert.ok(
          initial.menu.bottom <= initial.viewportHeight - 7.5,
          `menu bottom (${initial.menu.bottom}) stays inside viewport (${initial.viewportHeight})`,
        );
        assert.ok(
          initial.menu.scrollHeight > initial.menu.clientHeight,
          `menu scrolls vertically when taller than available height (${initial.menu.scrollHeight} > ${initial.menu.clientHeight})`,
        );
        assert.ok(
          initial.first.top >= initial.menu.top - 0.5 && initial.first.bottom <= initial.menu.bottom + 0.5,
          `first item「新建会话」(${initial.first.top}..${initial.first.bottom}) is immediately visible inside menu (${initial.menu.top}..${initial.menu.bottom})`,
        );

        // Scroll to bottom of menu and verify「删除」becomes fully visible inside the menu box.
        const afterScroll = await page.evaluate(() => {
          const menuEl = document.querySelector("[role='menu']");
          menuEl.scrollTop = menuEl.scrollHeight;
          const items = [...menuEl.querySelectorAll("[role='menuitem']")];
          const last = items.find((el) => el.textContent?.includes("删除"));
          const mr = menuEl.getBoundingClientRect();
          const lr = last.getBoundingClientRect();
          return {
            scrollTop: menuEl.scrollTop,
            menu: { top: mr.top, bottom: mr.bottom },
            last: { top: lr.top, bottom: lr.bottom },
          };
        });
        await saveShot(page, "landscape-scrolled-bottom");
        assert.ok(afterScroll.scrollTop > 0, "menu scrollTop advances");
        assert.ok(
          afterScroll.last.top >= afterScroll.menu.top - 0.5 && afterScroll.last.bottom <= afterScroll.menu.bottom + 0.5,
          `last item「删除」(${afterScroll.last.top}..${afterScroll.last.bottom}) scrolls fully into menu view (${afterScroll.menu.top}..${afterScroll.menu.bottom})`,
        );

        // Scroll back to top and tap「新建会话」to prove real action execution.
        await page.evaluate(() => {
          document.querySelector("[role='menu']").scrollTop = 0;
        });
        await page.getByRole("menuitem", { name: "新建会话" }).tap();
        assert.equal(await page.getByTestId("last-action").textContent(), "new-session");

        // 2) Upper-half row「四维时空」: opens side="bottom" and also stays inside viewport.
        await page.getByRole("button", { name: "项目 四维时空 更多" }).tap();
        await menu.waitFor();
        await page.waitForTimeout(150);
        const upper = await page.evaluate(() => {
          const menuEl = document.querySelector("[role='menu']");
          const mr = menuEl.getBoundingClientRect();
          return { side: menuEl.getAttribute("data-side"), top: mr.top, bottom: mr.bottom, vh: window.innerHeight };
        });
        assert.equal(upper.side, "bottom");
        assert.ok(upper.top >= 7.5 && upper.bottom <= upper.vh - 7.5, `downward menu (${upper.top}..${upper.bottom}) stays inside viewport`);
        await page.getByRole("menuitem", { name: "新建会话" }).tap();
        assert.equal(await page.getByTestId("last-action").textContent(), "upper-new-session");

        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test("landscape touch 640x320: DropdownMenuSubContent also caps height and scrolls within viewport", async () => {
      const context = await browser.newContext({
        viewport: { width: 640, height: 320 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      try {
        await page.goto(url);
        await page.getByTestId("submenu-trigger-root").tap();
        await page.getByTestId("submenu-trigger").waitFor();
        await page.getByTestId("submenu-trigger").tap();
        await page.getByRole("menuitem", { name: "项目分组 1", exact: true }).waitFor();
        await page.waitForTimeout(150);

        const sub = await page.evaluate(() => {
          const menus = [...document.querySelectorAll("[role='menu']")];
          const subEl = menus[menus.length - 1];
          const r = subEl.getBoundingClientRect();
          return {
            viewportHeight: window.innerHeight,
            top: r.top,
            bottom: r.bottom,
            clientHeight: subEl.clientHeight,
            scrollHeight: subEl.scrollHeight,
          };
        });
        assert.ok(sub.top >= 7.5, `submenu top (${sub.top}) stays inside viewport`);
        assert.ok(sub.bottom <= sub.viewportHeight - 7.5, `submenu bottom (${sub.bottom}) stays inside viewport`);
        assert.ok(sub.scrollHeight > sub.clientHeight, "12-item submenu scrolls vertically");
      } finally {
        await context.close();
      }
    });

    await t.test("desktop 1280x800: tall viewport keeps full natural menu height without scrollbar", async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      try {
        await page.goto(url);
        await page.getByTestId("row-target").hover();
        await page.getByRole("button", { name: "项目 外协采购 更多" }).click();
        await page.getByRole("menu").waitFor();
        await page.waitForTimeout(150);
        await saveShot(page, "desktop-open");

        const desk = await page.evaluate(() => {
          const menuEl = document.querySelector("[role='menu']");
          const mr = menuEl.getBoundingClientRect();
          return {
            top: mr.top,
            bottom: mr.bottom,
            clientHeight: menuEl.clientHeight,
            scrollHeight: menuEl.scrollHeight,
          };
        });
        assert.ok(desk.top >= 7.5 && desk.bottom <= 792.5, "desktop menu stays inside viewport");
        assert.ok(
          desk.scrollHeight <= desk.clientHeight + 1,
          `desktop menu has no vertical overflow (${desk.scrollHeight} <= ${desk.clientHeight})`,
        );
      } finally {
        await context.close();
      }
    });
  },
);
