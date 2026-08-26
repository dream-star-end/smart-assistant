#!/usr/bin/env node
// Precompile the container `npm run gateway` TypeScript closure to per-package
// dist/ JavaScript. Transform keeps module structure (no bundle) so native
// addons, dynamic imports, and import.meta.url-relative assets keep working.
//
// Node ESM requires a file extension on relative imports; tsx does not.
// After emit, rewrite extension-less relative specifiers to `.js`.
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const repoRoot = existsSync(join(cwd, "packages/cli/src/index.ts"))
  ? cwd
  : resolve(scriptDir, "../../..");
process.chdir(repoRoot);

const SKIP = new Set(["web", "web-react", "desktop"]);
const MARKER = join(repoRoot, "packages/cli/dist/.precompiled-ok");
const CLI_ENTRY = join(repoRoot, "packages/cli/dist/index.js");
const GATEWAY_CMD = join(repoRoot, "packages/cli/dist/commands/gateway.js");

function pkgJson(dir) {
  return require(join(dir, "package.json"));
}

function listWorkspacePackages() {
  const ws = pkgJson(repoRoot).workspaces || [];
  const out = [];
  for (const pat of ws) {
    const path = join(repoRoot, pat);
    if (!existsSync(join(path, "package.json"))) continue;
    const name = pkgJson(path).name || "";
    const short = name.startsWith("@openclaude/")
      ? name.slice("@openclaude/".length)
      : path.split("/").pop();
    if (SKIP.has(short)) continue;
    if (!existsSync(join(path, "src"))) continue;
    out.push(relative(repoRoot, path));
  }
  return out;
}

function walk(src, pred) {
  const acc = [];
  const visit = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "__tests__" || ent.name === "node_modules") continue;
        visit(p);
        continue;
      }
      if (ent.isFile() && pred(ent.name, p)) acc.push(p);
    }
  };
  visit(src);
  return acc;
}

function walkTs(src) {
  return walk(src, (name) => {
    if (!name.endsWith(".ts")) return false;
    if (name.endsWith(".test.ts") || name.endsWith(".spec.ts") || name.endsWith(".d.ts")) return false;
    return true;
  });
}

function walkAssets(src) {
  return walk(src, (name) => /\.(cjs|js|mjs|json|sql)$/.test(name));
}

function walkDistJs(dist) {
  if (!existsSync(dist)) return [];
  return walk(dist, (name) => name.endsWith(".js") || name.endsWith(".mjs"));
}

const KNOWN_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".node", ".css", ".sql", ".html", ".wasm"]);

function addJsExt(distFile, spec) {
  const q = spec.search(/[?#]/);
  const noQuery = q === -1 ? spec : spec.slice(0, q);
  const query = q === -1 ? "" : spec.slice(q);
  const ext = extname(noQuery);
  if (ext && KNOWN_EXT.has(ext)) return spec;
  const stripped = noQuery.replace(/\.(tsx|ts|mts|cts)$/, "");
  const base = resolve(dirname(distFile), stripped);
  if (existsSync(base + ".js")) return stripped + ".js" + query;
  if (existsSync(join(base, "index.js"))) {
    const withIndex = stripped.endsWith("/") ? `${stripped}index.js` : `${stripped}/index.js`;
    return withIndex + query;
  }
  if (existsSync(base + ".json")) return stripped + ".json" + query;
  if (existsSync(base + ".cjs")) return stripped + ".cjs" + query;
  if (existsSync(base + ".mjs")) return stripped + ".mjs" + query;
  return stripped + ".js" + query;
}

function rewriteSpecifier(prefix, quote, spec, suffix, distFile) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) {
    return prefix + quote + spec + quote + suffix;
  }
  return prefix + quote + addJsExt(distFile, spec) + quote + suffix;
}

function rewriteFileImports(distFile) {
  const orig = readFileSync(distFile, "utf8");
  let next = orig;
  // from "...", export ... from "...", import("..."), import "..."
  next = next.replace(
    /(\bfrom\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (_, pre, q, spec) => rewriteSpecifier(pre, q, spec, "", distFile),
  );
  next = next.replace(
    /(\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (_, pre, q, spec) => rewriteSpecifier(pre, q, spec, "", distFile),
  );
  next = next.replace(
    /(\bimport\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (_, pre, q, spec) => rewriteSpecifier(pre, q, spec, "", distFile),
  );
  if (next !== orig) writeFileSync(distFile, next);
}

async function compilePkg(pkg) {
  const src = join(repoRoot, pkg, "src");
  const out = join(repoRoot, pkg, "dist");
  const files = walkTs(src);
  if (files.length === 0) {
    console.error(`build-container-gateway: skip ${pkg} (no ts sources)`);
    return;
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  console.error(`build-container-gateway: ${pkg} (${files.length} files)`);
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: files,
    outdir: out,
    outbase: src,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "warning",
    write: true,
  });
  if (result.errors.length) {
    throw new Error(`esbuild failed for ${pkg}`);
  }
  for (const f of walkAssets(src)) {
    const rel = relative(src, f);
    const dest = join(out, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(f, dest);
  }
  for (const js of walkDistJs(out)) {
    rewriteFileImports(js);
  }
}

function mustExist(path) {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`build-container-gateway: missing or empty ${relative(repoRoot, path)}`);
  }
}

function verifyGraphLoads() {
  const check = spawnSync(
    process.execPath,
    [
      "--conditions=openclaude-precompiled",
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(GATEWAY_CMD).href)});`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (check.status !== 0) {
    process.stderr.write(check.stderr || "");
    process.stderr.write(check.stdout || "");
    throw new Error(
      `build-container-gateway: precompiled graph failed to load (exit ${check.status})`,
    );
  }
}

const pkgs = listWorkspacePackages();
if (pkgs.length === 0) {
  throw new Error("build-container-gateway: no workspace packages to compile");
}
console.error(`build-container-gateway: compiling ${pkgs.length} workspace packages`);
for (const pkg of pkgs) {
  await compilePkg(pkg);
}

mustExist(CLI_ENTRY);
mustExist(join(repoRoot, "packages/gateway/dist/index.js"));
mustExist(GATEWAY_CMD);

const syntax = spawnSync(process.execPath, ["--check", CLI_ENTRY], { encoding: "utf8" });
if (syntax.status !== 0) {
  process.stderr.write(syntax.stderr || "");
  throw new Error("build-container-gateway: node --check failed for CLI entry");
}

verifyGraphLoads();

writeFileSync(
  MARKER,
  // Content-addressed: must stay deterministic (runtime digest hashes file bytes).
  "ok\nentry=packages/cli/dist/index.js\n",
);
console.error(
  `build-container-gateway: wrote ${CLI_ENTRY} (${statSync(CLI_ENTRY).size} bytes) marker=${MARKER}`,
);
