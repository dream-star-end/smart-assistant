import { KNOWLEDGE_PLANET_PLUGIN_SLUG } from './knowledgePlanetContract.js'

export interface ManagedPluginWritePolicy {
  version: number
  disclaimerText: string
}

const KNOWLEDGE_PLANET_WRITE_POLICY: ManagedPluginWritePolicy = Object.freeze({
  version: 1,
  disclaimerText:
    '开启后，Plugin 可使用你当前登录的真实知识星球身份发布主题和评论，内容会对相应星球成员可见。你应自行确认内容真实、合法，并拥有所需权利，同时遵守知识星球及所在星球的规则，避免泄露隐私或机密信息。AI 可能理解或生成错误；开启开关只授予写能力，每一次发布或评论仍须由你在对话确认卡中单独确认。关闭后不会再启动新的写入；已经确认并进入发送阶段的操作仍可能完成。发送结果不明确时系统不会自动重试，请先到知识星球核实，避免重复发布。',
})

/** A managed-browser Plugin may expose writes only when the platform owns a current policy. */
export function managedPluginWritePolicy(slug: string): ManagedPluginWritePolicy | null {
  return slug === KNOWLEDGE_PLANET_PLUGIN_SLUG ? KNOWLEDGE_PLANET_WRITE_POLICY : null
}
