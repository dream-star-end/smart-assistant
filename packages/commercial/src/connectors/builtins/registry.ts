/**
 * 连接器平台 · builtin 白名单(RFC §5「builtin 层」切片②的最小实现,OCV5-402)。
 *
 * builtin 是**平台代码**实现的具名请求/结果变换,声明层只能按 id 引用,不能携带任何逻辑。
 * 本文件只放元数据(编译器用,零运行时依赖);实现在 `./runtime.ts`。
 *
 * 信任边界(三层,缺一不可):
 *   1. 编译期:id 必须在本表、类型对得上(requestTransform 只能引用 request 类)、契约的 apiOrigins
 *      必须 ⊆ 该 builtin 允许的 origin —— 一个 builtin 只为它写死的那个上游服务。
 *   2. 审核 / 载入期:用了任何 builtin 的契约只认平台官方工件的精确 hash
 *      (`official/index.ts` 的 `isOfficialConnectorArtifact`,同 PLATFORM_OAUTH_FORBIDDEN 的做法)。
 *   3. 社区发布管线(`publishConnectorPipeline.ts`)直接拒:`BUILTIN_PLATFORM_ONLY`。
 *
 * `operation` 仍然没有任何 builtin,一律 fail-closed。
 */

export type BuiltinKind = 'request' | 'result'

export interface BuiltinMeta {
  id: string
  kind: BuiltinKind
  /** 允许运行的 API origin(规范化形式 `https://host:443`)。契约 apiOrigins 必须是它的子集。 */
  origins: readonly string[]
  /** 给审核者看的一句话语义(AI 审查提示与权限摘要用)。 */
  summary: string
}

export const BILIBILI_API_ORIGIN = 'https://api.bilibili.com:443'

export const BUILTIN_REGISTRY: ReadonlyMap<string, BuiltinMeta> = new Map(
  (
    [
      {
        id: 'bilibili-wbi',
        kind: 'request',
        origins: [BILIBILI_API_ORIGIN],
        summary:
          '按 B 站 WBI 规则给 query 追加 wts 与 w_rid 签名,并带上平台匿名设备指纹 buvid3/buvid4 Cookie;' +
          '密钥与指纹由平台从同一 origin 的公开接口获取并缓存,不含任何用户凭据。',
      },
      {
        id: 'bilibili-dm-xml',
        kind: 'result',
        origins: [BILIBILI_API_ORIGIN],
        summary:
          '把 B 站弹幕接口返回的 deflate/gzip 压缩 XML 解压(有上限)并解析成 JSON 列表,' +
          '只取 <d p="…">文本</d> 条目,超过 200 条按时间均匀抽样。',
      },
    ] satisfies BuiltinMeta[]
  ).map((m) => [m.id, m]),
)

export function builtinMeta(id: string): BuiltinMeta | undefined {
  return BUILTIN_REGISTRY.get(id)
}
