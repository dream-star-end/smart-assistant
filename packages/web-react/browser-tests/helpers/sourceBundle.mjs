import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB_REACT_ROOT = resolve(HERE, "../..");
export const WEB_REACT_SRC = join(WEB_REACT_ROOT, "src");

const SOURCE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|css)$/;
const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "__tests__", "__fixtures__", ".git", "dist"]);

function toFsPath(entry) {
  if (entry instanceof URL) return fileURLToPath(entry);
  if (typeof entry === "string" && entry.startsWith("file://")) return fileURLToPath(entry);
  return resolve(String(entry));
}

function walkSourceFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkSourceFiles(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXT_RE.test(entry.name)) continue;
    if (TEST_FILE_RE.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    out.push(join(dir, entry.name));
  }
}

/**
 * Collect the primary entry file plus any existing submodule files/directories
 * belonging to the same logical module family. Missing extra paths are skipped
 * safely so tests work both before and after a module split.
 */
export function collectModuleFamilyFiles(entryFile, extraDirsOrFiles = []) {
  const extras = Array.isArray(extraDirsOrFiles) ? extraDirsOrFiles : [extraDirsOrFiles];
  const primary = entryFile ? toFsPath(entryFile) : null;
  const collected = [];
  const seen = new Set();

  const addFile = (filePath) => {
    const abs = resolve(filePath);
    if (seen.has(abs)) return;
    seen.add(abs);
    collected.push(abs);
  };

  if (primary && existsSync(primary) && statSync(primary).isFile()) {
    addFile(primary);
  }

  const extraFiles = [];
  for (const rawTarget of extras) {
    if (!rawTarget) continue;
    const target = toFsPath(rawTarget);
    if (!existsSync(target)) continue;
    const st = statSync(target);
    if (st.isDirectory()) {
      walkSourceFiles(target, extraFiles);
    } else if (st.isFile()) {
      extraFiles.push(target);
    }
  }
  extraFiles.sort((a, b) => a.localeCompare(b));
  for (const file of extraFiles) addFile(file);
  return collected;
}

/**
 * Read every file in a module family, returning `{ path, contents }[]`.
 */
export function readModuleFamilyFiles(entryFile, extraDirsOrFiles = []) {
  const files = collectModuleFamilyFiles(entryFile, extraDirsOrFiles);
  if (files.length === 0) {
    throw new Error(`readModuleFamilySource: no source files found for ${String(entryFile)}`);
  }
  return files.map((filePath) => ({
    path: filePath,
    contents: readFileSync(filePath, "utf8"),
  }));
}

/**
 * Aggregate source text of a primary entry and its split-out submodules.
 * When only `entryFile` exists (before split), returns its exact contents.
 */
export function readModuleFamilySource(entryFile, extraDirsOrFiles = []) {
  const files = readModuleFamilyFiles(entryFile, extraDirsOrFiles);
  if (files.length === 1) return files[0].contents;
  return files.map((entry) => entry.contents).join("\n");
}

/**
 * Compute SHA-256 across the aggregated module family source.
 */
export function hashModuleFamily(entryFile, extraDirsOrFiles = []) {
  return createHash("sha256")
    .update(readModuleFamilySource(entryFile, extraDirsOrFiles))
    .digest("hex");
}

/**
 * Standard module family descriptors for decoupled browser-test lookups.
 */
