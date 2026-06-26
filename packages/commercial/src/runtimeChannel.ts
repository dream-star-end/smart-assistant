// runtimeChannel.ts —— "本 commercial 实例属于哪个 runtime channel" 的单一权威。
//
// v3(现网,默认)与 v5(Aurora 灰度,同机第二实例)共享 openclaude_commercial 库。
// agent_containers / 容器物理标识(label/name/volume/network)必须按 runtime_channel
// 行级隔离,否则两实例会复用/误清理彼此的容器(Codex 审 P0/P1 确认)。
//
// 取值来源:env OC_RUNTIME_CHANNEL(systemd EnvironmentFile 注入)。未设 → "v3"
// (现网零行为变化)。函数形态(非 const)便于测试在 import 后改 env。

/** 合法 runtime channel 取值(单一权威枚举)。 */
export type RuntimeChannel = "v3" | "v5";

export function getRuntimeChannel(): RuntimeChannel {
  const raw = process.env.OC_RUNTIME_CHANNEL?.trim() || "v3";
  // fail-closed:只允许 v3|v5。任意其它值(误配 "V5"/"v5 "/typo)会污染容器名/卷名/DB 过滤,
  // 宁可拒服务也不静默走错隔离(Codex 审 P1a 要求)。env 启动期固定,异常会立即暴露。
  if (raw !== "v3" && raw !== "v5") {
    throw new Error(
      `[runtimeChannel] 非法 OC_RUNTIME_CHANNEL='${raw}'(只允许 'v3' 或 'v5')`,
    );
  }
  return raw;
}

/** 是否 v5 灰度实例。 */
export function isV5Channel(): boolean {
  return getRuntimeChannel() === "v5";
}
