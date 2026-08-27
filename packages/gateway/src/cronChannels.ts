/**
 * Cron 送达通道的单一权威来源。
 *
 * `local` / `webchat` 是网关内建通道,恒合法、恒可用。其余值必须出现在
 * `Gateway.channels` 注册表(成功 init 的 ChannelAdapter.name)里,这样新 adapter
 * 接入后 API / 校验 / 前端选项自动出现,不再硬编码 telegram。
 *
 * 商业版与 selfhost 共用本模块:可用性只看注册表实况,不写死部署形态。
 */

export const BUILTIN_CRON_DELIVER_VALUES = ['local', 'webchat'] as const
export type BuiltinCronDeliverValue = (typeof BUILTIN_CRON_DELIVER_VALUES)[number]
/** 内建通道 + 已注册 adapter 名。string & {} 保留字面量补全。 */
export type CronDeliverValue = BuiltinCronDeliverValue | (string & {})

export interface CronChannelCapability {
  value: string
  available: boolean
}

export function isBuiltinCronDeliverValue(value: string): value is BuiltinCronDeliverValue {
  return value === 'local' || value === 'webchat'
}

/** addJob / updateJob 合法值:local / webchat / 当前已注册 adapter。 */
export function isAllowedCronDeliverValue(
  value: string,
  registeredAdapterNames: Iterable<string>,
): boolean {
  if (isBuiltinCronDeliverValue(value)) return true
  for (const name of registeredAdapterNames) {
    if (name === value) return true
  }
  return false
}

/**
 * GET /api/cron/channels 的载荷。webchat/local 恒 available;
 * 其余按注册表实况列出(未 init 成功的 adapter 不会出现)。
 */
export function listCronDeliverChannels(
  registeredAdapterNames: Iterable<string>,
): CronChannelCapability[] {
  const channels: CronChannelCapability[] = [
    { value: 'webchat', available: true },
    { value: 'local', available: true },
  ]
  const seen = new Set<string>(['webchat', 'local'])
  for (const name of registeredAdapterNames) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    channels.push({ value: name, available: true })
  }
  return channels
}
