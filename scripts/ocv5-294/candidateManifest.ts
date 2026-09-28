/** Source identity for the modules the six-HTTP verifier actually loads. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROXY = fileURLToPath(new URL("../../packages/commercial/src/http/proxy/", import.meta.url));
const ENTRIES = [
  "boxRequestGate.ts",
  "boxCacheAnnotations.ts",
  "boxToolResultMatcher.ts",
  "boxToolCatalog.ts",
  "boxCallFingerprint.ts",
];

function localSpec(source: string): string[] {
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((match) => match[1]!);
}

function resolveSpec(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
    : [base, `${base}.ts`, `${base}.tsx`];
  for (const candidate of candidates) {
    if (!candidate.startsWith(PROXY)) return null;
    try { if (statSync(candidate).isFile()) return candidate; }
    catch { /* try the next extension */ }
  }
  return null;
}

export type ManifestEntry = { path: string; sha256: string };

/** Transitive proxy-local imports of gate, normalizer, matcher, catalog, and context. */
export function candidateManifest(): ManifestEntry[] {
  const pending = ENTRIES.map((name) => resolve(PROXY, name));
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of localSpec(readFileSync(file, "utf8"))) {
      const next = resolveSpec(file, spec);
      if (next && !seen.has(next)) pending.push(next);
    }
  }
  return [...seen].sort().map((file) => ({
    path: file.slice(PROXY.length),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }));
}

export function manifestDrift(before: readonly ManifestEntry[], after: readonly ManifestEntry[]): string | null {
  if (before.length !== after.length || before.length < ENTRIES.length) return "MANIFEST_COUNT";
  for (let i = 0; i < before.length; i++) {
    if (before[i]?.path !== after[i]?.path || before[i]?.sha256 !== after[i]?.sha256) {
      return `MANIFEST_DRIFT_${before[i]?.path ?? i}`;
    }
  }
  for (const name of ENTRIES) {
    if (!before.some((item) => item.path === name)) return `MANIFEST_MISSING_${name}`;
  }
  return null;
}

export function proxyFileUrl(name: string): URL {
  return pathToFileURL(resolve(PROXY, name));
}
