/**
 * Extract `chatgpt_account_id` from a ChatGPT-issued JWT access_token.
 *
 * The token's payload (second JWT segment) carries an
 * `https://api.openai.com/auth.chatgpt_account_id` claim. Returns `null`
 * on any parse failure — callers should still write the file with an
 * empty account_id since `auth_mode: chatgpt` + valid access_token is the
 * load-bearing part for codex CLI.
 *
 * Mirrors the same-named function in
 * `packages/gateway/src/codexAuthSync.ts:extractChatGptAccountId` — kept
 * in sync. Both files are intentionally independent (commercial doesn't
 * depend on gateway package).
 */
export function extractChatGptAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;
    const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const authClaim = payload["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const aid = authClaim?.chatgpt_account_id;
    return typeof aid === "string" && aid.length > 0 ? aid : null;
  } catch {
    return null;
  }
}
