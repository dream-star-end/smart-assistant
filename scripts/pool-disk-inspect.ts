/**
 * 一次性 ops 脚本: 探查所有 ready compute pool host 的磁盘占用。
 * 不做任何写操作 — 只 sshRun `df -h /` + `docker system df` + `ls -lhS images`。
 *
 * 用法:
 *   bash -c "set -a; source /etc/openclaude/commercial.env; set +a; \
 *     cd /opt/openclaude/openclaude && \
 *     npx tsx scripts/pool-disk-inspect.ts"
 *
 * 输出: 按 host 打印一段诊断文本,方便人眼直接读。
 */
import { decryptSshPassword } from "../packages/commercial/src/compute-pool/crypto.js";
import * as queries from "../packages/commercial/src/compute-pool/queries.js";
import { sshRun, type SshTarget } from "../packages/commercial/src/compute-pool/sshExec.js";

const TIMEOUT_MS = 60_000;

async function probeHost(target: SshTarget, name: string): Promise<void> {
  console.log(`\n==== ${name} (${target.host}) ====`);
  for (const cmd of [
    "df -h / 2>&1",
    "docker system df 2>&1",
    "ls -lhS /var/lib/openclaude-v3/images/ 2>/dev/null | head -20",
    "docker images openclaude/openclaude-runtime --format '{{.Tag}}\\t{{.Size}}\\t{{.CreatedAt}}' 2>&1",
  ]) {
    try {
      const r = await sshRun(target, cmd, TIMEOUT_MS);
      console.log(`---- ${cmd}`);
      console.log((r.stdout || "").trimEnd());
      if (r.stderr) console.log("STDERR:", r.stderr.trimEnd());
    } catch (e) {
      console.log(`---- ${cmd}\n  ERROR: ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const allHosts = (await queries.listAllHostsWithCounts()).map((h) => h.row);
  const targets = allHosts.filter((h) => h.name !== "self" && h.status === "ready");
  console.log(`[disk-inspect] probing ${targets.length} remote host(s):`, targets.map((h) => h.name).join(", "));

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
      await probeHost(target, row.name);
    } finally {
      password.fill(0);
    }
  }
}

main().catch((e) => {
  console.error("[disk-inspect] crashed:", e);
  process.exit(99);
});
