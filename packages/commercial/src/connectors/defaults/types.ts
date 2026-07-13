/**
 * 默认连接器 seed 数据类型。spec=作者声明(ConnectorSpec);decision=reviewer 批准时的受众/effect
 * 结论(随附,seed 时用它编译签名)。featured/category 供市场展示。
 */

import type { ConnectorSpecT, SecurityDecisionT } from '../spec/types.js'

export interface DefaultConnector {
  featured: boolean
  category: string
  spec: ConnectorSpecT
  decision: SecurityDecisionT
}
