// Bundles one browser-test harness (real product modules, production defines) with the real
// Tailwind stylesheet, and serves it on loopback. `plugins` are esbuild plugins (fault
// injection or a test's RED switch). Used by the OCV5-380 imported-incident browser proofs.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const here = dirname(fileURLToPath(import.meta.url));

export async function buildHarnessPage({ harness, assetDir, plugins = [] }) {
  await build({
    entryPoints: [join(here, harness)], bundle: true, format: "iife",
    outfile: join(assetDir, "app.js"), jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins, logLevel: "warning",
  });
  const entry = join(assetDir, "entry.css");
  writeFileSync(entry, `@import ${JSON.stringify(resolve(here, "../src/styles.css"))};\n@source ${JSON.stringify(join(assetDir, "app.js"))};\n`);
  const entryJs = join(assetDir, "entry.ts");
  writeFileSync(entryJs, `import ${JSON.stringify(entry)};\n`);
  const cssDir = join(assetDir, "css-build"); mkdirSync(cssDir);
  await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()],
    build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false,
      rollupOptions: { input: entryJs, output: { assetFileNames: "styles[extname]" } } } });
  writeFileSync(join(assetDir, "styles.css"), readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))));
}

export async function serveHarnessPage(assetDir) {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const file = { "/": null, "/app.js": "app.js", "/styles.css": "styles.css" }[path];
    if (file === undefined) { res.writeHead(404); res.end(); return; }
    if (file === null) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles.css"><body class="bg-bg"><div id="root"></div><script src="/app.js"></script>');
      return;
    }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/css");
    res.end(readFileSync(join(assetDir, file)));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((done) => server.close(done)) };
}

/** esbuild plugin: replace `from` with `to` exactly once in the file matching `filter` (RED switches). */
export function exactSwap(name, filter, from, to, counter) {
  return { name, setup(b) {
    b.onLoad({ filter }, ({ path }) => {
      const contents = readFileSync(path, "utf8");
      if (contents.split(from).length !== 2) throw new Error(`${name}: expected exactly one occurrence in ${path}`);
      counter.count += 1;
      return { contents: contents.replace(from, to), loader: path.endsWith(".tsx") ? "tsx" : "ts" };
    });
  } };
}
