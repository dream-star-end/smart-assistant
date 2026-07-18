// containerNet.ts —— "平台容器网段判定" 的单一权威(channel-aware)。
//
// v3 容器落 openclaude-v3-net(172.30.0.0/16),v5 容器落 openclaude-v5-net
// (172.31.0.0/16),物理隔离(P1d)。任何"这个 IP 是不是本 channel 的容器"的
// 判断(SSRF 白名单 / bound_ip 校验 / file·api proxy 边界)都必须经由这里 ——
// 2026-07-18 durable-turn 批的 nodeHttpContainerTransport 白名单硬编码了 v3 段
// 172.30/16,v5 下 master→容器 dispatch 求证 100% 被自己拦死(§2.4 收敛链上线
// 即瘫),就是网段判定各持一份私有副本漂移出来的事故。禁止再复制这段逻辑。

import { isIPv4 } from "node:net";

import { getRuntimeChannel } from "./runtimeChannel.js";

/** 本 channel 容器网段的第二段八位组:v5 → 31(172.31/16),v3 → 30(172.30/16)。 */
export function containerSubnetSecondOctetForChannel(): number {
  return getRuntimeChannel() === "v5" ? 31 : 30;
}

/** 本 channel 容器网段前缀(如 "172.31")。v3supervisor 的容器 IP 计算用它拼接。 */
export function containerSubnetPrefixForChannel(): string {
  return `172.${containerSubnetSecondOctetForChannel()}`;
}

/**
 * ip 是否落在**本 channel** 的平台容器网段内(严格 IPv4,不做 DNS resolve)。
 *
 * 这是 master→容器方向所有内部调用(dispatch 求证 / file proxy / api proxy)的
 * SSRF 边界:只允许打本 channel 的 docker bridge 段,host 配置漂移时宁可拒发。
 */
export function isPlatformContainerIp(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const p = ip.split(".").map(Number);
  return p[0] === 172 && p[1] === containerSubnetSecondOctetForChannel();
}
