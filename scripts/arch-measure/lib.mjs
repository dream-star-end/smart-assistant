// OCV5-540 (phase 3 P0a): shared helpers for the read-only architecture measurements.
// No dependencies beyond Node. Every script takes --root <repo> (default: this checkout) so it can
// be re-run against any snapshot, e.g. the plan's baseline 3ef8d1d3d.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { root: DEFAULT_ROOT, json: false, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = path.resolve(argv[++i]);
    else if (a.startsWith("--root=")) out.root = path.resolve(a.slice(7));
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v ?? argv[++i];
    } else out._.push(a);
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".vite", ".cache"]);

/** All files under dir (relative to root), skipping build output and node_modules. */
export function walk(root, rel, filter = () => true) {
  const out = [];
  const start = path.join(root, rel);
  if (!existsSync(start)) return out;
  const stack = [rel];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of readdirSync(path.join(root, cur), { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const r = cur ? `${cur}/${ent.name}` : ent.name;
      if (ent.isDirectory()) stack.push(r);
      else if (ent.isFile() && filter(r)) out.push(r);
    }
  }
  return out.sort();
}

/** The plan's "non-test" TS source (§1 preamble): .ts/.tsx, not *.test.*, not under __tests__. */
export function isProdTs(rel) {
  return /\.(ts|tsx)$/.test(rel) && !/\.test\.(ts|tsx)$/.test(rel) && !/(^|\/)__tests__\//.test(rel);
}

export function prodFiles(root, rel) {
  return walk(root, rel, isProdTs);
}

export function read(root, rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

export function lineCount(text) {
  if (!text.length) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function lines(root, files) {
  let n = 0;
  for (const f of files) n += lineCount(read(root, f));
  return n;
}

/** Blank out comments and string/template contents so regex scans see code only. Keeps offsets. */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && d === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      // keep the string as-is (specifiers live in strings); only skip over it so its content is not
      // mistaken for comments
      const q = c;
      out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        if (q !== "`" && src[i] === "\n") break;
        out += src[i]; i++;
      }
      if (i < n) { out += src[i]; i++; }
    } else { out += c; i++; }
  }
  return out;
}

/**
 * Module references of one file: static import/export-from, side-effect import, import(), require().
 * kind: "value" | "type". `import type` / `export type` are type-only; everything else is value
 * (the plan's appendix A.1 rule).
 */
export function scanImports(src) {
  const code = stripComments(src);
  const refs = [];
  // the clause between the keyword and `from` is identifiers, braces, commas, `*` and whitespace only,
  // so the lazy match cannot run across the file (an `export function` has no `from`).
  const re = /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([\w$*\s{},]*?)\s*from\s*(['"])([^'"\n]+)\4/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1] === "export" && !/^[{*]/.test(m[3].trim())) continue; // `export const x = ... from`? not a re-export
    refs.push({ spec: m[5], kind: m[2] ? "type" : "value", form: m[1] });
  }
  const side = /(?:^|[;\n}])\s*import\s+(['"])([^'"\n]+)\1/g;
  while ((m = side.exec(code))) refs.push({ spec: m[2], kind: "value", form: "import-side-effect" });
  // `import("x")` is also TypeScript's type-position import (`import("x").Foo`, `typeof import("x")`):
  // those are type references, not runtime edges. A runtime dynamic import is awaited or chained with
  // .then/.catch/.finally.
  const dyn = /(\btypeof\s+)?\b(import|require)\s*\(\s*(['"])([^'"\n]+)\3\s*\)(\s*\.\s*([A-Za-z_$][\w$]*))?/g;
  while ((m = dyn.exec(code))) {
    const typePos = m[2] === "import" && (m[1] || (m[6] && !["then", "catch", "finally"].includes(m[6])));
    refs.push({ spec: m[4], kind: typePos ? "type" : "value", form: m[2] === "import" ? (typePos ? "import-type" : "dynamic-import") : "require" });
  }
  return refs;
}

const EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".json"];
/** Resolve a relative specifier from file `from` (repo-relative) to a repo-relative file, or null. */
export function resolveRelative(root, from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const cands = [base];
  const noJs = base.replace(/\.(m|c)?js$/, "");
  if (noJs !== base) cands.push(...EXTS.map((e) => noJs + e));
  cands.push(...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`));
  for (const c of cands) {
    const abs = path.join(root, c);
    if (existsSync(abs) && statSync(abs).isFile()) return c;
  }
  return null;
}

/** Tarjan SCC over a Map<node, Set<node>>. Returns arrays of members. */
export function scc(graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const on = new Set();
  const stack = [];
  const out = [];
  const nodes = [...graph.keys()];
  for (const start of nodes) {
    if (idx.has(start)) continue;
    // iterative Tarjan
    const work = [[start, [...(graph.get(start) ?? [])], 0]];
    idx.set(start, index); low.set(start, index); index++; stack.push(start); on.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, succ] = frame;
      if (frame[2] < succ.length) {
        const w = succ[frame[2]++];
        if (!graph.has(w)) continue;
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++; stack.push(w); on.add(w);
          work.push([w, [...(graph.get(w) ?? [])], 0]);
        } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      } else {
        work.pop();
        if (work.length) {
          const u = work[work.length - 1][0];
          low.set(u, Math.min(low.get(u), low.get(v)));
        }
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
          out.push(comp.sort());
        }
      }
    }
  }
  return out;
}

/** Count matches of a regex over files (code with comments blanked). */
export function countMatches(root, files, re, { stripped = true } = {}) {
  let total = 0;
  const perFile = new Map();
  for (const f of files) {
    const text = stripped ? stripComments(read(root, f)) : read(root, f);
    const n = (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? []).length;
    if (n) { perFile.set(f, n); total += n; }
  }
  return { total, files: perFile.size, perFile };
}

export function emit(args, title, rows) {
  if (args.json) {
    console.log(JSON.stringify({ title, root: args.root, rows }, null, 2));
    return;
  }
  console.log(`# ${title}  (root: ${args.root})`);
  for (const r of rows) console.log(`${r.id.padEnd(34)} ${String(r.value).padStart(10)}  ${r.what}`);
}
