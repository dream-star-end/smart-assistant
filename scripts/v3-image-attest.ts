#!/usr/bin/env -S npx tsx
/**
 * v3-image-attest.ts — 一次性 ops 脚本,验证全 4 host 上的 runtime image
 * 标签正确(oc.runtime.features 含 'v3-sink' + oc.runtime.git_sha 命中期望值)。
 *
 * 不能 assert image id 跨 host 一致 —— docker save|load 跨 daemon 必然 sha 漂移
 * (memory v3_image_sha_divergence + v1.0.28 applyHealthSnapshot guard 印证)。
 * labels 在 manifest config 中,跨 daemon 保留,所以 attest 只看 labels。
 *
 * 用法(在 commercial-v3 master 上跑):
 *   set -a; source /etc/openclaude/commercial.env; set +a
 *   cd /opt/openclaude/openclaude
 *   npx tsx scripts/v3-image-attest.ts <newTag> <expectedGitSha>
 * 例:
 *   npx tsx scripts/v3-image-attest.ts openclaude/openclaude-runtime:492dfe55b39f 492dfe55b39f
 *
 * 退出码: 0 = 全 host PASS;1 = 至少一个 host FAIL;2 = usage error
 */

import { execFileSync } from "node:child_process";
import {
  inspectImage as agentInspectImage,
  hostRowToTarget,
  AgentAppError,
} from "../packages/commercial/src/compute-pool/nodeAgentClient.js";
import { listAllHostsWithCounts } from "../packages/commercial/src/compute-pool/queries.js";

const newTag = process.argv[2];
const expectedGitSha = process.argv[3];
if (!newTag || !expectedGitSha) {
  console.error("usage: v3-image-attest.ts <newTag> <expectedGitSha>");
  process.exit(2);
}

function checkLabels(labels: Record<string, string>): string | null {
  const features = (labels?.["oc.runtime.features"] ?? "").trim().split(/\s+/);
  if (!features.includes("v3-sink")) {
    return `features missing v3-sink (got ${JSON.stringify(features)})`;
  }
  const sha = labels?.["oc.runtime.git_sha"];
  if (sha !== expectedGitSha) {
    return `git_sha mismatch: got=${sha} want=${expectedGitSha}`;
  }
  return null;
}

// ─── master self ────────────────────────────────────────────────────────
const masterId = execFileSync(
  "docker",
  ["image", "inspect", newTag, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
const masterLabels = JSON.parse(
  execFileSync(
    "docker",
    ["image", "inspect", newTag, "--format", "{{json .Config.Labels}}"],
    { encoding: "utf8" },
  ).trim(),
);
const masterFail = checkLabels(masterLabels);

const passes: Array<{ host: string; id: string; labels: Record<string, string> }> = [];
const failures: Array<{ host: string; reason: string; detail?: unknown }> = [];

if (masterFail) {
  failures.push({ host: "self/master", reason: masterFail, detail: masterLabels });
} else {
  passes.push({ host: "self/master", id: masterId, labels: masterLabels });
}

// ─── 远端 hosts ─────────────────────────────────────────────────────────
const allHosts = (await listAllHostsWithCounts()).map((x) => x.row);
for (const h of allHosts) {
  if (h.name === "self") continue;
  const target = hostRowToTarget(h);
  try {
    const inspected = await agentInspectImage(target, newTag);
    const labelFail = checkLabels(inspected.labels);
    if (labelFail) {
      failures.push({
        host: h.name,
        reason: labelFail,
        detail: { id: inspected.id, labels: inspected.labels },
      });
    } else {
      passes.push({ host: h.name, id: inspected.id, labels: inspected.labels });
    }
  } catch (e: unknown) {
    if (e instanceof AgentAppError) {
      failures.push({
        host: h.name,
        reason: "inspect-rpc-error",
        detail: { msg: e.message, httpStatus: e.httpStatus, code: e.agentErrCode },
      });
    } else {
      failures.push({
        host: h.name,
        reason: "inspect-throw",
        detail: { msg: e instanceof Error ? e.message : String(e) },
      });
    }
  } finally {
    target.psk?.fill(0);
  }
}

console.log(JSON.stringify({ passes, failures }, null, 2));
process.exit(failures.length > 0 ? 1 : 0);
