/**
 * 技能列表主标题 / 其余描述 / 副标题(slug)。
 *
 * 技能描述是写给模型看的触发句(「设计或核验 Claude Code 风格的顾问模式时使用。先核验官方机制，再……」),
 * 整句当标题时每行都是两行同色同字重的长句,282 条叠在一起就是运营说的「很拥挤」(10-09 22:18 截图)。
 * 这里取第一句(到第一个 。；！？ 或英文句点+空格)作短标题,并去掉句尾的「时使用 / 时调用」这类触发套话;
 * 其余部分作为灰色补充行。描述首行没有断句符时整行作标题、rest 为空(调用方单行截断)。
 * 无描述则回退 name。
 */
export function skillDisplayTitle(skill: {
  name: string;
  description?: string | null;
}): { title: string; caption?: string; rest?: string } {
  const lines = (skill.description ?? "").split(/\r?\n/);
  const firstLine = lines[0].trim();
  if (!firstLine) return { title: skill.name };
  const after = lines.slice(1).join(" ").trim();
  const m = /^(.+?)(?:[。；;！!？?]|\.(?=\s|$))\s*(.*)$/.exec(firstLine);
  let title = firstLine;
  let rest = after;
  if (m) {
    // 只去「时使用 / 的时候调用」这类触发套话;「检测工具调用」里的「调用」是正文,不能删(Codex r1)。
    const clause = m[1].replace(/(?:时|的时候)(?:使用|调用)$/, "").trim();
    // 去掉套话后太短(「使用时。」之类)就保留原句,不造出一个两字标题。
    title = clause.length >= 4 ? clause : m[1].trim();
    rest = [m[2].trim(), after].filter(Boolean).join(" ");
  }
  return { title, caption: skill.name, ...(rest ? { rest } : {}) };
}

/**
 * 技能正文里的人话名字:第一个一级标题(`# 顾问模式：参考核验与设计检查`)。
 * 描述是给模型看的触发句(「……时使用」),当标题用会在工作台头部铺满四行(运营 10-09 19:53 截图);
 * 正文的 H1 才是作者写给人看的名字。没有 H1 返回 null,调用方回退描述首行 / slug。
 */
export function skillHeading(body: string | null | undefined): string | null {
  // 当前所在围栏代码块的开栏字符与长度;围栏里的 `# Install dependencies` 是 shell 注释,不是标题(Codex r1/r2)。
  let fence: { ch: string; len: number } | null = null;
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (fence) {
      // 收栏:同一字符、不短于开栏、后面只能有空白。
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // 反引号围栏的 info 串里不能再有反引号(否则是行内代码)。
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { ch: open[1][0], len: open[1].length };
      continue;
    }
    // ATX 一级标题;收尾 # 必须与正文隔空格:`# C#` 的标题是「C#」,`# ###` 是空标题。
    const m = /^ {0,3}#(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (m) {
      const text = (m[1] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
      return text || null;
    }
  }
  return null;
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
