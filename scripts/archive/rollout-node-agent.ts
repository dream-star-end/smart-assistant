/**
 * One-off rollout: ship freshly cross-compiled node-agent binary to all
 * non-self compute hosts and restart their systemd unit.
 *
 * Why this exists: 0042 master expects new selfprobe fields from
 * node-agent /health (loaded_image, uplink, egress). Until each host's
 * binary is upgraded, last_uplink_ok / last_egress_probe_ok stay NULL
 * and the placement gate excludes them.
 *
 * Run:
 *   cd /opt/openclaude/openclaude-v3 && \
 *     npx tsx scripts/rollout-node-agent.ts \
 *       /opt/openclaude/openclaude-v3/packages/commercial/node-agent/node-agent
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Pool } from "pg";

import { decryptSshPassword } from "../packages/commercial/src/compute-pool/crypto.js";
import { sshRun, sshUpload } from "../packages/commercial/src/compute-pool/sshExec.js";

const REMOTE_BIN_PATH = "/usr/local/bin/node-agent";
const REMOTE_BIN_TMP = "/usr/local/bin/node-agent.new";

interface HostRow {
  id: string;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_password_nonce: Buffer;
  ssh_password_ct: Buffer;
  agent_port: number;
}

async function main() {
  const binPath = process.argv[2];
  if (!binPath) {
    console.error("usage: rollout-node-agent.ts <local-binary-path>");
    process.exit(2);
  }
  const bin = await fs.readFile(binPath);
  console.log(`local binary: ${binPath} (${bin.byteLength} bytes)`);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL env required");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: dbUrl });
  const { rows } = await pool.query<HostRow>(
    `SELECT id, name, host, ssh_port, ssh_user,
            ssh_password_nonce, ssh_password_ct, agent_port
       FROM compute_hosts
      WHERE name <> 'self'
      ORDER BY name`,
  );
  console.log(`found ${rows.length} non-self hosts:`);
  for (const r of rows) {
    console.log(`  - ${r.name} (${r.host}:${r.ssh_port}, agent_port=${r.agent_port})`);
  }

  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    const start = Date.now();
    let password: Buffer | null = null;
    try {
      password = decryptSshPassword(row.id, row.ssh_password_nonce, row.ssh_password_ct);
      const target = {
        host: row.host,
        port: row.ssh_port,
        username: row.ssh_user,
        password,
        knownHostsContent: null,
      };

      // 1. upload binary to a tmp path and atomically rename via systemctl
      //    stop → mv → start so we don't blow away an in-use file.
      console.log(`[${row.name}] uploading binary to ${REMOTE_BIN_TMP} ...`);
      await sshUpload(target, REMOTE_BIN_TMP, bin, 0o755, 180_000);

      console.log(`[${row.name}] swap binary + restart openclaude-node-agent ...`);
      const swap = await sshRun(
        target,
        `set -e
systemctl stop openclaude-node-agent
mv -f ${REMOTE_BIN_TMP} ${REMOTE_BIN_PATH}
chmod 0755 ${REMOTE_BIN_PATH}
systemctl start openclaude-node-agent
sleep 2
systemctl is-active openclaude-node-agent
${REMOTE_BIN_PATH} --version 2>/dev/null || echo "(binary has no --version)"
`,
        60_000,
      );
      console.log(`[${row.name}] swap stdout:\n${swap.stdout.trim()}`);
      if (swap.stderr.trim()) {
        console.log(`[${row.name}] swap stderr:\n${swap.stderr.trim()}`);
      }
      console.log(`[${row.name}] DONE in ${Date.now() - start}ms`);
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${row.name}] FAILED: ${msg}`);
      fail += 1;
    } finally {
      if (password) password.fill(0);
    }
  }

  await pool.end();
  console.log(`\nrollout summary: ok=${ok} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
