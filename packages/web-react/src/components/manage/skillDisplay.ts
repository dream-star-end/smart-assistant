/** 技能列表主标题 / 副标题：描述第一行作标题，slug 作 caption；无描述则回退 name。 */
export function skillDisplayTitle(skill: {
  name: string;
  description?: string | null;
}): { title: string; caption?: string } {
  const firstLine = (skill.description ?? "").split(/\r?\n/)[0].trim();
  if (!firstLine) return { title: skill.name };
  return { title: firstLine, caption: skill.name };
}

/**
 * 「密钥类」技能：持有 / 轮换 / 同步账号凭据的运维技能，不允许按项目单独启用
 * （项目专属技能一旦把它带进项目会话，就等于把凭据流程交给了项目里的任何人）。
 *
 * 判定口径（2026-09-15 指挥官拍板，前端先按规则判、后端 `sensitive:true` 记为需后端配合）：
 *  - 名称按 `-` / `_` 切段后含 key / secret / token / credential / password / account-pool 任一段
 *    （`account-pool` 是两段连读）；
 *  - 或 tags 含「密钥」「凭据」「secret」「credential」。
 * 改造前这里是三个写死的 slug，市场里新装一个「xxx-key-sync」就漏了。
 */
const SECRET_SEGMENTS = new Set(["key", "keys", "secret", "secrets", "token", "tokens", "credential", "credentials", "password", "passwords"]);
const SECRET_TAGS = new Set(["密钥", "凭据", "secret", "credential", "credentials"]);

export function isSecretSkill(skill: { name: string; tags?: string[] | null }): boolean {
  const segments = skill.name.toLowerCase().split(/[-_]/);
  if (segments.some((s) => SECRET_SEGMENTS.has(s))) return true;
  if (skill.name.toLowerCase().includes("account-pool")) return true;
  return (skill.tags ?? []).some((t) => SECRET_TAGS.has(t.trim().toLowerCase()));
}
