/** Stable in-memory comparison key for one Box account's egress binding. */
export function boxExecEgressBasis(input: {
  proxy: unknown
  proxyId: unknown
  hostUuid: unknown
  target: unknown
}): string {
  return JSON.stringify(input, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)
}
