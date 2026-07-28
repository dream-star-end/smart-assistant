import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertReplicatedRoots,
  loadRunEvidence,
  runSetDescriptor,
} from "./replication-evidence.mjs";

function root(tag) {
  const dir = join(mkdtempSync(join(tmpdir(), `v5-replication-${tag}-`)), "runs");
  mkdirSync(dir);
  for (const index of [1, 2]) {
    writeFileSync(join(dir, `run-${index}.json`), JSON.stringify({
      peer_id: `${tag}-peer-${index}`,
      pair_execution_id: `${tag}-pair-${index}`,
      transcript_sha256: `${tag}${index}`.padEnd(64, tag),
      container: { id: `${tag}-container-${index}` },
    }));
  }
  return dir;
}

describe("v5 replicated evaluation evidence", () => {
  it("accepts disjoint roots and returns a stable sorted run set", () => {
    const first = loadRunEvidence(root("a"));
    const second = loadRunEvidence(root("b"));
    second[1].run.container.id = second[0].run.container.id;
    second[1].run.pair_execution_id = second[0].run.pair_execution_id;
    assert.doesNotThrow(() => assertReplicatedRoots(first, second));
    assert.deepEqual(
      runSetDescriptor(first).map((item) => item.name),
      ["run-1.json", "run-2.json"],
    );
  });

  it("rejects cross-root Docker, peer, pair, transcript, or run reuse", () => {
    const first = loadRunEvidence(root("c"));
    for (const field of [
      ["container", "id"],
      ["peer_id"],
      ["pair_execution_id"],
      ["transcript_sha256"],
    ]) {
      const second = loadRunEvidence(root(`d${field.join("")}`));
      if (field.length === 2) second[0].run[field[0]][field[1]] = first[0].run[field[0]][field[1]];
      else second[0].run[field[0]] = first[0].run[field[0]];
      assert.throws(() => assertReplicatedRoots(first, second), /replicated roots reuse/);
    }
    assert.throws(() => assertReplicatedRoots(first, structuredClone(first)), /replicated roots reuse/);
  });

  it("fails closed when a root contains failed attempt evidence", () => {
    const dir = root("e");
    writeFileSync(join(dir, "run.failed.json"), "{}");
    assert.throws(() => loadRunEvidence(dir), /failed attempt evidence/);
  });
});
