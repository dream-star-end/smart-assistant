/**
 * v3 file proxy — HOST 侧 bridge secret 加载器。
 *
 * **作用**:HOST commercial 层给每个容器算一把 per-container nonce:
 *
 *   OC_BRIDGE_NONCE = HMAC_SHA256(rootSecret, containerId)
 *
 * 由 supervisor 在容器启动时作为 env 注入容器内部 gateway,容器处理 /api/file /
 * /api/media/* 请求前,拿 HTTP 请求头 `X-OpenClaude-Bridge-Nonce` 与 env 里的
 * OC_BRIDGE_NONCE 做 timingSafeEqual;HOST 侧 containerFileProxy 在转发前用同一
 * rootSecret 重新计算并写入请求头。容器端不持有 rootSecret,只持有自己那一份 nonce。
 *
 * **为什么要持久化**:若每次 HOST 重启都随机生成新 secret,容器 env 里 nonce 还是
 * 旧值 → /healthz 仍广播 `file-proxy-v1`,但真实 bypass 会 401,得等 supervisor 下次
 * force-recreate 容器才能恢复,窗口不可预测。落盘持久化后 HOST 重启 idempotent。
 *
 * **为什么不做 r6 那套 lstat/owner/EXCL/mode 复杂校验**:`/var/lib/openclaude` 在
 * HOST 本机,systemd `StateDirectory=openclaude` 默认创建为 root:root 0700。在它
 * 里面放一个 0600 文件的假想威胁 = 本机 root 已被攻破,此时 HMAC key 本就保不住。
 * 过度防护只会增加 bootstrap 失败路径。
 *
 * **部署前提**(见 v3-file-return-spec-mvp.md §5):
 *   - systemd unit 必须含 `StateDirectory=openclaude`
 *   - 首次挂载后 `/var/lib/openclaude` 已是 root:root 0700
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_BRIDGE_SECRET_PATH = "/var/lib/openclaude/.v3-bridge-secret";

/**
 * Codex R1/R2 SHOULD-4:启动时 self-check `/var/lib/openclaude` 的 owner/mode/symlink。
 *
 * systemd StateDirectory 生效时一定是 root:root 0700 实目录。
 * - symlink / not-directory:**throw**(fail-closed)—— attacker 用 symlink 把 secret
 *   引流到 world-writable / 别的用户目录是明确攻击面,不能只 log 继续。
 * - mode ≠ 0o700 或 owner ≠ root:**log 警告继续** —— 降级环境手工 mkdir 常见,
 *   运维看 journalctl 自行调整,不值得拖垮整个 HOST 启动。
 */
function checkDirIntegrity(dir: string, log: (msg: string) => void): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    // Mostly ENOENT — 目录还没建,下面 mkdir 会兜底。
    log(`bridge_secret_dir_stat_failed path=${dir} err=${(e as Error)?.message ?? String(e)}`);
    return;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`bridge secret dir is a symlink (refusing): ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`bridge secret dir is not a directory (refusing): ${dir}`);
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    log(`bridge_secret_dir_mode_unexpected path=${dir} mode=0o${mode.toString(8)} expected=0o700`);
  }
  if (st.uid !== 0) {
    log(`bridge_secret_dir_owner_unexpected path=${dir} uid=${st.uid} expected=0`);
  }
}

/**
 * 加载 or 初始化 bridge secret(32 byte hex)。
 *
 * - 已存在且内容为合法 64 位小写 hex → 原样返回
 * - 不存在 / 损坏 → 生成新 secret,0o600 写入;同步 chmod 防 umask 干扰
 *
 * 测试可传 `path` 覆盖目标文件位置,避免污染 /var/lib/openclaude。
 */
export function loadOrCreateBridgeSecret(
  path: string = DEFAULT_BRIDGE_SECRET_PATH,
  log: (msg: string) => void = (m) => console.warn(m),
): string {
  const dir = dirname(path);
  checkDirIntegrity(dir, log);
  if (existsSync(path)) {
    const s = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
    // 文件存在但内容被篡改 / 残缺 → 下方重新生成覆写
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = randomBytes(32).toString("hex");
  writeFileSync(path, `${s}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return s;
}
