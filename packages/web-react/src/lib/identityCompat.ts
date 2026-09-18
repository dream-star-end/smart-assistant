import { parseIdentityCompatProjection, type IdentityCompatProjection } from "@openclaude/protocol";
import { bearerHeaders, callWithRefresh, jsonOrThrow } from "./api";
import type { AuthSession } from "./types";

export interface PersonaDocument { text: string; path: string }

/**
 * 当前登录身份的 user id(CFG-19):`parseIdentityCompatProjection(value, expectedUserId)` 的契约要求
 * expectedUserId 是**已认证身份**,不能拿投影自己的 userId 回填(那样 userId 校验恒真)。
 * 商业版 access token 是 JWT,`sub` 即 BIGINT user id 的字符串;这里只解码不验签 —— 验签是服务端的事,
 * 这个值只用来比对投影归属。不是 JWT(个人版裸 accessToken)→ undefined。
 */
export function authenticatedUserIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
    return typeof payload.sub === "string" && /^[1-9][0-9]*$/.test(payload.sub) ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/** This is an authenticated management projection, never a client-side slug inference. */
export const identityCompatApi = {
  async getProjection(auth: AuthSession, expectedUserId?: string): Promise<IdentityCompatProjection | null> {
    const result = await jsonOrThrow<{ identityCompat?: IdentityCompatProjection }>(
      callWithRefresh(auth, (token) => fetch("/api/agents", { credentials: "include", headers: bearerHeaders(token) })),
    );
    if (result.identityCompat === undefined) return null; // Older server / no registration UI.
    // 能从已认证 JWT 拿到 sub 就按它比对(商业版容器用户,投影只在这条路径上存在);
    // 拿不到(个人版裸 accessToken / 测试桩)时退回投影自带 userId —— 此时服务端
    // (identityCompatRuntime.fetchIdentityCompatProjection)已用容器 OC_USER_ID 校过归属,
    // 客户端这一层只剩形状检查,不再假装做了二次身份比对。
    const userId =
      expectedUserId ?? authenticatedUserIdFromToken(auth.snapshot().token) ?? result.identityCompat?.userId;
    return parseIdentityCompatProjection(result.identityCompat, userId);
  },
  async getPersona(auth: AuthSession, agentId: string): Promise<PersonaDocument> {
    const doc = await jsonOrThrow<PersonaDocument>(callWithRefresh(auth, (token) =>
      fetch(`/api/agents/${encodeURIComponent(agentId)}/persona`, { credentials: "include", headers: bearerHeaders(token) }),
    ));
    if (typeof doc.text !== "string" || typeof doc.path !== "string") throw new Error("invalid persona document");
    return doc;
  },
  async savePersona(auth: AuthSession, agentId: string, text: string): Promise<void> {
    const result = await jsonOrThrow<{ ok: boolean }>(callWithRefresh(auth, (token) =>
      fetch(`/api/agents/${encodeURIComponent(agentId)}/persona`, {
        method: "PUT", credentials: "include", headers: bearerHeaders(token, true), body: JSON.stringify({ text }),
      }),
    ));
    if (result.ok !== true) throw new Error("persona save not acknowledged");
  },
};
