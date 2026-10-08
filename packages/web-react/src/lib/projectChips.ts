/**
 * P5b：这条会话能不能出「记住这条 / 存为项目技能」。能出就返回目标看板 id，否则 null。
 * 条件：非 demo、看板功能在、服务端开关 OC_P5_CHIPS 打开、会话属于一个有看板的项目。
 * （流式中 / 只读 / 非末条回答由卡片自己判定。）
 */
export function projectChipsBoardId(opts: {
  demo: boolean;
  taskboardEnabled: boolean;
  chipsFlag: boolean;
  project: { boardProjectId?: string | null } | null | undefined;
}): string | null {
  if (opts.demo || !opts.taskboardEnabled || !opts.chipsFlag) return null;
  const id = opts.project?.boardProjectId?.trim();
  return id ? id : null;
}
