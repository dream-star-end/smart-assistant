import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPerContainerAuthJson } from "../codex-auth/codexAuthFile.js";

/**
 * Tests for `buildPerContainerAuthJson` — the per-container auth.json
 * schema used by v3supervisor's sticky-bound mount path. The schema is
 * load-bearing for codex 0.125's strict `AuthDotJson` deserialize:
 *
 *  - `auth_mode` must be `"chatgptAuthTokens"` (external-host-app token mode)
 *  - `tokens.id_token` must be JWT-shaped (`parse_chatgpt_jwt_claims` /
 *    `decode_jwt_payload` requires 3 non-empty dot-separated parts)
 *  - `tokens.refresh_token` must be present (no `#[serde(default)]`); we
 *    write `""` because the host-side G2 actor is the only refresher
 *  - `tokens.account_id` extracted from access_token JWT (or `""` on
 *    malformed input — file is still structurally complete)
 *
 * Run: `pnpm --filter @oc/commercial exec node --test packages/commercial/src/__tests__/codexAuthFile.test.ts`
 */

function fakeAccessToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

const tokenForAccount = (aid: string) =>
  fakeAccessToken({ "https://api.openai.com/auth": { chatgpt_account_id: aid } });

describe("buildPerContainerAuthJson — codex 0.125 external-token schema", () => {
  const accessToken = tokenForAccount("acct-123");
  const lastRefreshIso = "2026-05-01T12:00:00Z";

  it("auth_mode === 'chatgptAuthTokens' (codex external-host-app token mode)", () => {
    const content = buildPerContainerAuthJson({ accessToken, lastRefreshIso });
    const parsed = JSON.parse(content);
    assert.equal(parsed.auth_mode, "chatgptAuthTokens");
  });

  it("tokens.id_token === access_token (JWT-shaped, satisfies decode_jwt_payload)", () => {
    const content = buildPerContainerAuthJson({ accessToken, lastRefreshIso });
    const parsed = JSON.parse(content);
    assert.equal(parsed.tokens.id_token, accessToken);
    const parts = String(parsed.tokens.id_token).split(".");
    assert.equal(parts.length, 3);
    for (const p of parts) assert.notEqual(p, "");
  });

  it("tokens.access_token is the input access_token verbatim", () => {
    const content = buildPerContainerAuthJson({ accessToken, lastRefreshIso });
    const parsed = JSON.parse(content);
    assert.equal(parsed.tokens.access_token, accessToken);
  });

  it("tokens.refresh_token is present as empty string (required field, no real refresh writer)", () => {
    const content = buildPerContainerAuthJson({ accessToken, lastRefreshIso });
    const parsed = JSON.parse(content);
    assert.equal("refresh_token" in parsed.tokens, true);
    assert.equal(parsed.tokens.refresh_token, "");
  });

  it("tokens.account_id is extracted from access_token JWT", () => {
    const content = buildPerContainerAuthJson({ accessToken, lastRefreshIso });
    const parsed = JSON.parse(content);
    assert.equal(parsed.tokens.account_id, "acct-123");
  });

  it("OPENAI_API_KEY === null and last_refresh round-trips", () => {
    const content = buildPerContainerAuthJson({ accessToken, lastRefreshIso });
    const parsed = JSON.parse(content);
    assert.equal(parsed.OPENAI_API_KEY, null);
    assert.equal(parsed.last_refresh, lastRefreshIso);
  });

  it("malformed JWT: account_id='' but file is still structurally complete", () => {
    const content = buildPerContainerAuthJson({
      accessToken: "not-a-jwt",
      lastRefreshIso,
    });
    const parsed = JSON.parse(content);
    assert.equal(parsed.auth_mode, "chatgptAuthTokens");
    assert.equal(parsed.tokens.access_token, "not-a-jwt");
    assert.equal(parsed.tokens.id_token, "not-a-jwt");
    assert.equal(parsed.tokens.refresh_token, "");
    assert.equal(parsed.tokens.account_id, "");
  });
});
