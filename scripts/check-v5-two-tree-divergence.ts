#!/usr/bin/env tsx
// Two-tree divergence check (OCV5-376 / P5).
//
// V5 selfhost (feat/v5-selfhost) is the commercial tree (feat/v5-aurora-rewrite) deployed for
// personal use. Only a few paths may legitimately differ between the two; they are listed in
// .github/two-tree/selfhost-only.txt. Every other tracked file should be byte-identical on both
// tips once the trees are synchronised.
//
//   --against <ref>   the other tree's tip (default origin/feat/v5-aurora-rewrite)
//   --list <file>     write every diverged path with its status and class
//   --enforce         exit 1 when a path outside the allowlist differs
//
// Without --enforce it only reports, because the trees are not synchronised yet. After the
// unified sync, CI switches to --enforce so a shared file cannot drift again unnoticed.
// The allowlist is checked either way: a pattern that matches no tracked file is an error,
// so the list cannot keep entries for paths that no longer exist.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
export const ALLOWLIST = ".github/two-tree/selfhost-only.txt";

export type Divergence = { status: string; path: string; allowed: boolean };

/** `*` matches within one path segment, `**` across segments. Nothing else is special. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
      if (glob[i + 1] === "/") i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function parseAllowlist(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

export function classify(nameStatus: string, patterns: string[]): Divergence[] {
  const regexes = patterns.map(globToRegExp);
  return nameStatus
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t");
      return { status, path, allowed: regexes.some((re) => re.test(path)) };
    });
}

/** Patterns that match none of the given paths. */
export function stalePatterns(patterns: string[], trackedPaths: string[]): string[] {
  return patterns.filter((pattern) => {
    const re = globToRegExp(pattern);
    return !trackedPaths.some((path) => re.test(path));
  });
}

export function summarize(divergences: Divergence[]): string {
  const shared = divergences.filter((item) => !item.allowed);
  const byDir = new Map<string, number>();
  for (const item of shared) {
    const dir = item.path.split("/").slice(0, item.path.startsWith("packages/") ? 2 : 1).join("/");
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const lines = [
    `diverged paths: ${divergences.length} (selfhost-only allowed: ${divergences.length - shared.length}, shared: ${shared.length})`,
    ...[...byDir.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([dir, count]) => `  ${String(count).padStart(5)}  ${dir}`),
  ];
  return lines.join("\n");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main(argv: string[]): number {
  let against = "origin/feat/v5-aurora-rewrite";
  let listFile = "";
  let enforce = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--against") against = argv[++i] ?? "";
    else if (argv[i] === "--list") listFile = argv[++i] ?? "";
    else if (argv[i] === "--enforce") enforce = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      return 2;
    }
  }
  const patterns = parseAllowlist(readFileSync(join(ROOT, ALLOWLIST), "utf8"));
  const tracked = git("ls-files").split("\n").filter(Boolean);
  const stale = stalePatterns(patterns, tracked);
  if (stale.length > 0) {
    console.error(`✗ ${ALLOWLIST}: patterns that match no tracked file:\n  ${stale.join("\n  ")}`);
    return 1;
  }
  git("rev-parse", "--verify", `${against}^{commit}`);
  const divergences = classify(git("diff", "--no-renames", "--name-status", against, "HEAD"), patterns);
  if (listFile) {
    writeFileSync(
      listFile,
      divergences.map((item) => `${item.status}\t${item.allowed ? "selfhost-only" : "shared"}\t${item.path}`).join("\n") + "\n",
    );
  }
  console.log(`two-tree divergence vs ${against}`);
  console.log(summarize(divergences));
  const shared = divergences.filter((item) => !item.allowed);
  if (enforce && shared.length > 0) {
    console.error(`✗ ${shared.length} shared paths differ from ${against}; port the change to both trees or add the path to ${ALLOWLIST} with a reason`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
