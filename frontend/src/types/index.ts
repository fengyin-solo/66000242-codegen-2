// OPC-UA 节点类型定义
export interface OPCUANode {
  id: string
  name: string
  nodeId: string
  type: 'Object' | 'Variable' | 'Method' | 'DataType'
  dataType?: string
  value?: any
  unit?: string
  quality?: 'Good' | 'Bad' | 'Uncertain'
  children?: OPCUANode[]
  description?: string
  browseName?: string
}

// 数据值模型
export interface DataValue {
  nodeId: string
  value: number | boolean | string
  quality: 'Good' | 'Bad' | 'Uncertain'
  timestamp: number
  sourceTimestamp?: number
  serverTimestamp?: number
}

// 报警事件
export interface AlarmEvent {
  id: string
  nodeId: string
  nodeName: string
  severity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info'
  message: string
  timestamp: number
  acknowledged: boolean
  value?: number | boolean | string
  threshold?: number
}

// 订阅配置
export interface SubscriptionConfig {
  nodeId: string
  publishingInterval: number
  samplingInterval: number
  queueSize: number
  discardOldest: boolean
  enabled: boolean
}

// 历史数据点（采样读数）
// value 为 null 表示该采样时刻数据源不可用（如断链/质量码 Bad），
// 不能当作 0 画到曲线上，而应标注为“无数据”。
export interface HistoryDataPoint {
  timestamp: number
  value: number | null
  quality: 'Good' | 'Bad' | 'Uncertain'
}

// 回看分析使用的采样点，与历史数据点同构，保证图与明细读同一份采样
export interface SamplePoint extends HistoryDataPoint {}

// 数据源断开区间
export interface DisconnectRange {
  start: number
  end: number | null
}

// 节点详情
export interface NodeDetail {
  node: OPCUANode
  currentValue?: DataValue
  history?: HistoryDataPoint[]
  subscriptions?: SubscriptionConfig[]
}
