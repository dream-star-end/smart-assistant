#!/usr/bin/env npx tsx
// Static scanner for `packages/web/public/modules/*.js` that flags identifier
// references which resolve to neither (a) an ESM import in the same file,
// (b) a name declared anywhere in the file, nor (c) a known browser / JS
// built-in / vendor global.
//
// Why this exists:
//   v1.0.160 shipped `_isMobileUA is not defined` to prod — billing.js
//   referenced the helper but the import line was lost in a `git merge -X theirs`
//   conflict resolution. Lint (Biome) didn't catch it (noUndeclaredVariables is
//   off in our preset), tests didn't catch it (no browser-side smoke), QR code
//   was broken on desktop until users reported. This script is a static guard
//   for that whole class of "name used but not imported / declared" bugs.
//
// Approach:
//   For each module file, walk the AST (TypeScript compiler in JS mode):
//     1. Collect every name declared anywhere in the file (function decls,
//        class decls, var/let/const incl. destructuring, function params,
//        catch bindings, import bindings).
//     2. Walk every Identifier in expression position. Skip property names
//        (`obj.foo`), object literal keys (`{ foo: x }`), method/getter/
//        setter names, import/export specifier source names, label names,
//        and the binding-side of declarations.
//     3. Flag any reference not in (declared ∪ globals).
//
// Limitations (accepted):
//   - No scope precision: a name declared anywhere in the file passes globally.
//     False negatives on shadowing (rare in our codebase). The bug-class we
//     care about — top-level callable that doesn't exist anywhere — is fully
//     caught.
//   - JSX is not handled. Web modules are vanilla JS / ESM, no JSX.
//
// Usage:
//   npx tsx scripts/check-undefined-refs.ts        # scan all, exit 1 on issues
//   npx tsx scripts/check-undefined-refs.ts file.js  # scan one file

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MODULES_DIR = join(REPO_ROOT, "packages", "web", "public", "modules");

// ── Browser / DOM / BOM globals ──
// Names that are available without import in any browser context. This is not
// exhaustive — it's the set actually used (or plausibly used) by our web
// modules. Adding a name here is fine; the cost of a too-narrow list is a CI
// false positive on a legitimate global, easily fixed.
const BROWSER_GLOBALS = new Set<string>([
  // window / document / navigation
  "window", "document", "navigator", "location", "history", "screen", "self",
  "frames", "parent", "top", "opener", "closed", "name",
  // console & timers
  "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
  "requestIdleCallback", "cancelIdleCallback",
  // network / fetch / storage
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "FormData",
  "Headers", "Request", "Response", "URL", "URLSearchParams",
  "Blob", "File", "FileReader", "FileList",
  "localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore",
  // crypto / encoding / streams
  "crypto", "Crypto", "btoa", "atob",
  "TextEncoder", "TextDecoder",
  "ReadableStream", "WritableStream", "TransformStream",
  // performance / dialogs
  "performance", "alert", "confirm", "prompt",
  "getComputedStyle", "matchMedia",
  // observers / abort
  "ResizeObserver", "IntersectionObserver", "MutationObserver", "PerformanceObserver",
  "AbortController", "AbortSignal",
  // events
  "Event", "CustomEvent", "MessageEvent", "ErrorEvent", "PromiseRejectionEvent",
  "KeyboardEvent", "MouseEvent", "PointerEvent", "TouchEvent",
  "InputEvent", "FocusEvent", "WheelEvent", "DragEvent",
  "ClipboardEvent", "BeforeUnloadEvent", "HashChangeEvent", "PopStateEvent",
  "StorageEvent", "ProgressEvent", "CloseEvent", "AnimationEvent", "TransitionEvent",
  // DOM hierarchy
  "Node", "NodeFilter", "NodeList", "Element", "HTMLElement", "Document",
  "DocumentFragment", "ShadowRoot", "Range", "Selection",
  "DOMParser", "XMLSerializer", "DOMRect", "DOMRectReadOnly", "DOMMatrix",
  "HTMLCollection", "HTMLImageElement", "HTMLCanvasElement", "HTMLVideoElement",
  "HTMLAudioElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "HTMLOptionElement", "HTMLAnchorElement",
  "HTMLButtonElement", "HTMLFormElement", "HTMLDivElement",
  "HTMLLinkElement", "HTMLStyleElement", "HTMLScriptElement",
  "Image", "Audio", "Option",
  // media / canvas
  "MediaRecorder", "MediaStream", "MediaStreamTrack",
  "AudioContext", "AudioBuffer", "AnalyserNode",
  "OffscreenCanvas", "Path2D", "ImageData",
  // notifications / clipboard
  "Notification", "ClipboardItem",
  // structuredClone & misc
  "structuredClone", "reportError",
  // misc browser
  "DOMException", "BroadcastChannel", "MessageChannel", "MessagePort",
  "Worker", "SharedWorker",
  // CSS
  "CSS", "CSSStyleSheet",
  // service workers
  "ServiceWorker", "ServiceWorkerRegistration",
  // speech
  "SpeechSynthesisUtterance", "speechSynthesis",
  "SpeechRecognition", "webkitSpeechRecognition",
  // payment / device
  "PaymentRequest",
]);

