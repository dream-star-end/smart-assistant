/**
 * nodeBootstrap — admin 添加虚机后平台自动 bootstrap 的完整流程。
 *
 * 阶段(status 机:bootstrapping → ready / broken):
 *   0. preflight:能 SSH + sudo/root + distro 能装 docker
 *   1. install_docker:apt/yum 装 docker-ce + chrony
 *   2. install_bridge:创建 docker bridge `openclaude-br0`,CIDR 由调用方指定
 *   3. deploy_node_agent:上传 Go 二进制 + config yaml + psk
 *   4. deploy_tls:
 *        - 远端 openssl 生成 keypair → CSR(key 不下来,只留本地 /etc/openclaude/)
 *        - master 签 CSR → cert
 *        - 上传 cert + CA cert
 *   5. apply_firewall:**原子 swap** — iptables-save > old;写 new 规则;
 *        `systemd-run --on-active=60 --unit=ocfw-rollback iptables-restore < old`
 *        先挂回滚 watchdog,再 apply new,最后再 cancel 回滚(apply 成功后)
 *   6. start_service:systemctl daemon-reload + enable + restart(不能用 --now,
 *        re-add 场景下 service 已 active,--now 是 no-op,新 cert/yml 不 reload)
 *   7. verify:mTLS /health + /bootstrap/verify
 *
 * 失败处理:
 *   - 任何阶段失败 → markBootstrapResult(status='broken', err=<stage>:<err>)
 *   - firewall rollback 靠 systemd timer 兜底(60s 内没 cancel 自动回滚)
 *   - 中途失败不清理已装 docker / 不删 cert(半托管状态,人工或 retry 处理)
 *
 * 幂等:流程支持重复调用(failure retry);已有步骤用 idempotent shell(mkdir -p,
 * if-not-exists,docker network create 前 inspect 等)。
 */

import { randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";

import { rootLogger } from "../logging/logger.js";
import * as queries from "./queries.js";
import * as ca from "./certAuthority.js";
import { decryptSshPassword, decryptAgentPsk } from "./crypto.js";
import type { ComputeHostRow, BootstrapStep, BootstrapResult } from "./types.js";
import {
  sshRun,
  sshUpload,
  sshDownload,
  shEscape,
  type SshTarget,
} from "./sshExec.js";

const log = rootLogger.child({ subsys: "node-bootstrap" });

// ─── 常量 ────────────────────────────────────────────────────────────

/** node-agent 二进制部署路径。 */
const REMOTE_BIN_PATH = "/usr/local/bin/node-agent";
/** 配置目录。 */
const REMOTE_CFG_DIR = "/etc/openclaude";

/** 本地 node-agent 二进制(build 产物)。bootstrap 前 caller 确保存在。 */
const LOCAL_BIN_PATH =
  process.env.OPENCLAUDE_NODE_AGENT_BIN ??
  "/opt/openclaude/openclaude-v3/packages/commercial/node-agent/node-agent";

/** bootstrap 总超时。 */
const BOOTSTRAP_TOTAL_MS = 15 * 60_000;

/**
 * 远端 node-agent 回连 master baselineServer 用的 base URL(HTTPS,含端口)。
 * 空 → baseline 同步禁用(自 host 或纯开发场景)。
 * 实际部署时由运维把 master 的 18792 经 Caddy 反代到此 URL。
 */
const MASTER_BASELINE_BASE_URL = process.env.OPENCLAUDE_MASTER_BASELINE_BASE_URL ?? "";

/** node-agent 本地 baseline 落盘位置(跟 baseline.go BaselineDir 对齐)。 */
const REMOTE_BASELINE_VERSION_FILE = "/var/lib/openclaude/baseline/.version";

/** baseline_first_pull 等 .version 落地的超时。 */
const BASELINE_PULL_DEADLINE_MS = 2 * 60_000;

export interface BootstrapParams {
  hostId: string;
  /** 本 host 分配的 bridge 子网,如 "172.30.1.0/24"。由 nodeScheduler 前置分配。 */
  bridgeCIDR: string;
  /** node-agent 监听端口(compute_hosts.agent_port)。 */
  agentPort: number;
}

// ─── 主流程 ────────────────────────────────────────────────────────

export async function bootstrapHost(params: BootstrapParams): Promise<BootstrapResult> {
  const startedAt = Date.now();
  let currentStep: BootstrapStep = "ssh_connect";

  const row = await queries.getHostById(params.hostId);
  if (!row) {
    return { kind: "fail", step: "ssh_connect", message: `host ${params.hostId} not found` };
  }
  if (row.name === "self") {
    return { kind: "fail", step: "ssh_connect", message: "cannot SSH-bootstrap self host" };
  }

  let password: Buffer;
  try {
    password = decryptSshPassword(row.id, row.ssh_password_nonce, row.ssh_password_ct);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { kind: "fail", step: "ssh_connect", message: `decrypt ssh creds: ${err}` };
  }
  let psk: Buffer;
  try {
    psk = decryptAgentPsk(row.id, row.agent_psk_nonce, row.agent_psk_ct);
  } catch (e) {
    password.fill(0);
    const err = e instanceof Error ? e.message : String(e);
    return { kind: "fail", step: "ssh_connect", message: `decrypt psk: ${err}` };
  }

  const target: SshTarget = {
    host: row.host,
    port: row.ssh_port,
    username: row.ssh_user,
    password,
    knownHostsContent: null, // bootstrap 首次 accept-new;再次 bootstrap 会走下面的 TOFU compare
  };
  // 如果 DB 里已经有 ssh_fingerprint,就构建 knownHostsContent 走 strict;
  // 否则 accept-new 并在成功后回填
  if (row.ssh_fingerprint) {
    // known_hosts line 格式是 "host pubkey"。我们存的 fingerprint 是 sha256;
    // 重新 keyscan 比较更稳;这里为简化先留 accept-new 模式,后续 0031 再严格化
    // 注意:首次 bootstrap 失败后 DB 里有指纹也必须允许修复,所以暂留 accept-new
    target.knownHostsContent = null;
  }

  const totalDeadline = startedAt + BOOTSTRAP_TOTAL_MS;
  let fingerprint = "";
  let certNotAfter: Date = new Date();

  const step = async (name: BootstrapStep, fn: () => Promise<void>): Promise<void> => {
    currentStep = name;
    if (Date.now() > totalDeadline) {
      throw new Error("bootstrap total timeout exceeded");
    }
    log.info("bootstrap step start", { step: name, host: params.hostId });
    await fn();
    log.info("bootstrap step ok", { step: name, host: params.hostId });
  };

  try {
    await step("ssh_connect", () => preflight(target)); // 连 + precheck 合并到 ssh_connect
    await step("os_precheck", async () => {
      // 抓 host key 回填
      try {
        const ks = await sshRun(
          target,
          `ssh-keyscan -p ${target.port} -T 5 127.0.0.1 2>/dev/null | head -20 || true`,
        );
        const key = (ks.stdout || "").trim();
        if (key) {
          await queries.updateSshFingerprint(params.hostId, key.slice(0, 2048));
        }
      } catch {
        /* non-fatal */
      }
    });
    await step("install_packages", () => installDocker(target));
    await step("docker_network", () => installBridge(target, params.bridgeCIDR));
    await step("data_dir", () => ensureDataDir(target));
    await step("deliver_binary", () =>
      deployNodeAgent(target, row, psk, params.bridgeCIDR, params.agentPort),
    );
    await step("deliver_psk", async () => {
      // psk 已在 deliver_binary 里写;此 step 作为独立记录点保留。
    });
    await step("local_keygen", () => generateRemoteKey(target));
    // sign_cert:download CSR → master sign → upload cert/ca
    await step("sign_cert", async () => {
      const res = await deployTls(target, params.hostId);
      fingerprint = res.fingerprintSha256;
      certNotAfter = res.notAfter;
    });
    await step("firewall_apply", () =>
      applyFirewall(target, params.bridgeCIDR, params.agentPort),
    );
    await step("systemd_start", () => startService(target));
    await step("agent_verify", () => verifyNodeAgent(params.hostId));
    await step("baseline_first_pull", () => pullBaselineOnce(params.hostId));
    await step("image_pull", async () => {
      /* M1 镜像 pull 放到 nodeScheduler 第一次 run 时懒执行,本阶段 no-op */
    });
    await step("final_verify", async () => {
      // 再拉一次 health 确认状态稳定
      await verifyNodeAgent(params.hostId);
    });

    await queries.markBootstrapResult(params.hostId, true, null);
    return { kind: "ok", fingerprint, certNotAfter, psk: true };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error("bootstrap failed", { hostId: params.hostId, step: currentStep, err });
    await queries.markBootstrapResult(params.hostId, false, `${currentStep}: ${err}`);
    return { kind: "fail", step: currentStep, message: err };
  } finally {
    password.fill(0);
    psk.fill(0);
  }
}

// ─── 各阶段 ────────────────────────────────────────────────────────

async function preflight(target: SshTarget): Promise<void> {
  const { stdout } = await sshRun(
    target,
    `
set -e
if [ "$(id -u)" != "0" ]; then
  echo "MUST_RUN_AS_ROOT" >&2
  exit 1
fi
uname -s
. /etc/os-release
echo "DISTRO=$ID"
echo "DISTRO_VER=$VERSION_ID"
`,
  );
  if (!stdout.includes("DISTRO=ubuntu") && !stdout.includes("DISTRO=debian")) {
    throw new Error(`unsupported distro: ${stdout.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

async function installDocker(target: SshTarget): Promise<void> {
  await sshRun(
    target,
    `
set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -yq
  apt-get install -yq docker.io chrony curl ca-certificates iptables-persistent openssl
else
  # 仅保证依赖
  apt-get install -yq chrony iptables-persistent openssl >/dev/null 2>&1 || true
fi
systemctl enable --now docker
systemctl enable --now chrony || systemctl enable --now chronyd || true
`,
    4 * 60_000,
  );
}

async function installBridge(target: SshTarget, cidr: string): Promise<void> {
  // 校验 cidr 字符安全(避免 shell 注入)
  if (!/^[0-9./]+$/.test(cidr)) {
    throw new Error(`invalid bridge cidr: ${cidr}`);
  }
  await sshRun(
    target,
    `
set -e
if ! docker network inspect openclaude-br0 >/dev/null 2>&1; then
  docker network create --driver bridge \\
    --subnet=${cidr} \\
    --opt com.docker.network.bridge.name=openclaude-br0 \\
    --opt com.docker.network.bridge.enable_ip_masquerade=true \\
    openclaude-br0
fi
ip link show openclaude-br0 >/dev/null
`,
    60_000,
  );
}

async function deployNodeAgent(
  target: SshTarget,
  row: ComputeHostRow,
  psk: Buffer,
  cidr: string,
  agentPort: number,
): Promise<void> {
  // 上传二进制
  const bin = await import("node:fs/promises").then((m) => m.readFile(LOCAL_BIN_PATH));
  await sshUpload(target, REMOTE_BIN_PATH, bin, 0o755, 180_000);

  // bridge gateway IP = cidr 第一个 IP + 1 → 简单算法:前缀 + ".1"
  // cidr 形如 172.30.1.0/24 → gw = 172.30.1.1
  const gw = computeGatewayIp(cidr);

  // 写 config yaml
  const cfgYaml = [
    `host_uuid: ${row.id}`,
    `bind: "0.0.0.0:${agentPort}"`,
    `psk_path: "${REMOTE_CFG_DIR}/node-agent.psk"`,
    `tls_key: "${REMOTE_CFG_DIR}/node-agent.key"`,
    `tls_cert: "${REMOTE_CFG_DIR}/node-agent.crt"`,
    `ca_cert: "${REMOTE_CFG_DIR}/ca.crt"`,
    `docker_bridge: "openclaude-br0"`,
    `bridge_cidr: "${cidr}"`,
    `proxy_bind: "${gw}:3128"`,
    `master_hosts: []`, // 由调用方后续更新或者 admin UI 填写
    `egress_allow_hosts: []`,
    `docker_bin: "docker"`,
    `master_baseline_base_url: "${MASTER_BASELINE_BASE_URL.replace(/"/g, "")}"`,
    "",
  ].join("\n");
  await sshUpload(target, `${REMOTE_CFG_DIR}/node-agent.yml`, cfgYaml, 0o644);

  // psk —— 以 hex 文本落盘,保证 Bearer header 是合法 ASCII(否则 Node.js undici 拒收)
  await sshUpload(
    target,
    `${REMOTE_CFG_DIR}/node-agent.psk`,
    Buffer.from(psk.toString("hex"), "utf8"),
    0o600,
  );

  // 写 systemd unit
  const unit = `[Unit]
Description=OpenClaude node-agent (v3 compute pool worker)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=${REMOTE_BIN_PATH} --config ${REMOTE_CFG_DIR}/node-agent.yml
Restart=always
RestartSec=5
StartLimitInterval=60
StartLimitBurst=5
# 权限:需要 root(docker socket + iptables)
User=root
Group=root
# 日志走 journald
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
  await sshUpload(
    target,
    "/etc/systemd/system/openclaude-node-agent.service",
    unit,
    0o644,
  );
  await sshRun(target, "systemctl daemon-reload", 10_000);
}

async function generateRemoteKey(target: SshTarget): Promise<void> {
  const keyPath = `${REMOTE_CFG_DIR}/node-agent.key`;
  const csrPath = `${REMOTE_CFG_DIR}/node-agent.csr`;
  // 只生成 key。CSR 在 deployTls 阶段生成并下载
  void csrPath;
  await sshRun(
    target,
    `
set -e
mkdir -p ${REMOTE_CFG_DIR}
umask 077
if [ ! -f ${keyPath} ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out ${keyPath}
  chmod 0600 ${keyPath}
fi
`,
    30_000,
  );
}

interface DeployTlsResult {
  fingerprintSha256: string;
  notAfter: Date;
}

async function deployTls(target: SshTarget, hostId: string): Promise<DeployTlsResult> {
  const csrPath = `${REMOTE_CFG_DIR}/node-agent.csr`;
  const keyPath = `${REMOTE_CFG_DIR}/node-agent.key`;
  // 1. 远端生成 CSR(key 已由 generateRemoteKey 阶段写入)
  const subj = `/CN=node:${hostId}`;
  const sanExt = `subjectAltName=URI:spiffe://openclaude/host/${hostId}`;
  await sshRun(
    target,
    `
set -e
openssl req -new -key ${keyPath} -subj ${shEscape(subj)} \
  -addext ${shEscape(sanExt)} -outform PEM -out ${csrPath}
chmod 0600 ${csrPath}
`,
    60_000,
  );

  // 2. 下载 CSR
  const csrBuf = await sshDownload(target, csrPath, 16 * 1024, 30_000);
  const csrPem = csrBuf.toString("utf8");

  // 3. master 签 CSR(signHostLeafCsr 签名固定 90d;不可覆盖)
  const signed = await ca.signHostLeafCsr(hostId, csrPem);

  // 4. 上传 cert + CA 到远端
  await sshUpload(
    target,
    `${REMOTE_CFG_DIR}/node-agent.crt`,
    signed.certPem,
    0o644,
  );
  const caInfo = await ca.ensureCa();
  const caBuf = await fsPromises.readFile(caInfo.caCertPath);
  await sshUpload(target, `${REMOTE_CFG_DIR}/ca.crt`, caBuf, 0o644);

  // 5. 回写 DB 证书元信息
  await queries.updateCert({
    id: hostId,
    certPem: signed.certPem,
    fingerprintSha256: signed.fingerprintSha256,
    notBefore: signed.notBefore,
    notAfter: signed.notAfter,
  });
  return { fingerprintSha256: signed.fingerprintSha256, notAfter: signed.notAfter };
}

async function ensureDataDir(target: SshTarget): Promise<void> {
  await sshRun(
    target,
    `
set -e
mkdir -p /var/lib/openclaude/containers /var/lib/openclaude/skills /var/lib/openclaude/user-data
chmod 0750 /var/lib/openclaude /var/lib/openclaude/containers /var/lib/openclaude/skills /var/lib/openclaude/user-data
`,
    10_000,
  );
}

async function applyFirewall(
  target: SshTarget,
  cidr: string,
  agentPort: number,
): Promise<void> {
  if (!/^[0-9./]+$/.test(cidr)) {
    throw new Error("invalid cidr");
  }
  if (!Number.isInteger(agentPort) || agentPort < 1 || agentPort > 65535) {
    throw new Error("invalid agent port");
  }
  const rollbackUnit = `ocfw-rollback-${randomUUID().slice(0, 8)}`;
  // 流程:
  //   1. save old iptables → /tmp/oc-iptables.old
  //   2. systemd-run --unit=<rollbackUnit> --on-active=60 iptables-restore < /tmp/oc-iptables.old
  //      这挂了 60s 倒计时;apply 失败时 60s 后自动回滚
  //   3. apply new rules(INPUT :agent_port;FORWARD 本 bridge;DROP 其它)
  //   4. 验证 apply 成功(端口通 + docker 正常)→ systemctl stop <rollbackUnit>.timer
  //   5. persist to /etc/iptables/rules.v4
  await sshRun(
    target,
    `
set -e
mkdir -p /tmp/oc-fw
iptables-save > /tmp/oc-fw/old.rules
# 创建 rollback timer:60s 后自动恢复 old rules(防 apply 后脱网)
systemd-run --unit=${rollbackUnit} --on-active=60 --timer-property=AccuracySec=1s \
  /bin/sh -c "iptables-restore < /tmp/oc-fw/old.rules; systemctl stop ${rollbackUnit}.service 2>/dev/null || true"

# 应用新规则(只加必要条目,不清空 — 兼容 docker 自己的 FORWARD 链)
# INPUT: 仅放行 SSH(22)、node-agent(:agent_port)、docker 已有
iptables -C INPUT -p tcp --dport ${agentPort} -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -p tcp --dport ${agentPort} -j ACCEPT

# FORWARD bridge 本 cidr(ingress/egress)
iptables -C FORWARD -s ${cidr} -j ACCEPT 2>/dev/null \
  || iptables -I FORWARD -s ${cidr} -j ACCEPT
iptables -C FORWARD -d ${cidr} -j ACCEPT 2>/dev/null \
  || iptables -I FORWARD -d ${cidr} -j ACCEPT

# 持久化(不清 rollback timer,让 bootstrap 主流程在 verify 成功后再 cancel)
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4

# 记下 rollback unit 名字,让 startService 之后再 cancel
echo ${rollbackUnit} > /tmp/oc-fw/rollback_unit
`,
    60_000,
  );
}

async function startService(target: SshTarget): Promise<void> {
  await sshRun(
    target,
    `
set -e
# enable + restart(不用 --now):service 已 active 时 --now 是 no-op,
# 新推的 cert/yml/binary 不会被进程重新加载 → agent_verify 阶段
# fingerprint mismatch。restart 幂等,inactive=start,active=stop+start。
systemctl daemon-reload
systemctl enable openclaude-node-agent
systemctl restart openclaude-node-agent
# 等 3s 让 service 起来
sleep 3
systemctl is-active openclaude-node-agent

# apply_firewall 的 rollback timer cancel(service 起来意味着规则没脱网)
if [ -f /tmp/oc-fw/rollback_unit ]; then
  unit=$(cat /tmp/oc-fw/rollback_unit)
  systemctl stop "$unit.timer" 2>/dev/null || true
  systemctl stop "$unit.service" 2>/dev/null || true
  rm -f /tmp/oc-fw/rollback_unit
fi
`,
    30_000,
  );
}

/**
 * baseline_first_pull:bootstrap 成功把 node-agent 拉起来后,显式触发一次
 * baseline 同步,并轮询 .version 文件落地,确保后续 spawn 容器 bind mount
 * 到 /var/lib/openclaude/baseline/ 时内容已就绪。
 *
 * 如果 master_baseline_base_url 未配置(self host / 开发场景),节点会返
 * 503 BASELINE_DISABLED;此时视为功能关闭,直接 pass。
 */
async function pullBaselineOnce(hostId: string): Promise<void> {
  if (!MASTER_BASELINE_BASE_URL) {
    log.info("baseline_first_pull skipped — master url not configured", { hostId });
    return;
  }
  const { triggerBaselineRefresh, statFile, hostRowToTarget } = await import(
    "./nodeAgentClient.js"
  );
  const { AgentAppError: AppErr } = await import("./nodeAgentClient.js");
  const row = await queries.getHostById(hostId);
  if (!row) throw new Error("host row vanished");
  const t = hostRowToTarget(row);
  try {
    try {
      await triggerBaselineRefresh(t);
    } catch (e) {
      // 节点禁用 baseline → 跳过(不挂 bootstrap)
      if (e instanceof AppErr && e.agentErrCode === "BASELINE_DISABLED") {
        log.info("baseline disabled on node, skipping", { hostId });
        return;
      }
      throw e;
    }
    // 轮询 .version 落地
    const deadline = Date.now() + BASELINE_PULL_DEADLINE_MS;
    let lastErr = "not yet present";
    while (Date.now() < deadline) {
      try {
        const stat = await statFile(t, REMOTE_BASELINE_VERSION_FILE);
        if (stat.exists) return;
        lastErr = "exists=false";
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`baseline .version not present after pull: ${lastErr}`);
  } finally {
    if (t.psk) t.psk.fill(0);
  }
}

async function verifyNodeAgent(hostId: string): Promise<void> {
  // 等 node-agent 起来再做 mTLS /health。循环 30s。
  const deadline = Date.now() + 30_000;
  const { healthCheck, hostRowToTarget } = await import("./nodeAgentClient.js");
  let lastErr = "not yet connected";
  while (Date.now() < deadline) {
    const row = await queries.getHostById(hostId);
    if (!row) throw new Error("host row vanished");
    const t = hostRowToTarget(row);
    try {
      const res = await healthCheck(t);
      if (res.ok) {
        if (t.psk) t.psk.fill(0);
        return;
      }
      lastErr = `health returned ok=false`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    } finally {
      if (t.psk) t.psk.fill(0);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`verify timeout: ${lastErr}`);
}

// ─── utils ────────────────────────────────────────────────────────

/** 172.30.1.0/24 → 172.30.1.1 */
function computeGatewayIp(cidr: string): string {
  const base = cidr.split("/")[0];
  if (!base) throw new Error(`invalid cidr: ${cidr}`);
  const parts = base.split(".");
  if (parts.length !== 4) throw new Error(`invalid cidr: ${cidr}`);
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

// re-export for test
export { computeGatewayIp };
