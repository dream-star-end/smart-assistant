import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function loadRunEvidence(dir) {
  const names = readdirSync(dir);
  const failed = names.filter((name) => name.endsWith(".failed.json")).sort();
  if (failed.length > 0) {
    throw new Error(`run directory contains failed attempt evidence: ${failed.join(",")}`);
  }
  return names
    .filter(
      (name) =>
        name.endsWith(".json") &&
        !name.endsWith(".frames.json") &&
        !name.endsWith(".failed.json"),
    )
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(dir, name));
      return { name: basename(name), bytes, sha256: sha(bytes), run: JSON.parse(bytes) };
    });
}

export function assertReplicatedRoots(primary, replica) {
  const fields = [
    ["Docker ID", (item) => item.run.container?.id],
    ["peer ID", (item) => item.run.peer_id],
    ["pair execution ID", (item) => item.run.pair_execution_id],
    ["transcript SHA", (item) => item.run.transcript_sha256],
    ["run SHA", (item) => item.sha256],
  ];
  for (const [label, read] of fields) {
    const primaryValues = new Set();
    for (const item of primary) {
      const value = read(item);
      if (typeof value !== "string" || !value) throw new Error(`primary root missing ${label}`);
      primaryValues.add(value);
    }
    for (const item of replica) {
      const value = read(item);
      if (typeof value !== "string" || !value) throw new Error(`replica root missing ${label}`);
      if (primaryValues.has(value)) throw new Error(`replicated roots reuse ${label}: ${value}`);
    }
  }
}

export function runSetDescriptor(entries) {
  return entries.map(({ name, sha256 }) => ({ name, sha256 }));
}

export const _internals = { sha };
