/**
 * D.1c 反代:为不同网络位置的 worker host 选择回连 master 的 mTLS URL。
 *
 * 背景:GCE / AWS / Azure 等云不允许同 VPC 实例通过外网 IP 互通(intra-VPC routing
 * 把外网 IP 拐回内部 NIC 但 firewall 不放行)。同 VPC 的 worker 必须用 master 的
 * 内网 IP 才能 connect 到 :18443。VPC 外的 worker(IDC / 跨 region)走外网 IP。
 *
 * 判断依据:`compute_hosts.host` 字段 —— master ssh 进 host 用的 IP。
 * 若该 IP 是 RFC1918 私网或 loopback,认为该 host 与 master 同 VPC,用 internalUrl;
 * 否则用 defaultUrl。
 *
 * 调用方传入 default/internal 两个 URL(纯函数化,方便单测,不依赖 process.env)。
 */

/**
 * RFC1918 私网段 + loopback。仅 IPv4(compute_hosts.host 当前都是 v4)。
 * 非法 IP / IPv6 / 主机名 → false(走默认 URL)。
 */
export function isPrivateIp(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 loopback
  return false;
}

/**
 * 选择 master mTLS URL。
 * - internalUrl 已设 + targetHost 是私网 IP → 返回 internalUrl
 * - 否则 → 返回 defaultUrl(向后兼容,不设 internalUrl 时所有 host 走同一 URL)
 */
export function chooseMasterMtlsUrl(opts: {
  targetHost: string;
  defaultUrl: string;
  internalUrl: string;
}): string {
  if (opts.internalUrl && isPrivateIp(opts.targetHost)) {
    return opts.internalUrl;
  }
  return opts.defaultUrl;
}
