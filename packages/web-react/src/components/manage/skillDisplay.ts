/** 技能列表主标题 / 副标题：描述第一行作标题，slug 作 caption；无描述则回退 name。 */
export function skillDisplayTitle(skill: {
  name: string;
  description?: string | null;
}): { title: string; caption?: string } {
  const firstLine = (skill.description ?? "").split(/\r?\n/)[0].trim();
  if (!firstLine) return { title: skill.name };
  return { title: firstLine, caption: skill.name };
}