// ── ECMAScript built-ins (always present in any JS runtime) ──
const JS_BUILTINS = new Set<string>([
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Date", "RegExp", "Math", "JSON", "Promise",
  "Map", "Set", "WeakMap", "WeakSet",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "EvalError", "URIError", "AggregateError",
  "Function", "Proxy", "Reflect", "Intl",
  "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics",
  "NaN", "Infinity", "undefined", "globalThis",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent",
  "eval",
  "Generator", "AsyncGenerator", "Iterator", "AsyncIterator",
  // implicit script-level
  "arguments", "this",
]);

// ── Vendor globals loaded via <script src> in index.html / admin.html ──
// Check `grep '<script[^>]*src=' packages/web/public/{index,admin}.html` —
// every non-module <script> contributes a global that must be listed here.
const VENDOR_GLOBALS = new Set<string>([
  "marked",      // /vendor/marked.min.js
  "hljs",        // /vendor/highlight.min.js
  "DOMPurify",   // /vendor/purify.min.js
  "Chart",       // /vendor/chart.umd.min.js
  "katex",       // /vendor/katex/katex.min.js
  "QRCode",      // /vendor/qrcode.min.js
  "mermaid",     // dynamically imported but referenced as global in some helpers
]);

const ALL_GLOBALS = new Set<string>([
  ...BROWSER_GLOBALS,
  ...JS_BUILTINS,
  ...VENDOR_GLOBALS,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Declaration collection: walk the AST and gather every name that gets bound
// somewhere in the file. We deliberately do NOT track scope — a single flat
// set is sufficient for the "name doesn't exist anywhere" class of bug.

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
      // OmittedExpression in array pattern (`[, x]`) — no binding.
    }
  }
}

