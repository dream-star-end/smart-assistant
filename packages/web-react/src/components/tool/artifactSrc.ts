import { asStr } from "./format";

/** 产物 src 安全白名单:只允许**容器绝对路径**(/… 非 //,useSignedSrc 会签名)或 **http(s)**。
 *  拒绝 javascript:/data:/blob:/协议相对/相对路径 —— 防工具输出里的恶意串拼成可点 href(XSS)。
 *  OCV5-310:从 researchCards 下沉到这里,让过程披露等首屏模块不必静态拖入整套研究卡。 */
export function safeArtifactSrc(s: unknown): string | null {
  const v = asStr(s).trim();
  if (!v) return null;
  // 内联 http(s) 判定:不用 isSafeHttpUrl 类型守卫,避免它把 string 在 else 分支窄成 never。
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  return null;
}
