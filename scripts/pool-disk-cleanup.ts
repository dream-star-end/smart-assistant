/**
 * 一次性 ops 脚本: 在所有 ready remote pool host 删旧 runtime 镜像 tag,
 * 释放磁盘空间。**只**删显式列出的 STALE_TAGS,不动任何 active/recent tag。
 *
 * 当前 STALE_TAGS = 2026-04-28~29 早期 dev/leak 镜像,boss 已确认这些不再用。
 * 当前在用 (v1.0.61b) 与最新 (v1.0.61c) 全部保留;v1.0.61 暂留作 fallback。
 *
 * 用法:
 *   bash -c "set -a; source /etc/openclaude/commercial.env; set +a; \
 *     cd /opt/openclaude/openclaude && \
 *     npx tsx scripts/pool-disk-cleanup.ts"
 */
import { decryptSshPassword } from "../packages/commercial/src/compute-pool/crypto.js";
import * as queries from "../packages/commercial/src/compute-pool/queries.js";
import { sshRun, type SshTarget } from "../packages/commercial/src/compute-pool/sshExec.js";

const TIMEOUT_MS = 120_000;

const STALE_TAGS = [
  "openclaude/openclaude-runtime:dcf90f4leak2",
  "openclaude/openclaude-runtime:latest",
  "openclaude/openclaude-runtime:ca3dd83cc50d",
  "openclaude/openclaude-runtime:333ed605fa89-bgfix",
];

async function cleanHost(target: SshTarget, name: string): Promise<void> {
  console.log(`\n==== ${name} (${target.host}) ====`);

  // df 前
  try {
    const r0 = await sshRun(target, "df -h / 2>&1 | tail -1", TIMEOUT_MS);
    console.log(`  before: ${(r0.stdout || "").trimEnd()}`);
  } catch (e) {
    console.log(`  df-before err: ${(e as Error).message}`);
  }

  // 删 tag
  for (const tag of STALE_TAGS) {
    try {
      const r = await sshRun(target, `docker image rm ${tag} 2>&1 || true`, TIMEOUT_MS);
      const out = (r.stdout || "").trim();
      console.log(`  rm ${tag}: ${out || "(no output)"}`);
    } catch (e) {
      console.log(`  rm ${tag} err: ${(e as Error).message}`);
    }
  }

  // dangling prune (untagged layers)
  try {
    const r = await sshRun(target, "docker image prune -f 2>&1", TIMEOUT_MS);
    console.log(`  prune: ${(r.stdout || "").trim()}`);
  } catch (e) {
    console.log(`  prune err: ${(e as Error).message}`);
  }

  // df 后
  try {
    const r1 = await sshRun(target, "df -h / 2>&1 | tail -1", TIMEOUT_MS);
    console.log(`  after:  ${(r1.stdout || "").trimEnd()}`);
  } catch (e) {
    console.log(`  df-after err: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  const allHosts = (await queries.listAllHostsWithCounts()).map((h) => h.row);
  const targets = allHosts.filter((h) => h.name !== "self" && h.status === "ready");
  console.log(`[disk-cleanup] cleaning ${targets.length} remote host(s):`, targets.map((h) => h.name).join(", "));

  for (const row of targets) {
    let password: Buffer | null = null;
    try {
      password = decryptSshPassword(row.id, row.ssh_password_nonce, row.ssh_password_ct);
    } catch (e) {
      console.log(`\n==== ${row.name} (${row.host}) ====\n  decrypt failed: ${(e as Error).message}`);
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
      await cleanHost(target, row.name);
    } finally {
      password.fill(0);
    }
  }
}

main().catch((e) => {
  console.error("[disk-cleanup] crashed:", e);
  process.exit(99);
});
