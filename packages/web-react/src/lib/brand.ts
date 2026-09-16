/** 对外品牌单一权威。法定主体与产品品牌分离，展示面一律从这里取值。 */
export type Brand = {
  name: string
  nameEn: string
  tagline: string
  taglineEn: string
  slogan: string
  intro: string
  company: string
  companyShort: string
  /** 备案号。运营拿到真值前是占位文案；展示面（落地页页脚 / 设置关于页）只在含数字的真值时渲染。 */
  icp: string
  year: number
  /** 「联系合作」邮箱（landing L-02）。未填则落地页页脚不渲染该项；由运营提供后填入。 */
  contactEmail?: string
}

export const BRAND: Brand = {
  name: '从简',
  nameEn: 'Clarvy',
  tagline: '让复杂，从简。',
  taglineEn: 'From complex, to clear.',
  slogan: '让复杂，从简。',
  intro:
    '能思考、会执行、交付真实成果的全能 Agent 工作台。你只管说清目标，从简负责把过程推进到结果。',
  company: '江西启序智能科技有限公司',
  companyShort: '启序智能',
  icp: '备案信息更新中',
  year: 2026,
}