function collectDeclarations(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
      names.add(node.name.text);
    } else if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      names.add(node.name.text);
    } else if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, names);
    } else if (ts.isParameter(node)) {
      collectBindingNames(node.name, names);
    } else if (ts.isBindingElement(node)) {
      collectBindingNames(node.name, names);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    } else if (ts.isImportClause(node)) {
      // default import: import Foo from '...'
      if (node.name) names.add(node.name.text);
      if (node.namedBindings) {
        if (ts.isNamespaceImport(node.namedBindings)) {
          // import * as Foo from '...'
          names.add(node.namedBindings.name.text);
        } else {
          // import { foo, bar as baz } from '...'
          for (const spec of node.namedBindings.elements) {
            names.add(spec.name.text); // local name (post-`as` if present)
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference walking: visit every Identifier in expression position. Skip
// identifier positions that are syntactically not references (property names,
// import/export specifier source names, etc.).

interface Issue {
  file: string;
  name: string;
  line: number;
  col: number;
}

function checkReferences(
  sf: ts.SourceFile,
  fileRel: string,
  declared: Set<string>,
): Issue[] {
  const issues: Issue[] = [];

  const reportIdent = (id: ts.Identifier) => {
    const txt = id.text;
    if (declared.has(txt) || ALL_GLOBALS.has(txt)) return;
    const pos = sf.getLineAndCharacterOfPosition(id.getStart(sf));
    issues.push({
      file: fileRel,
      name: txt,
      line: pos.line + 1,
      col: pos.character + 1,
    });
  };

  const visit = (node: ts.Node) => {
    // ── Skip identifier positions that are NOT references ──

    // obj.foo  → visit obj, skip foo
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      // node.name is property name, never a reference
      return;
    }

    // obj?.foo  (same as above for optional chain)
    // Covered by isPropertyAccessExpression above (TS unifies them).

    // { foo: expr }  → visit expr, skip foo (unless computed)
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      visit(node.initializer);
      return;
    }

    // { foo }  shorthand → foo IS a reference; let default handler pick it up

    // class Foo { method() {} }  → skip method name
    // { method() {} }  same
    if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      if (node.name && ts.isComputedPropertyName(node.name)) {
        visit(node.name.expression);
      }
      for (const p of node.parameters) visit(p);
      if ((node as ts.MethodDeclaration).body) visit((node as ts.MethodDeclaration).body!);
      return;
    }

    // class Foo { field = init }  → skip field name (unless computed)
    if (ts.isPropertyDeclaration(node)) {
      if (node.name && ts.isComputedPropertyName(node.name)) {
        visit(node.name.expression);
      }
      if (node.initializer) visit(node.initializer);
      return;
    }

    // { foo: x }  in destructuring  → foo is key (skip), x is binding
    // { foo = init }  → foo is binding, init is reference (default value)
    // { [computedKey]: x }  → computedKey IS a reference (runtime lookup)
    if (ts.isBindingElement(node)) {
      // Only computed propertyName carries an actual reference; static
      // propertyName is a key (compile-time identifier, like an object literal key).
      if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
        visit(node.propertyName.expression);
      }
      if (node.initializer) visit(node.initializer);
      // recurse into nested patterns; identifier-name positions are declarations
      if (!ts.isIdentifier(node.name)) visit(node.name);
      return;
    }

    // import { foo as bar } from '...'  → neither foo nor bar is a reference
    if (ts.isImportSpecifier(node)) return;
    if (ts.isImportClause(node)) {
      // children: name (default import binding), namedBindings — neither side
      // contains references. Stop here.
      return;
    }

    // export { foo, bar as baz }  → foo is a reference (must exist locally);
    // bar is a reference; baz is just the external alias.
    if (ts.isExportSpecifier(node)) {
      // propertyName is the local name when `as` is used; otherwise name is.
      const local = node.propertyName ?? node.name;
      if (ts.isIdentifier(local)) reportIdent(local);
      return;
    }

    // export * from 'mod'  / export * as ns from 'mod' — no local references
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      // export { x } from 'mod'  — x is from the external module, NOT local.
      // Stop walking; the specifiers don't reference local names.
      return;
    }

    // FunctionDeclaration / FunctionExpression / Class*  → name is declaration
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      // visit children except .name
      ts.forEachChild(node, (c) => {
        if ((node as ts.FunctionLikeDeclaration).name && c === (node as ts.FunctionLikeDeclaration).name) return;
        visit(c);
      });
      return;
    }

    // Parameter  → name is declaration; visit initializer + decorators only
    if (ts.isParameter(node)) {
      if (node.initializer) visit(node.initializer);
      // type annotations are skipped (JS doesn't have them; if any sneak in
      // they wouldn't reference runtime values anyway).
      // Nested destructure pattern names are declarations.
      if (!ts.isIdentifier(node.name)) visit(node.name);
      return;
    }

    // VariableDeclaration  → name is declaration; visit initializer
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) visit(node.initializer);
      if (!ts.isIdentifier(node.name)) visit(node.name);
      return;
    }

    // CatchClause  → variable name is declaration; visit block
    if (ts.isCatchClause(node)) {
      visit(node.block);
      return;
    }

    // LabeledStatement / Break / Continue  → label is not an identifier ref
    if (ts.isLabeledStatement(node)) {
      visit(node.statement);
      return;
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      return;
    }

    // MetaProperty (new.target, import.meta) — not a regular identifier ref
    if (ts.isMetaProperty(node)) return;

    // QualifiedName (type space, rare in JS)  → skip
    if (ts.isQualifiedName(node)) return;

    // TypeReference / TypeQuery — skip whole subtree (JS won't have these, but
    // be defensive)
    if (
      ts.isTypeReferenceNode(node) ||
      ts.isTypeQueryNode(node) ||
      ts.isTypeLiteralNode(node) ||
      ts.isTypePredicateNode(node)
    ) {
      return;
    }

    // ── Bare Identifier reference ──
    if (ts.isIdentifier(node)) {
      reportIdent(node);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────

function scanFile(absPath: string): Issue[] {
  const fileRel = relative(REPO_ROOT, absPath);
  const source = readFileSync(absPath, "utf-8");
  const sf = ts.createSourceFile(
    fileRel,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );
  // Fail-closed on parse errors. TS parser does error-recovery and still
  // produces a usable-looking AST, but a partial AST means our declaration
  // and reference walks may both miss things — exactly the kind of "looks
  // OK but isn't" outcome a deploy gate must refuse to certify. Surfacing
  // the parse failure as a synthetic issue keeps the rest of the deploy
  // pipeline (which checks process exit code, not message content) honest.
  const parseDiagnostics = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const out: Issue[] = [];
    for (const d of parseDiagnostics) {
      const pos = d.start != null
        ? sf.getLineAndCharacterOfPosition(d.start)
        : { line: 0, character: 0 };
      const msg = typeof d.messageText === "string"
        ? d.messageText
        : d.messageText.messageText;
      out.push({
        file: fileRel,
        name: `<parse error: ${msg}>`,
        line: pos.line + 1,
        col: pos.character + 1,
      });
    }
    return out;
  }
  const declared = collectDeclarations(sf);
  return checkReferences(sf, fileRel, declared);
}

