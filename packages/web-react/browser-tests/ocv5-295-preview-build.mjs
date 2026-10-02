// OCV5-295 预览站构建:真组件 bundle + 真 production CSS → 静态目录(可被任意静态服务长驻)。
//
// 构建方式沿用 browser-tests/run.mjs 与 ui-preview/shoot.mjs(esbuild IIFE + vite@tailwind 出
// production CSS),不另起一套。bundle 以外链 <script src> 引入 —— 内联会被 markdown 链路里的
// `<!--` / `<script` 字面量打断(见 ui-preview/shoot.mjs 2026-09-15 注释)。
//
// 用法:node browser-tests/ocv5-295-preview-build.mjs <outDir>
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = dirname(HERE);
const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: node browser-tests/ocv5-295-preview-build.mjs <outDir>");
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await esbuild.build({
  entryPoints: [join(HERE, "ocv5-295-preview-harness.tsx")],
  bundle: true,
  format: "iife",
  outfile: join(OUT, "harness.js"),
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.MODE": '"production"',
    "import.meta.env.PROD": "true",
    "import.meta.env.DEV": "false",
  },
  alias: { "node:crypto": join(HERE, "stubs", "node-crypto.js") },
  logLevel: "warning",
});

const cssDir = join(OUT, "_css");
await viteBuild({
  root: PKG,
  configFile: false,
  logLevel: "silent",
  // 不向共享 node_modules 写 vite 缓存:缓存落在输出目录里。
  cacheDir: join(OUT, "_vite-cache"),
  plugins: [tailwindcss()],
  build: {
    outDir: cssDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: join(HERE, "preview-styles.ts"),
      output: { entryFileNames: "preview-styles.js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}
const built = walk(cssDir);
const cssFile = built.find((p) => p.endsWith(".css"));
if (!cssFile) throw new Error("ocv5-295-preview: production CSS 构建失败(产物里没有 .css)");
// CSS 里的字体 url() 引用的是 /assets/<name>;统一平铺到 OUT/assets。
mkdirSync(join(OUT, "assets"), { recursive: true });
for (const file of built) {
  if (file === cssFile || file.endsWith("preview-styles.js")) continue;
  copyFileSync(file, join(OUT, "assets", basename(file)));
}
copyFileSync(cssFile, join(OUT, "styles.css"));
rmSync(cssDir, { recursive: true, force: true });
rmSync(join(OUT, "_vite-cache"), { recursive: true, force: true });

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>OCV5-295 聊天页预览</title>
<link rel="stylesheet" href="./styles.css">
</head><body><div id="root"></div><script src="./harness.js"></script></body></html>`;
writeFileSync(join(OUT, "index.html"), page);
writeFileSync(
  join(OUT, "scenes.html"),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCV5-295 预览目录</title></head><body style="font:15px/1.8 system-ui;padding:16px">
<h1 style="font-size:18px">OCV5-295 聊天页预览(真组件 + production CSS,只读合成数据)</h1><ul>
${["complete", "streaming", "partial"]
  .flatMap((scene) => ["light", "dark"].flatMap((theme) => ["", "long"].map((model) => ({ scene, theme, model }))))
  .map(({ scene, theme, model }) => {
    const q = `?scene=${scene}&theme=${theme}${model ? `&model=${model}` : ""}`;
    return `<li><a href="./index.html${q}">${scene} · ${theme}${model ? " · 长模型名" : ""}</a></li>`;
  })
  .join("\n")}
</ul></body></html>`,
);
console.log(`ocv5-295-preview: built → ${OUT}`);
