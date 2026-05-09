#!/usr/bin/env -S npx tsx
/**
 * One-shot ops: distribute an explicit image tag to all ready remote
 * compute hosts, then prune stale runtime tags everywhere — bypassing the
 * OC_RUNTIME_IMAGE env coupling on the admin /distribute-image endpoint.
 *
 * Why this exists:
 *   1. admin endpoint reads process.env.OC_RUNTIME_IMAGE which only
 *      refreshes on master restart. For staged rollout (preheat image →
 *      flip env → restart) we need to push BEFORE master env flips.
 *   2. boss requires每次分发完镜像必须自动清旧 runtime tag(否则 host
 *      磁盘累积新版 ~3.8GB 永不释放,self 之前到 87%)。
 *
 * Usage (run on commercial-v3, env loaded):
 *   set -a; source /etc/openclaude/commercial.env; set +a
 *   cd /opt/openclaude/openclaude
 *   npx tsx scripts/distribute-image-explicit.ts <newTag> <prevTag>
 *
 * Where:
 *   newTag  = 新分发的完整 repo:tag(e.g. openclaude/openclaude-runtime:v1.0.104)
 *   prevTag = 上一版完整 repo:tag,作为 rollback fallback 保留
 *             (传同一个 newTag 即"清光除当前外的全部")
 *
 * 行为:
 *   1. 调 distributePreheatToAllHosts(newTag) → 把镜像 SCP 到所有 ready remote host
 *   2. 不论 distribute 部分失败/全部成功,**总是**接着调 pool-disk-cleanup 清理
 *      所有 host(self + remote)上的非 keep tag
 *
 * 失败语义:
 *   - distribute 任意一个 host 失败 → 标记 hadError(继续 cleanup,完了 exit 1)
 *   - cleanup 遇到硬错(SSH/list/prune)→ 标记 hadError(exit 1)
 *   - cleanup 单条 image rm 失败(in-use)→ 静默跳过,不影响 exit
 */
import { distributePreheatToAllHosts } from "../packages/commercial/src/compute-pool/imageDistribute.js";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_REPO = "openclaude/openclaude-runtime";
const newTag = process.argv[2];
const prevTag = process.argv[3];
if (!newTag || !prevTag) {
  console.error("usage: distribute-image-explicit.ts <newTag> <prevTag>");
  console.error(`  e.g. ... ${RUNTIME_REPO}:v1.0.104 ${RUNTIME_REPO}:v1.0.98`);
  console.error("  (传同一个 tag 两次 = 只保留这一个)");
  process.exit(2);
}
for (const t of [newTag, prevTag]) {
  if (!t.startsWith(`${RUNTIME_REPO}:`) || t.includes("*") || t.endsWith(":")) {
    console.error(`invalid tag: ${t}`);
    console.error(`  expected format: ${RUNTIME_REPO}:<tag>`);
    process.exit(2);
  }
}

let hadError = false;

// ─── 1. distribute ─────────────────────────────────────────────────────
const startedAt = Date.now();
console.log(`[distribute] starting: image=${newTag}`);
const results = await distributePreheatToAllHosts(newTag);
const elapsedMs = Date.now() - startedAt;
console.log(`[distribute] done in ${elapsedMs}ms — ${results.length} target(s):`);
for (const r of results) {
  const tag = r.outcome === "error" ? "FAIL" : r.outcome;
  console.log(
    `  [${tag.padEnd(7)}] ${r.hostName.padEnd(20)} ${r.durationMs}ms${
      r.bytes !== undefined ? ` ${(r.bytes / 1024 / 1024).toFixed(1)}MB` : ""
    }${r.error ? ` — ${r.error}` : ""}`,
  );
  if (r.outcome === "error") hadError = true;
}

// ─── 2. cleanup (总是跑,即便 distribute 部分失败) ────────────────────
console.log(`\n[cleanup] purging stale runtime images, keeping: ${newTag} ${prevTag}`);
const cleanupScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "pool-disk-cleanup.ts",
);
const keepArgs = newTag === prevTag ? [newTag] : [newTag, prevTag];
const cleanupExit: number = await new Promise((resolve) => {
  const proc = spawn("npx", ["tsx", cleanupScript, ...keepArgs], {
    stdio: "inherit",
    env: process.env,
  });
  proc.on("exit", (code) => resolve(code ?? 1));
  proc.on("error", (err) => {
    console.error("[cleanup] spawn error:", err);
    resolve(1);
  });
});
if (cleanupExit !== 0) {
  console.error(`[cleanup] exited ${cleanupExit} — at least one host had hard error`);
  hadError = true;
}

process.exit(hadError ? 1 : 0);
