#!/usr/bin/env -S npx tsx
/**
 * Ops 脚本: 在所有 compute hosts 上清理 runtime image —— 仅保留显式传入的
 * tag,其余 `openclaude/openclaude-runtime:*` 全删 + dangling layer prune。
 *
 * 用法:
 *   npx tsx scripts/pool-disk-cleanup.ts <keep1> [keep2 ...]
 * 例(分发完 v1.0.104 后,保留新版 + 上一版作 rollback fallback):
 *   npx tsx scripts/pool-disk-cleanup.ts \
 *     openclaude/openclaude-runtime:v1.0.104 \
 *     openclaude/openclaude-runtime:v1.0.98
 *
 * 设计:
 *   - keepTags 必须显式传 repo:tag 完整字符串,不传 / 含通配符 → exit 2
 *   - self host (name='self', 127.0.0.1) 走本地 docker
 *   - 其余 host 走 sshRun(复用 sshExec.ts)
 *   - 每个 tag `docker image rm ... 2>&1 || true` —— in-use 不阻塞
 *     (跑着的容器引用的 image 删不掉是预期行为,不算硬错)
 *   - 整体 exit code 看 SSH / list / prune 是否硬错;rm 单条失败不影响
 *
 * 在 deploy/distribute 流水线中由 distribute-image-explicit.ts 自动调用。
 */
import { execFileSync } from "node:child_process";
import { listAllHosts } from "../packages/commercial/src/compute-pool/queries.js";
import { decryptSshPassword } from "../packages/commercial/src/compute-pool/crypto.js";
import { sshRun, type SshTarget } from "../packages/commercial/src/compute-pool/sshExec.js";

const TIMEOUT_MS = 120_000;
const RUNTIME_REPO = "openclaude/openclaude-runtime";

const keepTags = process.argv.slice(2);
if (keepTags.length === 0) {
  console.error("usage: pool-disk-cleanup.ts <keepTag1> [keepTag2 ...]");
  console.error("       (full 'repo:tag' strings, e.g. openclaude/openclaude-runtime:v1.0.104)");
  process.exit(2);
}
for (const t of keepTags) {
  if (!t.startsWith(`${RUNTIME_REPO}:`) || t.includes("*") || t.endsWith(":")) {
    console.error(`invalid keep tag: ${t}`);
    console.error(`  expected format: ${RUNTIME_REPO}:<tag> (no wildcards)`);
    process.exit(2);
  }
}
const keepSet = new Set(keepTags);

interface HostResult {
  name: string;
  ok: boolean;
  err?: string;
  removedTags: string[];
  beforeDf: string;
  afterDf: string;
}

