import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_PROMPT_PRIVACY_SUPPORT, type PromptPrivacySupport } from "@openclaude/protocol";
import { ensureFreeSubscription } from "../../billing/subscription.js";
import { query } from "../../db/queries.js";
import { appendSetCookie } from "../cookies.js";
import { HttpError, readJsonBody, sendJson } from "../util.js";
import {
  resolveLaneAndApply,
  type AuthenticatedHttpUser,
  type CommercialHttpDeps,
} from "./shared.js";

type MeRow = {
  id: string;
  email: string;
  email_verified: boolean;
  role: "user" | "admin";
  display_name: string | null;
  avatar_url: string | null;
  wallet_credits: string;
  period_credits: string;
  total_credits: string;
  has_sub: boolean;
  status: string;
  created_at: Date;
  on_v5: boolean;
  org_id: string | null;
  org_name: string | null;
  org_role: "owner" | "admin" | "member" | null;
  org_status: string | null;
  org_billing_enabled: boolean | null;
  org_billing_delegate: boolean | null;
};

async function fetchMeRow(userId: string): Promise<MeRow> {
  const r = await query<MeRow>(
    `SELECT u.id::text AS id, u.email, u.email_verified, u.role, u.display_name, u.avatar_url,
            u.credits::text AS wallet_credits,
            COALESCE(CASE WHEN us.status = 'active' AND us.period_end > NOW() THEN us.period_credits ELSE 0 END, 0)::text AS period_credits,
            (u.credits + COALESCE(CASE WHEN us.status = 'active' AND us.period_end > NOW() THEN us.period_credits ELSE 0 END, 0))::text AS total_credits,
            (us.id IS NOT NULL) AS has_sub, u.status, u.created_at, (u.v5_migrated_at IS NOT NULL) AS on_v5,
            o.id::text AS org_id, o.name AS org_name, om.org_role,
            o.status AS org_status, om.billing_enabled AS org_billing_enabled, om.billing_delegate AS org_billing_delegate
       FROM users u
       LEFT JOIN user_subscriptions us ON us.user_id = u.id
       LEFT JOIN org_memberships om ON om.user_id = u.id AND om.status = 'active'
       LEFT JOIN orgs o ON o.id = om.org_id
      WHERE u.id = $1`,
    [userId],
  );
  if (r.rows.length === 0 || r.rows[0].status !== "active") {
    throw new HttpError(401, "UNAUTHORIZED", "user is not active");
  }
  return r.rows[0];
}

