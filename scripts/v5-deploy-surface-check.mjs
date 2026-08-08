#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const KNOWN_SURFACES = new Set([
  "master",
  "web",
  "runtime-source",
  "platform-runtime",
  "egress",
]);
const RAW_META = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])(\d+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !["--repo", "--base", "--target"].includes(key)) {
      fail("usage: v5-deploy-surface-check.mjs --repo <path> --base <40hex> --target <40hex>");
    }
    options[key.slice(2)] = value;
  }
  if (!options.repo || !COMMIT.test(options.base ?? "") || !COMMIT.test(options.target ?? "")) {
    fail("repo, base, and target (full 40-hex commits) are required");
  }
  return options;
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function globToRegExp(glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      expression += `\\${char}`;
    } else {
      expression += char;
    }
  }
  return new RegExp(`${expression}$`);
}

function loadManifest(repo) {
  const file = path.join(repo, "deploy/v5/selfheal-deploy-surfaces.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read deploy surface manifest: ${error.message}`);
  }
  if (
    !manifest
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || !exactKeys(manifest, ["schema", "version", "_comment", "surfaces", "rules", "manual"])
    || manifest.schema !== "selfheal-deploy-surfaces"
    || manifest.version !== 1
    || !manifest.surfaces
    || typeof manifest.surfaces !== "object"
    || Array.isArray(manifest.surfaces)
    || !Array.isArray(manifest.rules)
    || !Array.isArray(manifest.manual)
  ) {
    fail("deploy surface manifest schema/version/shape is invalid");
  }
  for (const [name, definition] of Object.entries(manifest.surfaces)) {
    if (!KNOWN_SURFACES.has(name) || !definition || typeof definition !== "object" || Array.isArray(definition)) {
      fail(`invalid deploy surface definition: ${name}`);
    }
  }
  const rules = manifest.rules.map((rule) => {
    if (
      !rule
      || typeof rule !== "object"
      || Array.isArray(rule)
      || !exactKeys(rule, ["glob", "surface", "note"])
      || typeof rule.glob !== "string"
      || rule.glob.length === 0
      || typeof rule.surface !== "string"
      || !KNOWN_SURFACES.has(rule.surface)
      || !manifest.surfaces[rule.surface]
      || (rule.note !== undefined && typeof rule.note !== "string")
    ) {
      fail("invalid deploy surface rule");
    }
    return { ...rule, matcher: globToRegExp(rule.glob) };
  });
  const manual = manifest.manual.map((entry) => {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || !exactKeys(entry, ["glob", "note"])
      || typeof entry.glob !== "string"
      || entry.glob.length === 0
      || (entry.note !== undefined && typeof entry.note !== "string")
    ) {
      fail("invalid deploy manual rule");
    }
    return { ...entry, matcher: globToRegExp(entry.glob) };
  });
  return { rules, manual };
}

function git(repo, args, encoding = "utf8") {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function validatePath(file) {
  if (!file || file.startsWith("/") || file.split("/").includes("..")) {
    fail(`invalid changed path: ${JSON.stringify(file)}`);
  }
}

function classify(repo, base, target, manifest) {
  git(repo, ["cat-file", "-e", `${base}^{commit}`]);
  git(repo, ["cat-file", "-e", `${target}^{commit}`]);
  git(repo, ["merge-base", "--is-ancestor", base, target]);
  const raw = git(repo, [
    "diff",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "-z",
    `${base}..${target}`,
  ]);
  const tokens = raw.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const surfaces = new Set();
  const matches = Object.fromEntries([...KNOWN_SURFACES].map((name) => [name, []]));
  const manual = [];
  const changed = [];
  let index = 0;
  while (index < tokens.length) {
    const meta = tokens[index++];
    const parsed = RAW_META.exec(meta);
    if (!parsed) fail(`malformed raw diff record: ${JSON.stringify(meta)}`);
    const [, oldMode, newMode, , , status] = parsed;
    const pathCount = status === "R" || status === "C" ? 2 : 1;
    const paths = tokens.slice(index, index + pathCount);
    if (paths.length !== pathCount) fail("truncated raw diff path record");
    index += pathCount;
    for (const file of paths) validatePath(file);
    changed.push(...paths);

    const unsupportedStatus = !["A", "M", "D"].includes(status);
    const unsupportedMode = [oldMode, newMode].some(
      (mode) => !["000000", "100644", "100755"].includes(mode),
    );
    if (unsupportedStatus || unsupportedMode) {
      for (const file of paths) {
        manual.push({
          path: file,
          reason: unsupportedStatus ? `unsupported_status:${status}` : `unsupported_mode:${oldMode}->${newMode}`,
        });
      }
      continue;
    }

    for (const file of paths) {
      const manualRule = manifest.manual.find((entry) => entry.matcher.test(file));
      if (manualRule) {
        manual.push({ path: file, reason: `manual_glob:${manualRule.glob}` });
        continue;
      }
      const hitRules = manifest.rules.filter((rule) => rule.matcher.test(file));
      if (hitRules.length === 0) {
        manual.push({ path: file, reason: "unmatched_path" });
        continue;
      }
      for (const rule of hitRules) {
        surfaces.add(rule.surface);
        matches[rule.surface].push(file);
      }
    }
  }
  for (const name of Object.keys(matches)) matches[name] = [...new Set(matches[name])].sort();
  return {
    base,
    target,
    surfaces: [...surfaces].sort(),
    manual,
    matches,
    changed: [...new Set(changed)].sort(),
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(options.repo);
  process.stdout.write(`${JSON.stringify(classify(options.repo, options.base, options.target, manifest))}\n`);
} catch (error) {
  process.stderr.write(`v5-deploy-surface-check: ${error.message}\n`);
  process.exitCode = 2;
}
