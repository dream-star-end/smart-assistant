/**
 * 默认连接器 seed 数据类型。spec=作者声明(ConnectorSpec);decision=reviewer 批准时的受众/effect
 * 结论(随附,seed 时用它编译签名)。featured/category 供市场展示。
 */

import type { ConnectorSpecT, SecurityDecisionT } from '../spec/types.js'

export interface DefaultConnector {
  featured: boolean
  category: string
  /** 市场商品页的人向用例；seed 会幂等回填到当前官方版本。 */
  useCases: string[]
  /** 市场卡片标签；与可执行 spec 分离，不参与 spec hash。 */
  tags: string[]
  spec: ConnectorSpecT
  decision: SecurityDecisionT
}
