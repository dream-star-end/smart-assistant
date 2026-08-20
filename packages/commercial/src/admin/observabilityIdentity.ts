import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ControlPlaneIdentity = {
  release: string | null;
  commit: string | null;
};

let cached: ControlPlaneIdentity | null = null;

/** VERSION.json is immutable for a process lifetime; missing stays retryable for dev boots. */
export function controlPlaneIdentity(): ControlPlaneIdentity {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), "VERSION.json"), "utf8")) as {
      tag?: unknown;
      commit?: unknown;
    };
    const value = {
      release: typeof raw.tag === "string" && raw.tag.length <= 160 ? raw.tag : null,
      commit:
        typeof raw.commit === "string" && /^[0-9a-f]{7,40}$/.test(raw.commit)
          ? raw.commit
          : null,
    };
    cached = value;
    return value;
  } catch {
    return { release: null, commit: null };
  }
}

export function resetControlPlaneIdentityForTest(): void {
  cached = null;
}