async function runOnSelf(): Promise<HostResult> {
  const name = "self";
  const result: HostResult = { name, ok: true, removedTags: [], beforeDf: "", afterDf: "" };
  try {
    result.beforeDf = execFileSync("df", ["-h", "/"], { encoding: "utf8" }).trim().split("\n").pop() ?? "";
    const list = execFileSync(
      "docker",
      ["images", RUNTIME_REPO, "--format", "{{.Repository}}:{{.Tag}}"],
      { encoding: "utf8" },
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const toRemove = list.filter((t) => !keepSet.has(t) && !t.endsWith(":<none>"));
    console.log(`\n==== self (local docker) ====`);
    console.log(`  before: ${result.beforeDf}`);
    console.log(`  found ${list.length} runtime tag(s): ${list.join(", ") || "(none)"}`);
    console.log(`  keep:   ${keepTags.join(", ")}`);
    console.log(`  remove: ${toRemove.join(", ") || "(none)"}`);
    for (const tag of toRemove) {
      try {
        const out = execFileSync("docker", ["image", "rm", tag], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        console.log(`  rm ${tag}: ${out.trim().split("\n").pop()}`);
        result.removedTags.push(tag);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
        console.log(`  rm ${tag}: FAILED (${msg}) — continuing`);
      }
    }
    const pruneOut = execFileSync("docker", ["image", "prune", "-f"], { encoding: "utf8" });
    console.log(`  prune:  ${pruneOut.trim().split("\n").pop()}`);
    result.afterDf = execFileSync("df", ["-h", "/"], { encoding: "utf8" }).trim().split("\n").pop() ?? "";
    console.log(`  after:  ${result.afterDf}`);
  } catch (e: unknown) {
    result.ok = false;
    result.err = e instanceof Error ? e.message : String(e);
    console.log(`  HARD ERROR: ${result.err}`);
  }
  return result;
}

async function runOnRemote(target: SshTarget, name: string): Promise<HostResult> {
  const result: HostResult = { name, ok: true, removedTags: [], beforeDf: "", afterDf: "" };
  console.log(`\n==== ${name} (${target.host}) ====`);
  try {
    const r0 = await sshRun(target, "df -h / | tail -1", TIMEOUT_MS);
    result.beforeDf = r0.stdout.trimEnd();
    console.log(`  before: ${result.beforeDf}`);

    const rl = await sshRun(
      target,
      `docker images ${RUNTIME_REPO} --format '{{.Repository}}:{{.Tag}}'`,
      TIMEOUT_MS,
    );
    const list = rl.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const toRemove = list.filter((t) => !keepSet.has(t) && !t.endsWith(":<none>"));
    console.log(`  found ${list.length} runtime tag(s): ${list.join(", ") || "(none)"}`);
    console.log(`  keep:   ${keepTags.join(", ")}`);
    console.log(`  remove: ${toRemove.join(", ") || "(none)"}`);

    for (const tag of toRemove) {
      const r = await sshRun(target, `docker image rm ${tag} 2>&1 || true`, TIMEOUT_MS);
      const out = (r.stdout || "").trim().split("\n").pop() ?? "";
      console.log(`  rm ${tag}: ${out || "(no output)"}`);
      // 看输出里 "Untagged" 或 "Deleted" 视为成功;否则当作 in-use,不计入 removed
      if (/Untagged|Deleted/.test(r.stdout)) {
        result.removedTags.push(tag);
      }
    }

    const rp = await sshRun(target, "docker image prune -f", TIMEOUT_MS);
    console.log(`  prune:  ${(rp.stdout || "").trim().split("\n").pop() ?? ""}`);

    const r1 = await sshRun(target, "df -h / | tail -1", TIMEOUT_MS);
    result.afterDf = r1.stdout.trimEnd();
    console.log(`  after:  ${result.afterDf}`);
  } catch (e: unknown) {
    result.ok = false;
    result.err = e instanceof Error ? e.message : String(e);
    console.log(`  HARD ERROR: ${result.err}`);
  }
  return result;
}

async function main(): Promise<void> {
  const allHosts = await listAllHosts();
  console.log(`[disk-cleanup] keep tags: ${keepTags.join(", ")}`);
  console.log(`[disk-cleanup] hosts to clean: ${allHosts.map((h) => `${h.name}(${h.status})`).join(", ")}`);

  const results: HostResult[] = [];
  for (const row of allHosts) {
    if (row.name === "self") {
      results.push(await runOnSelf());
      continue;
    }
    let password: Buffer | null = null;
    try {
      password = decryptSshPassword(row.id, row.ssh_password_nonce, row.ssh_password_ct);
    } catch (e) {
      console.log(`\n==== ${row.name} (${row.host}) ====\n  decrypt-password FAILED: ${(e as Error).message}`);
      results.push({ name: row.name, ok: false, err: "decrypt-password failed", removedTags: [], beforeDf: "", afterDf: "" });
      continue;
    }
    const target: SshTarget = {
      host: row.host,
      port: row.ssh_port,
      username: row.ssh_user,
      password,
      knownHostsContent: null,
    };
    try {
      results.push(await runOnRemote(target, row.name));
    } finally {
      password.fill(0);
    }
  }

  console.log("\n==== summary ====");
  let hardFail = 0;
  for (const r of results) {
    const tag = r.ok ? "OK" : "FAIL";
    console.log(`  [${tag.padEnd(4)}] ${r.name.padEnd(20)} removed=${r.removedTags.length}${r.err ? " err=" + r.err : ""}`);
    if (!r.ok) hardFail++;
  }
  if (hardFail > 0) {
    console.error(`[disk-cleanup] ${hardFail} host(s) hit hard errors`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[disk-cleanup] crashed:", e);
  process.exit(1);
});
