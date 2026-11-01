/**
 * Serves pre-transpiled TypeScript while the module URL stays the original
 * .ts path. import.meta.url then still resolves sibling SQL, Python, cjs,
 * and jsonl. A bundle would move that URL and break the proof.
 *
 * initialize() runs before the proof module is evaluated, so the esbuild
 * pass is outside main()'s 120s deadline. Later dynamic imports reuse this
 * cache. A cache miss is transpiled on demand and must stay rare.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_DIRS = [
  "scripts",
  "packages/commercial/src",
  "packages/gateway/src",
  "packages/protocol/src",
  "packages/storage/src",
  "packages/kernel/src",
  "packages/plugin-sdk/src",
  "packages/mcp-memory/src",
];

const cache = new Map();
let misses = 0;

function walkSources(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "dist-types" || ent.name === "__tests__") {
      continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkSources(full, out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!/\.(ts|mts|cts)$/.test(ent.name) || ent.name.endsWith(".d.ts")) continue;
    if (/\.(?:integ\.)?test\.ts$/.test(ent.name)) continue;
    out.push(full);
  }
}

function tsFileFor(abs) {
  const candidates = [];
  if (/\.(ts|tsx|mts|cts)$/.test(abs) && !abs.endsWith(".d.ts")) candidates.push(abs);
  const ext = path.extname(abs);
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const stem = abs.slice(0, -ext.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
    candidates.push(path.join(stem, "index.ts"), path.join(stem, "index.tsx"));
  } else if (ext === "") {
    candidates.push(`${abs}.ts`, `${abs}.tsx`, `${abs}.mts`, path.join(abs, "index.ts"), path.join(abs, "index.tsx"));
  }
  for (const candidate of candidates) {
    if (!/\.(ts|tsx|mts|cts)$/.test(candidate) || candidate.endsWith(".d.ts")) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function mapSpecifier(specifier, context) {
  if (specifier.startsWith("node:") || specifier.startsWith("data:") || specifier.startsWith("bun:")) return null;
  let abs = null;
  if (specifier.startsWith("file:")) {
    try {
      abs = fileURLToPath(specifier);
    } catch {
      return null;
    }
  } else if (specifier.startsWith("/")) {
    abs = specifier;
  } else if (specifier.startsWith(".")) {
    if (!context.parentURL || !context.parentURL.startsWith("file:")) return null;
    abs = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  } else {
    return null;
  }
  const hit = tsFileFor(abs);
  return hit ? pathToFileURL(hit).href : null;
}

async function precompile() {
  const files = [];
  for (const rel of SOURCE_DIRS) {
    const dir = path.join(ROOT, rel);
    if (existsSync(dir)) walkSources(dir, files);
  }
  const started = Date.now();
  const outdir = path.join(ROOT, ".box-incident-prebuild");
  const entries = new Set(files);
  const result = await esbuild.build({
    entryPoints: files,
    absWorkingDir: ROOT,
    outdir,
    outbase: ROOT,
    bundle: false,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    treeShaking: false,
    logLevel: "silent",
  });
  const prefix = outdir.endsWith(path.sep) ? outdir : outdir + path.sep;
  let mapped = 0;
  for (const out of result.outputFiles) {
    if (!out.path.startsWith(prefix)) continue;
    const rel = out.path.slice(prefix.length).replace(/\.(?:js|mjs)$/, "");
    let src = null;
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
      const candidate = path.join(ROOT, rel + ext);
      if (entries.has(candidate)) {
        src = candidate;
        break;
      }
    }
    if (!src) continue;
    cache.set(pathToFileURL(src).href, out.text);
    mapped += 1;
  }
  const sample = mapped === 0 && result.outputFiles[0] ? ` sample=${result.outputFiles[0].path}` : "";
  console.error(`[box-incident-proofs] esbuild precompile ${mapped}/${files.length} files in ${Date.now() - started}ms${sample}`);
}

export async function initialize() {
  try {
    await precompile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[box-incident-proofs] esbuild precompile failed: ${message.split("\n")[0]}`);
  }
}

export async function resolve(specifier, context, nextResolve) {
  const mapped = mapSpecifier(specifier, context);
  if (mapped) return { url: mapped, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:")) return nextLoad(url, context);
  let abs;
  try {
    abs = fileURLToPath(url);
  } catch {
    return nextLoad(url, context);
  }
  if (!/\.(ts|tsx|mts|cts)$/.test(abs) || abs.endsWith(".d.ts")) return nextLoad(url, context);
  const key = pathToFileURL(abs).href;
  let code = cache.get(key);
  if (code === undefined) {
    const ext = path.extname(abs);
    const loader = ext === ".tsx" ? "tsx" : "ts";
    const result = await esbuild.transform(readFileSync(abs, "utf8"), {
      loader,
      format: "esm",
      target: "node20",
      sourcefile: abs,
      ...(loader === "tsx" ? { jsx: "automatic" } : {}),
      logLevel: "silent",
    });
    code = result.code;
    cache.set(key, code);
    misses += 1;
    if (misses <= 30) console.error(`[box-incident-proofs] precompile miss ${path.relative(ROOT, abs)}`);
    else if (misses === 31) console.error("[box-incident-proofs] further precompile misses suppressed");
  }
  return { format: "module", source: code, shortCircuit: true };
}