function main() {
  const args = process.argv.slice(2);
  let files: string[];
  if (args.length > 0) {
    files = args.map((a) => resolve(process.cwd(), a));
  } else {
    files = readdirSync(MODULES_DIR)
      .filter((f) => f.endsWith(".js"))
      .sort()
      .map((f) => join(MODULES_DIR, f));
  }

  const allIssues: Issue[] = [];
  for (const f of files) {
    allIssues.push(...scanFile(f));
  }

  if (allIssues.length === 0) {
    console.log(`OK: ${files.length} file(s) scanned, no undefined references.`);
    process.exit(0);
  }

  // Group by file for readable output.
  const byFile = new Map<string, Issue[]>();
  for (const iss of allIssues) {
    const arr = byFile.get(iss.file) ?? [];
    arr.push(iss);
    byFile.set(iss.file, arr);
  }

  console.error(`FAIL: ${allIssues.length} undefined reference(s) across ${byFile.size} file(s):\n`);
  for (const [file, issues] of byFile) {
    console.error(`  ${file}`);
    // Dedupe by name+line; same name on same line gets reported once.
    const seen = new Set<string>();
    for (const iss of issues) {
      const key = `${iss.line}:${iss.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.error(`    ${iss.line}:${iss.col}  ${iss.name}`);
    }
  }
  console.error(
    "\nEither import the name, declare it, or add it to BROWSER_GLOBALS /",
  );
  console.error("VENDOR_GLOBALS in scripts/check-undefined-refs.ts.");
  process.exit(1);
}

main();