export async function serveMe(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  user: AuthenticatedHttpUser,
): Promise<void> {
  let u = await fetchMeRow(user.id);
  if (!u.has_sub) {
    await ensureFreeSubscription(user.id);
    u = await fetchMeRow(user.id);
  }
  if (u.on_v5) {
    appendSetCookie(res, "oc_v5user=1; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax");
  } else {
    appendSetCookie(res, "oc_v5user=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
  }
  const lane = await resolveLaneAndApply(req, res, user.id, deps.refreshCookieSecure);
  sendJson(res, 200, {
    lane,
    user: {
      id: u.id,
      email: u.email,
      email_verified: u.email_verified,
      role: u.role,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      credits: u.total_credits,
      wallet_credits: u.wallet_credits,
      period_credits: u.period_credits,
      created_at: u.created_at instanceof Date ? u.created_at.toISOString() : u.created_at,
      org:
        u.org_id !== null
          ? {
              id: u.org_id,
              name: u.org_name,
              role: u.org_role,
              status: u.org_status,
              billing_enabled: u.org_billing_enabled,
              billing_delegate: u.org_role === "owner" ? true : u.org_billing_delegate,
            }
          : null,
    },
  });
}

function resolvePromptPrivacySafe(
  deps: CommercialHttpDeps,
  userId: string,
): Promise<PromptPrivacySupport> {
  return (
    deps.resolvePromptPrivacySupport?.(userId) ??
    Promise.resolve({ ...DEFAULT_PROMPT_PRIVACY_SUPPORT })
  ).catch(() => ({ ...DEFAULT_PROMPT_PRIVACY_SUPPORT }));
}

export async function serveGetMyPreferences(
  res: ServerResponse,
  deps: CommercialHttpDeps,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const [{ getPreferences }, { getAutoDreamFeature }, { inputPredictionFeatureView, intelligentUiFeatureView }] =
    await Promise.all([
      import("../../user/preferences.js"),
      import("../../user/autoDream.js"),
      import("../../intelligentUi/index.js"),
    ]);
  const snap = await getPreferences(user.id);
  const [autoDream, promptPrivacy] = await Promise.all([
    getAutoDreamFeature(
      user.id,
      snap.prefs.auto_dream_enabled === true,
      snap.prefs.auto_optimizer_enabled === true,
    ),
    resolvePromptPrivacySafe(deps, user.id),
  ]);
  sendJson(res, 200, {
    ...snap,
    features: {
      auto_dream: autoDream,
      intelligent_ui: intelligentUiFeatureView(snap.prefs),
      input_prediction: inputPredictionFeatureView(snap.prefs),
      prompt_privacy: promptPrivacy,
    },
  });
}

function mapPreferencesError(code: string, message: string): HttpError {
  if (code === "FORBIDDEN") return new HttpError(403, "AUTO_DREAM_MAX_REQUIRED", message);
  if (code === "UNAVAILABLE") return new HttpError(503, "AUTO_DREAM_UNAVAILABLE", message);
  if (code === "CONFLICT") return new HttpError(409, "PREFERENCES_CONFLICT", message);
  if (code === "VALIDATION") return new HttpError(400, "INVALID_PREFERENCES", message);
  return new HttpError(500, "PREFERENCES_INTERNAL", "preferences update failed");
}

export async function servePatchMyPreferences(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_BODY", "body must be a JSON object");
  }
  const rawBody = body as Record<string, unknown>;
  const profile = rawBody.system_assistant_profile;
  let cachedPromptPrivacy: PromptPrivacySupport | undefined;
  if (profile && typeof profile === "object" && (profile as { enabled?: unknown }).enabled === true) {
    cachedPromptPrivacy = await resolvePromptPrivacySafe(deps, user.id);
    if (cachedPromptPrivacy.state !== "ready") {
      throw new HttpError(
        409,
        "PRIVACY_RUNTIME_REQUIRED",
        "当前运行环境尚未支持此设置，请更新运行环境后再授权。",
      );
    }
  }
  const [
    { patchPreferences, PreferencesError, resolvePreferencesPatch },
    { getAutoDreamFeature, normalizeAutoDreamPreferencePatch },
    { inputPredictionFeatureView, intelligentUiFeatureView },
  ] = await Promise.all([
    import("../../user/preferences.js"),
    import("../../user/autoDream.js"),
    import("../../intelligentUi/index.js"),
  ]);
  try {
    let cachedAutoDream: Awaited<ReturnType<typeof getAutoDreamFeature>> | undefined;
    const effectiveBody = await resolvePreferencesPatch(user.id, rawBody, {
      feature: async (uid) => {
        const norm = normalizeAutoDreamPreferencePatch(rawBody);
        cachedAutoDream = await getAutoDreamFeature(
          uid,
          norm.auto_dream_enabled === true,
          norm.auto_optimizer_enabled === true,
        );
        return cachedAutoDream;
      },
    });
    const snap = await patchPreferences(user.id, effectiveBody);
    const snapLegacy = snap.prefs.auto_dream_enabled === true;
    const snapOpt = snap.prefs.auto_optimizer_enabled === true;
    const reuseAutoDream =
      cachedAutoDream !== undefined &&
      cachedAutoDream.legacy_enabled === snapLegacy &&
      cachedAutoDream.optimizer_enabled === snapOpt;
    const [autoDream, promptPrivacy] = await Promise.all([
      reuseAutoDream
        ? Promise.resolve(cachedAutoDream!)
        : getAutoDreamFeature(user.id, snapLegacy, snapOpt),
      cachedPromptPrivacy ? Promise.resolve(cachedPromptPrivacy) : resolvePromptPrivacySafe(deps, user.id),
    ]);
    sendJson(res, 200, {
      ...snap,
      features: {
        auto_dream: autoDream,
        intelligent_ui: intelligentUiFeatureView(snap.prefs),
        input_prediction: inputPredictionFeatureView(snap.prefs),
        prompt_privacy: promptPrivacy,
      },
    });
  } catch (err) {
    if (err instanceof PreferencesError) {
      throw mapPreferencesError(err.code, err.message);
    }
    throw err;
  }
}

export async function serveGetMyQqBinding(
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const [{ getPool }, { readQqBotConfig }, { getQqBindingView }] = await Promise.all([
    import("../../db/index.js"),
    import("../../qqbot/config.js"),
    import("../../qqbot/store.js"),
  ]);
  const config = readQqBotConfig();
  if (!config) {
    sendJson(res, 200, { available: false, bound: false });
    return;
  }
  const view = await getQqBindingView(getPool(), user.id);
  sendJson(res, 200, {
    available: true,
    entry_url: config.entryUrl,
    ...view,
  });
}

export async function serveStartMyQqBinding(
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const [{ getPool }, { readQqBotConfig }, { createBindCode }] = await Promise.all([
    import("../../db/index.js"),
    import("../../qqbot/config.js"),
    import("../../qqbot/store.js"),
  ]);
  const config = readQqBotConfig();
  if (!config) {
    throw new HttpError(503, "QQ_BOT_UNAVAILABLE", "QQ Bot is not configured");
  }
  const token = await createBindCode(getPool(), user.id, config.bindingHmacSecret);
  sendJson(res, 200, {
    available: true,
    entry_url: config.entryUrl,
    bind_code: token.code,
    expires_at: token.expiresAt,
  });
}

export async function serveDeleteMyQqBinding(
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const [{ getPool }, { unbindQq }] = await Promise.all([
    import("../../db/index.js"),
    import("../../qqbot/store.js"),
  ]);
  const unbound = await unbindQq(getPool(), user.id);
  sendJson(res, 200, { ok: true, unbound });
}
