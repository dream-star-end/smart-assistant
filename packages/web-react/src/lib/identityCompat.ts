import { parseIdentityCompatProjection, type IdentityCompatProjection } from "@openclaude/protocol";
import { bearerHeaders, callWithRefresh, jsonOrThrow } from "./api";
import type { AuthSession } from "./types";

export interface PersonaDocument { text: string; path: string }

/** This is an authenticated management projection, never a client-side slug inference. */
export const identityCompatApi = {
  async getProjection(auth: AuthSession): Promise<IdentityCompatProjection | null> {
    const result = await jsonOrThrow<{ identityCompat?: IdentityCompatProjection }>(
      callWithRefresh(auth, (token) => fetch("/api/agents", { credentials: "include", headers: bearerHeaders(token) })),
    );
    if (result.identityCompat === undefined) return null; // Older server / no registration UI.
    return parseIdentityCompatProjection(result.identityCompat, result.identityCompat?.userId);
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