export const MODULE_FAMILIES = {
  messageRenderer: () => ({
    entryFile: join(WEB_REACT_SRC, "components/MessageRenderer.tsx"),
    extraDirsOrFiles: [join(WEB_REACT_SRC, "components/chat")],
  }),
  messageRendererCore: () => ({
    entryFile: join(WEB_REACT_SRC, "components/MessageRenderer.tsx"),
    extraDirsOrFiles: [
      join(WEB_REACT_SRC, "components/chat/messageRenderer"),
      join(WEB_REACT_SRC, "components/chat/timelineProjection.ts"),
    ],
  }),
  socket: () => ({
    entryFile: join(WEB_REACT_SRC, "lib/chat/socket.ts"),
    extraDirsOrFiles: [join(WEB_REACT_SRC, "lib/chat/socket")],
  }),
  persist: () => ({
    entryFile: join(WEB_REACT_SRC, "lib/persist.ts"),
    extraDirsOrFiles: [
      join(WEB_REACT_SRC, "lib/sessionIdbStore.ts"),
      join(WEB_REACT_SRC, "lib/chat/sessionIdbStore.ts"),
      join(WEB_REACT_SRC, "lib/persist"),
    ],
  }),
  reducer: () => ({
    entryFile: join(WEB_REACT_SRC, "lib/chat/reducer.ts"),
    extraDirsOrFiles: [join(WEB_REACT_SRC, "lib/chat/reducers")],
  }),
  render: () => ({
    entryFile: join(WEB_REACT_SRC, "lib/chat/render.ts"),
    extraDirsOrFiles: [join(WEB_REACT_SRC, "lib/chat/render")],
  }),
  toolCard: () => ({
    entryFile: join(WEB_REACT_SRC, "components/ToolCard.tsx"),
    extraDirsOrFiles: [join(WEB_REACT_SRC, "components/tool")],
  }),
  app: () => ({
    entryFile: join(WEB_REACT_SRC, "App.tsx"),
    extraDirsOrFiles: [
      join(WEB_REACT_SRC, "hooks"),
      join(WEB_REACT_SRC, "components"),
    ],
  }),
};

export function inferEsbuildLoader(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".tsx":
      return "tsx";
    case ".ts":
      return "ts";
    case ".jsx":
      return "jsx";
    case ".css":
      return "css";
    default:
      return "js";
  }
}

function countNeedleMatches(contents, needle) {
  if (typeof needle === "string") {
    if (needle.length === 0) throw new Error("sourceBundle: mutation needle must not be empty");
    return contents.split(needle).length - 1;
  }
  if (needle instanceof RegExp) {
    const flags = needle.flags.includes("g") ? needle.flags : `${needle.flags}g`;
    const re = new RegExp(needle.source, flags);
    let count = 0;
    while (re.exec(contents) !== null) {
      count += 1;
      if (re.lastIndex === 0) break;
    }
    return count;
  }
  throw new TypeError("sourceBundle: mutation needle must be a string or RegExp");
}

function applyNeedleReplace(contents, needle, replace) {
  if (typeof needle === "string") {
    return contents.split(needle).join(
      typeof replace === "function" ? replace(needle) : replace,
    );
  }
  const flags = needle.flags.includes("g") ? needle.flags : `${needle.flags}g`;
  const re = new RegExp(needle.source, flags);
  return contents.replace(re, replace);
}

function normalizeTargets(options) {
  if (Array.isArray(options.targets) && options.targets.length > 0) {
    return options.targets;
  }
  if (options.entryFile || options.files || options.mutations) {
    return [
      {
        entryFile: options.entryFile,
        extraDirsOrFiles: options.extraDirsOrFiles ?? [],
        files: options.files,
        mutations: options.mutations ?? [],
        label: options.label,
      },
    ];
  }
  throw new Error("createSourceMutationPlugin: requires targets or entryFile + mutations");
}

/**
 * Build an esbuild plugin that automatically locates the concrete file(s)
 * inside one or more module families containing each mutation needle, injects
 * the mutation via `onLoad`, and fails loudly on zero-hit, unexpected match
 * counts, or unbundled/dead target files.
 */
export function createSourceMutationPlugin(options) {
  const {
    name = "module-family-source-mutation",
    onTransform,
  } = options;
  const targets = normalizeTargets(options);
  const filePlans = new Map();

  for (const target of targets) {
    const candidateFiles = target.files
      ? collectModuleFamilyFiles(null, target.files)
      : collectModuleFamilyFiles(target.entryFile, target.extraDirsOrFiles ?? []);
    if (candidateFiles.length === 0) {
      throw new Error(
        `[${name}] no source files found for target ${target.label ?? target.entryFile ?? "(unnamed)"}`,
      );
    }
    const familyContents = candidateFiles.map((filePath) => ({
      path: filePath,
      contents: readFileSync(filePath, "utf8"),
    }));

    for (const mutation of target.mutations) {
      const expectedExact =
        mutation.exactCount !== undefined
          ? mutation.exactCount
          : mutation.minCount !== undefined
            ? undefined
            : 1;
      const expectedMin = mutation.minCount ?? 1;
      let totalMatches = 0;
      const matchedFiles = [];

      for (const file of familyContents) {
        const count = countNeedleMatches(file.contents, mutation.needle);
        if (count > 0) {
          totalMatches += count;
          matchedFiles.push({ path: file.path, count });
        }
      }

      const desc = mutation.label ?? String(mutation.needle);
      const scopeDesc = target.label ?? target.entryFile ?? candidateFiles[0];
      if (totalMatches === 0) {
        throw new Error(
          `[${name}] zero matches for mutation "${desc}" across ${candidateFiles.length} file(s) in ${scopeDesc}`,
        );
      }
      if (expectedExact !== undefined && totalMatches !== expectedExact) {
        throw new Error(
          `[${name}] expected ${expectedExact} match(es) for "${desc}" in ${scopeDesc}, found ${totalMatches} in ${matchedFiles.map((m) => `${m.path}(${m.count})`).join(", ")}`,
        );
      }
      if (totalMatches < expectedMin) {
        throw new Error(
          `[${name}] expected >= ${expectedMin} match(es) for "${desc}" in ${scopeDesc}, found ${totalMatches}`,
        );
      }

      for (const hit of matchedFiles) {
        if (!filePlans.has(hit.path)) filePlans.set(hit.path, []);
        filePlans.get(hit.path).push(mutation);
      }
    }
  }

  return {
    name,
    setup(build) {
      const loadedPaths = new Set();
      build.onLoad({ filter: /\.(?:ts|tsx|js|jsx|mjs|cjs|css)$/ }, (args) => {
        const actual = resolve(args.path);
        const mutations = filePlans.get(actual);
        if (!mutations) return;

        const before = readFileSync(actual, "utf8");
        let after = before;
        let appliedCount = 0;
        for (const mutation of mutations) {
          const hits = countNeedleMatches(after, mutation.needle);
          if (hits === 0) {
            throw new Error(
              `[${name}] mutation "${mutation.label ?? String(mutation.needle)}" disappeared while transforming ${actual}`,
            );
          }
          after = applyNeedleReplace(after, mutation.needle, mutation.replace);
          appliedCount += hits;
        }
        loadedPaths.add(actual);
        onTransform?.({ path: actual, before, after, appliedCount });
        return {
          contents: after,
          loader: inferEsbuildLoader(actual),
          resolveDir: dirname(actual),
        };
      });

      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        const unloaded = [...filePlans.keys()].filter((filePath) => !loadedPaths.has(filePath));
        if (unloaded.length > 0) {
          return {
            errors: [
              {
                text: `[${name}] mutation target file(s) were never loaded by esbuild bundle: ${unloaded.join(", ")}`,
              },
            ],
          };
        }
      });
    },
  };
}

/**
 * Build an esbuild plugin that replaces a single entry file (e.g. swapping a
 * facade/entry with a pinned historical snapshot) and fails loudly if esbuild
 * never loaded that file.
 */
export function createFileOverridePlugin({
  name = "source-file-override",
  targetFile,
  replacementContents,
  loader,
  onLoad,
}) {
  const targetAbs = toFsPath(targetFile);
  if (!existsSync(targetAbs)) {
    throw new Error(`[${name}] targetFile does not exist: ${targetAbs}`);
  }
  if (typeof replacementContents !== "string") {
    throw new TypeError(`[${name}] replacementContents must be a string`);
  }
  return {
    name,
    setup(build) {
      let applied = false;
      build.onLoad({ filter: /\.(?:ts|tsx|js|jsx|mjs|cjs|css)$/ }, (args) => {
        const actual = resolve(args.path);
        if (actual !== targetAbs) return;
        applied = true;
        onLoad?.(actual);
        return {
          contents: replacementContents,
          loader: loader ?? inferEsbuildLoader(actual),
          resolveDir: dirname(actual),
        };
      });
      build.onEnd((result) => {
        if (result.errors.length === 0 && !applied) {
          return {
            errors: [
              {
                text: `[${name}] override target ${targetAbs} was never loaded by esbuild bundle`,
              },
            ],
          };
        }
      });
    },
  };
}
